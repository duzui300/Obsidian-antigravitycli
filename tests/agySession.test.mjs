// Unit tests for AgySession against a fake child process (no real agy).
//
// Bundled by `npm run build:test`; `child_process` stays a Node builtin import
// inside the bundle but is never invoked here because spawn/killTree are
// injected.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AgySession, buildSessionArgs } from "./.build/agySession.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.written = "";
    this.stdin.on("data", (c) => (this.written += c.toString()));
  }
  kill() {
    this.killed = true;
    return true;
  }
  /** Simulate agy printing one NDJSON line. */
  line(obj) {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }
  exit(code = 0) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

const CONV = "0b10a5b5-cbbb-4ad1-beb2-3f47a3874593";
const init = (extra = {}) => ({
  event: "init",
  conversation_id: CONV,
  init: { model: "gemini-3.8-flash-high", cwd: "C:\\vault", tools: [], permission_mode: "request-review", ...extra }
});
const step = (o) => ({ event: "step_update", step_update: { conversation_id: CONV, ...o } });
const result = (o) => ({
  event: "result",
  result: { conversation_id: CONV, status: "SUCCESS", response: "", error: "", num_turns: 1, ...o }
});

function makeSession(overrides = {}, deps = {}) {
  const child = new FakeChild();
  const spawnCalls = [];
  const killed = [];
  const session = new AgySession(
    {
      cliPath: "C:\\fake\\agy.exe",
      cwd: "C:\\vault",
      model: "gemini-3.8-flash-high",
      addDirs: ["C:\\vault"],
      mode: "accept-edits",
      idleTimeoutMs: 80,
      spawnTimeoutMs: 80,
      ...overrides
    },
    {
      spawn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        return child;
      },
      killTree: (c) => killed.push(c),
      platform: "win32",
      ...deps
    }
  );
  return { child, session, spawnCalls, killed };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("buildSessionArgs emits the documented flag set in order, never -p", () => {
  const args = buildSessionArgs({
    cliPath: "x",
    cwd: "y",
    model: "gemini-3.8-flash-high",
    addDirs: ["C:\\vault", ""],
    mode: "accept-edits",
    conversationId: "abc",
    skipPermissions: true
  });
  assert.deepEqual(args, [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    "gemini-3.8-flash-high",
    "--add-dir",
    "C:\\vault",
    "--mode",
    "accept-edits",
    "--conversation",
    "abc",
    "--dangerously-skip-permissions"
  ]);
  assert.ok(!args.includes("-p"));
  const minimal = buildSessionArgs({ cliPath: "x", cwd: "y", model: "" });
  assert.deepEqual(minimal, ["--input-format", "stream-json", "--output-format", "stream-json"]);
});

test("start spawns with cwd, windowsHide and piped stdio, then resolves on init", async () => {
  const { child, session, spawnCalls } = makeSession();
  const p = session.start();
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, "C:\\fake\\agy.exe");
  assert.equal(spawnCalls[0].opts.cwd, "C:\\vault");
  assert.equal(spawnCalls[0].opts.windowsHide, true);
  assert.deepEqual(spawnCalls[0].opts.stdio, ["pipe", "pipe", "pipe"]);
  child.line(init());
  const info = await p;
  assert.equal(info.conversationId, CONV);
  assert.equal(info.model, "gemini-3.8-flash-high");
  assert.equal(session.conversationId, CONV);
  assert.equal(session.alive, true);
});

test("start rejects with a timeout and kills the tree when init never arrives", async () => {
  const { session, killed } = makeSession({ spawnTimeoutMs: 30 });
  await assert.rejects(session.start(), /did not respond in time/);
  assert.equal(killed.length, 1);
});

test("start rejects with cli-not-found on ENOENT", async () => {
  const { child, session } = makeSession();
  const p = session.start();
  const err = new Error("spawn ENOENT");
  err.code = "ENOENT";
  child.emit("error", err);
  await assert.rejects(p, /was not found/);
  assert.equal(session.alive, false);
});

test("a turn writes one stdin line and streams text, usage, tools and done", async () => {
  const { child, session } = makeSession();
  const p = session.start();
  child.line(init());
  await p;

  const chunks = [];
  const tools = [];
  let usage = null;
  let done = null;
  session.send("Summarize this", {
    onChunk: (t) => chunks.push(t),
    onToolEvent: (e) => tools.push(e),
    onUsage: (u) => (usage = u),
    onError: (m) => assert.fail("unexpected error " + m),
    onDone: (id, response) => (done = { id, response })
  });
  await tick();
  assert.equal(child.written, '{"event":"user","message":{"content":"Summarize this"}}\n');
  assert.equal(session.busy, true);

  child.line(step({ step_index: 0, state: "DONE", step_type: "user_input" }));
  child.line(step({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "C:/vault/a.md" } } }));
  child.line(step({ step_index: 1, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "C:/vault/a.md" } } }));
  child.line(step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello " }));
  child.line(step({ step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "world\n", usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, total_tokens: 13 } }));
  child.line(result({ response: "Hello world\n" }));
  await tick();

  assert.deepEqual(chunks, ["Hello ", "world\n"]);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].status, "running");
  assert.equal(tools[1].status, "completed");
  assert.deepEqual(usage, { inputTokens: 10, outputTokens: 2, thinkingTokens: 1, totalTokens: 13 });
  assert.deepEqual(done, { id: CONV, response: "Hello world\n" });
  assert.equal(session.busy, false);
});

