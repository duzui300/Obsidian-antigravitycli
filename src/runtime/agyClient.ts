// AgyClient - locates the agy executable, runs one-shot metadata commands
// (`agy --version`, `agy models`) and creates chat sessions.
//
// One-shot commands use execFile with a hard timeout and output cap; chat
// turns go through AgySession (a persistent stdin/stdout process per tab).

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cliBinaryNames, cliCandidates, splitPathList } from "./cliLocator";
import { AgyModel, classifyFailure, parseModelsOutput } from "./protocol";
import { AgySession, SessionOptions } from "./agySession";

export interface ClientSettings {
  cliPath: string;
  model: string;
  toolAccess: "native" | "full";
  idleTimeoutMs: number;
  workingFolder: string;
}

export interface TestResult {
  ok: boolean;
  detail: string;
  cliPath?: string;
  version?: string;
  models?: AgyModel[];
}

const ONE_SHOT_TIMEOUT_MS = 30000;
const ONE_SHOT_MAX_BUFFER = 2 * 1024 * 1024;

interface OneShotResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: NodeJS.ErrnoException;
}

function runOneShot(cli: string, args: string[], cwd: string, timeoutMs = ONE_SHOT_TIMEOUT_MS): Promise<OneShotResult> {
  return new Promise((resolve) => {
    execFile(
      cli,
      args,
      { cwd: cwd || undefined, windowsHide: true, timeout: timeoutMs, maxBuffer: ONE_SHOT_MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          code: err ? (typeof err.code === "number" ? err.code : null) : 0,
          ...(err ? { error: err } : {})
        });
      }
    );
  });
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export class AgyClient {
  private resolvedPath: { value: string | null; forSetting: string; at: number } | null = null;

  constructor(
    private readonly getSettings: () => ClientSettings,
    private readonly getVaultBasePath: () => string
  ) {}

  /**
   * Absolute path to agy: the configured path, then well-known install
   * locations, then a PATH scan. Cached for 60 s per configured value.
   */
  resolveCliPath(): string | null {
    const configured = (this.getSettings().cliPath || "").trim();
    const cached = this.resolvedPath;
    if (cached && cached.forSetting === configured && Date.now() - cached.at < 60000 && cached.value) {
      return cached.value;
    }
    const platform = process.platform;
    const env = process.env;
    let found: string | null = null;
    for (const candidate of cliCandidates(configured, env, platform, os.homedir())) {
      if (fileExists(candidate)) {
        found = candidate;
        break;
      }
    }
    if (!found) {
      const names = cliBinaryNames(platform);
      for (const dir of splitPathList(env.PATH || env.Path, platform)) {
        for (const name of names) {
          const p = path.join(dir, name);
          if (fileExists(p)) {
            found = p;
            break;
          }
        }
        if (found) break;
      }
    }
    this.resolvedPath = { value: found, forSetting: configured, at: Date.now() };
    return found;
  }

  /** Working directory for agy: the vault root (or configured sub-folder). */
  workingDir(): string {
    const base = (this.getVaultBasePath() || "").replace(/[\\/]+$/, "");
    const sub = (this.getSettings().workingFolder || "").trim();
    if (!sub) return base;
    if (path.isAbsolute(sub)) return sub;
    return base ? path.join(base, sub) : sub;
  }

  /** `agy models` -> parsed list. Throws with a user-facing message on failure. */
  async listModels(): Promise<AgyModel[]> {
    const cli = this.resolveCliPath();
    if (!cli) throw new Error(classifyFailure({ notFound: true }).message);
    const res = await runOneShot(cli, ["models"], this.workingDir());
    if (res.error && res.error.code === "ENOENT") throw new Error(classifyFailure({ notFound: true }).message);
    if (res.error && (res.error as { killed?: boolean }).killed) {
      throw new Error("Antigravity `agy models` timed out after 30 s. Is the CLI logged in and online?");
    }
    const models = parseModelsOutput(res.stdout);
    if (models.length === 0) {
      const info = classifyFailure({ exitCode: res.code ?? 1, stderr: res.stderr || res.stdout });
      throw new Error(info.message);
    }
    return models;
  }

  /** Probe the CLI: presence, version, login (via the model list). */
  async testCli(): Promise<TestResult> {
    const cli = this.resolveCliPath();
    if (!cli) {
      return { ok: false, detail: classifyFailure({ notFound: true }).message };
    }
    const ver = await runOneShot(cli, ["--version"], this.workingDir(), 15000);
    if (ver.error && ver.error.code === "ENOENT") {
      return { ok: false, detail: classifyFailure({ notFound: true }).message, cliPath: cli };
    }
    const version = ver.stdout.trim().split(/\r?\n/)[0] || "";
    try {
      const models = await this.listModels();
      return {
        ok: true,
        detail: `Antigravity CLI ${version || "(unknown version)"} at ${cli}. ${models.length} model(s) available.`,
        cliPath: cli,
        version,
        models
      };
    } catch (e) {
      return {
        ok: false,
        detail: `Antigravity CLI ${version || ""} found at ${cli}, but listing models failed: ${(e as Error).message}`,
        cliPath: cli,
        version
      };
    }
  }

  /** Build a session for one chat tab (not started). */
  createSession(model: string, conversationId?: string): AgySession {
    const cli = this.resolveCliPath();
    if (!cli) throw new Error(classifyFailure({ notFound: true }).message);
    const s = this.getSettings();
    const cwd = this.workingDir();
    const opts: SessionOptions = {
      cliPath: cli,
      cwd,
      model: (model || s.model || "").trim(),
      addDirs: cwd ? [cwd] : [],
      mode: "accept-edits",
      skipPermissions: s.toolAccess === "full",
      idleTimeoutMs: s.idleTimeoutMs > 0 ? s.idleTimeoutMs : undefined,
      ...(conversationId ? { conversationId } : {})
    };
    return new AgySession(opts);
  }
}
