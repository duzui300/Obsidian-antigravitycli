// AgySession - one long-lived `agy` child process per chat tab.
//
// Speaks the headless stream-json protocol over stdin/stdout (see protocol.ts):
// the process is spawned once, then each user turn is one NDJSON line written
// to stdin and answered by a sequence of step_update lines ending in a result
// line. Stop kills the process tree; the caller keeps the conversation id and
// the next send() on a fresh session resumes it via --conversation.
//
// Only this file knows about child_process. The spawn and kill functions are
// injectable so the session is unit-tested against a fake child (see
// tests/agySession.test.mjs) without touching the real CLI.
//
// Timers: this module is pure Node (it also runs under `node --test` where
// there is no `window`), and its timers guard a child process rather than
// DOM work in a popout window, so the global timers are the correct choice.
/* eslint-disable obsidianmd/prefer-window-timers */

import { spawn as nodeSpawn } from "child_process";
import type { Readable, Writable } from "stream";
import {
  buildUserInputLine,
  classifyFailure,
  FailureCategory,
  parseAgyLine,
  ToolEvent,
  UsageInfo
} from "./protocol";

export interface SessionOptions {
  /** Absolute path to the agy executable. */
  cliPath: string;
  /** Working directory for the process (the vault root). */
  cwd: string;
  /** Model slug, e.g. "gemini-3.8-flash-high". Empty -> CLI default. */
  model: string;
  /** Resume this native conversation instead of starting a new one. */
  conversationId?: string;
  /** Extra directories granted to the agent (`--add-dir`, repeatable). */
  addDirs?: string[];
  /** Native execution mode (`--mode`). Empty -> CLI default. */
  mode?: "accept-edits" | "plan" | "";
  /** Adds --dangerously-skip-permissions ("Full access"). */
  skipPermissions?: boolean;
  /** Kill the turn if no stdout line arrives for this long. Default 120000. */
  idleTimeoutMs?: number;
  /** Time allowed for the process to print its init event. Default 30000. */
  spawnTimeoutMs?: number;
  /** Environment for the child. Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface TurnCallbacks {
  onChunk(text: string): void;
  onToolEvent?(event: ToolEvent): void;
  onUsage?(usage: UsageInfo): void;
  onError(message: string, category: FailureCategory): void;
  onDone(conversationId: string, response: string): void;
}

export interface ChatHandle {
  abort(): void;
}

export interface InitInfo {
  conversationId: string;
  model: string;
  cwd: string;
  permissionMode: string;
}

/** The subset of ChildProcess the session relies on (fakeable in tests). */
export interface ChildLike {
  pid?: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  stdio: ["pipe", "pipe", "pipe"];
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildLike;
export type KillTreeFn = (child: ChildLike) => void;

export interface SessionDeps {
  spawn?: SpawnFn;
  killTree?: KillTreeFn;
  platform?: string;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 120000;
export const DEFAULT_SPAWN_TIMEOUT_MS = 30000;
/** A single NDJSON line larger than this is treated as a protocol failure. */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** Only the tail of stderr is kept for diagnostics. */
export const MAX_STDERR_CHARS = 64 * 1024;
/** Grace period for a clean exit after stdin.end() before the tree is killed. */
const CLOSE_GRACE_MS = 1500;

/** Build the argv for a session (pure; exported for tests). */
export function buildSessionArgs(opts: SessionOptions): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  const model = (opts.model || "").trim();
  if (model) args.push("--model", model);
  for (const dir of opts.addDirs || []) {
    const d = (dir || "").trim();
    if (d) args.push("--add-dir", d);
  }
  if (opts.mode) args.push("--mode", opts.mode);
  const conv = (opts.conversationId || "").trim();
  if (conv) args.push("--conversation", conv);
  if (opts.skipPermissions) args.push("--dangerously-skip-permissions");
  return args;
}

/**
 * Kill the whole process tree. agy spawns helper children (a language server
 * and an updater), so on Windows a plain kill() would orphan them; taskkill /T
 * walks the tree. On POSIX SIGTERM to the parent is enough for agy's children.
 */
export function defaultKillTree(platform: string): KillTreeFn {
  return (child) => {
    if (!child.pid) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      return;
    }
    if (platform === "win32") {
      try {
        const killer = nodeSpawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.on("error", () => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        });
      } catch {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
}

interface ActiveTurn {
  cb: TurnCallbacks;
  idleTimer: ReturnType<typeof setTimeout> | null;
  emittedText: boolean;
  aborted: boolean;
}

export class AgySession {
  private readonly opts: SessionOptions;
  private readonly spawnFn: SpawnFn;
  private readonly killTreeFn: KillTreeFn;
  private proc: ChildLike | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private spawnError: Error | null = null;
  private pendingInit: {
    resolve: (info: InitInfo) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private turn: ActiveTurn | null = null;
  private closed = false;

  /** Native conversation id, known once the init event arrives. */
  conversationId: string | undefined;
  /** The last init event (model actually in use, permission mode). */
  initInfo: InitInfo | null = null;

  constructor(opts: SessionOptions, deps: SessionDeps = {}) {
    this.opts = opts;
    this.conversationId = (opts.conversationId || "").trim() || undefined;
    this.spawnFn = deps.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, o));
    this.killTreeFn = deps.killTree ?? defaultKillTree(deps.platform ?? process.platform);
  }

  /** True while the child is running and can accept a turn. */
  get alive(): boolean {
    return !!this.proc && !this.exitInfo && !this.spawnError && !this.closed;
  }

  /** True while a turn is streaming. */
  get busy(): boolean {
    return !!this.turn;
  }

  /** Last stderr output (tail), for diagnostics. */
  get stderrSnapshot(): string {
    return this.stderrTail.trim();
  }

  /** Spawn the process and wait for its init event. Rejects on failure. */
  start(): Promise<InitInfo> {
    if (this.proc) return Promise.reject(new Error("session already started"));
    const args = buildSessionArgs(this.opts);
    let child: ChildLike;
    try {
      child = this.spawnFn(this.opts.cliPath, args, {
        cwd: this.opts.cwd,
        env: this.opts.env ?? process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (e) {
      return Promise.reject(this.wrapSpawnError(e as Error));
    }
    this.proc = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    child.on("error", (err) => this.onProcessError(err));
    child.on("exit", (code, signal) => this.onExit(code, signal));
    child.stdin.on("error", () => {
      /* EPIPE after the process died is handled by the exit path */
    });

    return new Promise<InitInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInit = null;
        this.killTreeFn(child);
        reject(new Error(classifyFailure({ timedOut: true }).message));
      }, this.opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
      this.pendingInit = { resolve, reject, timer };
    });
  }

  /**
   * Send one user turn. Exactly one turn may be in flight. Throws if the
   * session is not alive or busy.
   */
  send(content: string, cb: TurnCallbacks): ChatHandle {
    if (!this.alive || !this.proc) throw new Error("Antigravity session is not running");
    if (this.turn) throw new Error("A response is already streaming in this session");
    const turn: ActiveTurn = { cb, idleTimer: null, emittedText: false, aborted: false };
    this.turn = turn;
    this.armIdleTimer();
    this.proc.stdin.write(buildUserInputLine(content), "utf8");
    return {
      abort: () => {
        if (this.turn !== turn) return;
        turn.aborted = true;
        this.clearIdleTimer();
        this.turn = null;
        this.stop();
      }
    };
  }

  /** Kill the process tree immediately. The conversation id is retained. */
  stop(): void {
    const child = this.proc;
    this.closed = true;
    this.clearIdleTimer();
    if (this.turn) {
      // Silent abort: the caller initiated this; no callbacks fire afterwards.
      this.turn.aborted = true;
      this.turn = null;
    }
    if (child && !this.exitInfo) this.killTreeFn(child);
  }

  /** Graceful shutdown: close stdin, give agy a moment to exit, then kill. */
  close(): Promise<void> {
    const child = this.proc;
    this.closed = true;
    this.clearIdleTimer();
    if (this.turn) {
      this.turn.aborted = true;
      this.turn = null;
    }
    if (!child || this.exitInfo) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(grace);
        resolve();
      };
      const grace = setTimeout(() => {
        this.killTreeFn(child);
        resolve();
      }, CLOSE_GRACE_MS);
      child.on("exit", done);
      try {
        child.stdin.end();
      } catch {
        this.killTreeFn(child);
        done();
      }
    });
  }

  // ---- internals ----

  private wrapSpawnError(err: Error): Error {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") {
      const info = classifyFailure({ notFound: true });
      const e = new Error(info.message);
      (e as Error & { category: FailureCategory }).category = info.category;
      return e;
    }
    return err;
  }

  private onProcessError(err: Error): void {
    this.spawnError = err;
    const wrapped = this.wrapSpawnError(err);
    if (this.pendingInit) {
      clearTimeout(this.pendingInit.timer);
      const p = this.pendingInit;
      this.pendingInit = null;
      p.reject(wrapped);
    }
    if (this.turn && !this.turn.aborted) {
      const turn = this.turn;
      this.turn = null;
      this.clearIdleTimer();
      const category = (wrapped as Error & { category?: FailureCategory }).category ?? "process";
      turn.cb.onError(wrapped.message, category);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitInfo = { code, signal };
    // Flush any partial last line (agy always newline-terminates, but be safe).
    if (this.stdoutBuffer.trim()) {
      const rest = this.stdoutBuffer;
      this.stdoutBuffer = "";
      this.handleLine(rest);
    }
    if (this.pendingInit) {
      clearTimeout(this.pendingInit.timer);
      const p = this.pendingInit;
      this.pendingInit = null;
      p.reject(new Error(classifyFailure({ exitCode: code, stderr: this.stderrTail }).message));
    }
    if (this.turn && !this.turn.aborted) {
      const turn = this.turn;
      this.turn = null;
      this.clearIdleTimer();
      const info = classifyFailure({ exitCode: code, stderr: this.stderrTail });
      turn.cb.onError(info.message, info.category);
    }
  }

  private onStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_CHARS);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      this.stdoutBuffer = "";
      this.failTurn("Antigravity sent a line larger than the 2 MB limit; the turn was stopped.", "process");
      this.stop();
      return;
    }
    let nl = this.stdoutBuffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      this.handleLine(line);
      nl = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    const ev = parseAgyLine(line);
    if (!ev || ev.kind === "ignored") return;
    this.armIdleTimer();

    if (ev.kind === "init") {
      if (this.conversationId && ev.conversationId && ev.conversationId !== this.conversationId) {
        const msg = "Antigravity returned a different conversation id; refusing to continue.";
        if (this.pendingInit) {
          clearTimeout(this.pendingInit.timer);
          const p = this.pendingInit;
          this.pendingInit = null;
          p.reject(new Error(msg));
        }
        this.failTurn(msg, "provider");
        this.stop();
        return;
      }
      if (ev.conversationId) this.conversationId = ev.conversationId;
      this.initInfo = {
        conversationId: ev.conversationId,
        model: ev.model,
        cwd: ev.cwd,
        permissionMode: ev.permissionMode
      };
      if (this.pendingInit) {
        clearTimeout(this.pendingInit.timer);
        const p = this.pendingInit;
        this.pendingInit = null;
        p.resolve(this.initInfo);
      }
      return;
    }

    const turn = this.turn;
    if (!turn || turn.aborted) return;

    if (ev.kind === "text") {
      if (ev.conversationId && !this.conversationId) this.conversationId = ev.conversationId;
      if (ev.text) {
        turn.emittedText = true;
        turn.cb.onChunk(ev.text);
      }
      if (ev.usage) turn.cb.onUsage?.(ev.usage);
      return;
    }

    if (ev.kind === "tool") {
      turn.cb.onToolEvent?.(ev.tool);
      return;
    }

    if (ev.kind === "result") {
      this.clearIdleTimer();
      this.turn = null;
      if (ev.conversationId) this.conversationId = ev.conversationId;
      if (ev.status === "SUCCESS") {
        if (!turn.emittedText && ev.response) turn.cb.onChunk(ev.response);
        turn.cb.onDone(this.conversationId || ev.conversationId, ev.response);
      } else {
        const info = classifyFailure({
          exitCode: 0,
          stderr: this.stderrTail,
          resultError: ev.error || `Antigravity status: ${ev.status}`
        });
        turn.cb.onError(info.message, info.category);
      }
    }
  }

  private failTurn(message: string, category: FailureCategory): void {
    const turn = this.turn;
    if (!turn || turn.aborted) return;
    this.clearIdleTimer();
    this.turn = null;
    turn.cb.onError(message, category);
  }

  private armIdleTimer(): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    turn.idleTimer = setTimeout(() => {
      turn.idleTimer = null;
      if (this.turn !== turn) return;
      const info = classifyFailure({ timedOut: true });
      this.turn = null;
      this.stop();
      turn.cb.onError(info.message, info.category);
    }, this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.turn?.idleTimer) {
      clearTimeout(this.turn.idleTimer);
      this.turn.idleTimer = null;
    }
  }
}