test("when no delta was streamed the result response is emitted as one chunk", async () => {
  const { child, session } = makeSession();
  const p = session.start();
  child.line(init());
  await p;
  const chunks = [];
  session.send("hi", { onChunk: (t) => chunks.push(t), onError: () => assert.fail("err"), onDone: () => {} });
  child.line(result({ response: "only in result" }));
  await tick();
  assert.deepEqual(chunks, ["only in result"]);
});

test("an ERROR result surfaces onError with the error text and frees the session", async () => {
  const { child, session } = makeSession();
  const p = session.start();
  child.line(init());
  await p;
  let err = null;
  session.send("hi", { onChunk: () => {}, onError: (m, c) => (err = { m, c }), onDone: () => assert.fail("done") });
  child.line(result({ status: "ERROR", error: "invalid model selection: nope" }));
  await tick();
  assert.equal(err.c, "invalid-model");
  assert.match(err.m, /invalid model selection/);
  assert.equal(session.busy, false);
  assert.equal(session.alive, true);
});

test("idle timeout kills the tree and reports a timeout error", async () => {
  const { child, session, killed } = makeSession({ idleTimeoutMs: 30 });
  const p = session.start();
  child.line(init());
  await p;
  let err = null;
  session.send("slow", { onChunk: () => {}, onError: (m, c) => (err = { m, c }), onDone: () => assert.fail("done") });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(err.c, "timeout");
  assert.equal(killed.length, 1);
  assert.equal(session.alive, false);
});

test("abort via the handle kills the tree and suppresses later callbacks", async () => {
  const { child, session, killed } = makeSession();
  const p = session.start();
  child.line(init());
  await p;
  const calls = [];
  const handle = session.send("go", {
    onChunk: (t) => calls.push(["chunk", t]),
    onError: (m) => calls.push(["error", m]),
    onDone: () => calls.push(["done"])
  });
  child.line(step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "partial" }));
  await tick();
  handle.abort();
  child.line(step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: " more" }));
  child.line(result({ response: "partial more" }));
  child.exit(1);
  await tick();
  assert.deepEqual(calls, [["chunk", "partial"]]);
  assert.equal(killed.length, 1);
  assert.equal(session.conversationId, CONV, "conversation id survives a stop for later resume");
});

test("process exit mid-turn reports stderr and exit code", async () => {
  const { child, session } = makeSession();
  const p = session.start();
  child.line(init());
  await p;
  let err = null;
  session.send("go", { onChunk: () => {}, onError: (m, c) => (err = { m, c }), onDone: () => assert.fail("done") });
  child.stderr.write("error getting token source: You are not logged into Antigravity.\n");
  await tick();
  child.exit(1);
  await tick();
  assert.equal(err.c, "not-logged-in");
  assert.equal(session.alive, false);
});

test("send throws when busy or when the session is not alive", async () => {
  const { child, session } = makeSession();
  assert.throws(() => session.send("x", { onChunk() {}, onError() {}, onDone() {} }), /not running/);
  const p = session.start();
  child.line(init());
  await p;
  session.send("x", { onChunk() {}, onError() {}, onDone() {} });
  assert.throws(() => session.send("y", { onChunk() {}, onError() {}, onDone() {} }), /already streaming/);
});

test("a resumed session refuses a different conversation id", async () => {
  const { child, session, killed } = makeSession({ conversationId: "expected-id" });
  const p = session.start();
  child.line({ ...init(), conversation_id: "other-id" });
  await assert.rejects(p, /different conversation id/);
  assert.equal(killed.length, 1);
});

test("close ends stdin and resolves on exit without killing", async () => {
  const { child, session, killed } = makeSession();
  const p = session.start();
  child.line(init());
  await p;
  let ended = false;
  child.stdin.on("finish", () => (ended = true));
  const closing = session.close();
  await tick();
  assert.equal(ended, true);
  child.exit(0);
  await closing;
  assert.equal(killed.length, 0);
  assert.equal(session.alive, false);
});

test("lines split across chunks are reassembled", async () => {
  const { child, session } = makeSession();
  const p = session.start();
  const full = JSON.stringify(init()) + "\n";
  child.stdout.write(full.slice(0, 20));
  await tick();
  child.stdout.write(full.slice(20));
  const info = await p;
  assert.equal(info.conversationId, CONV);
});
