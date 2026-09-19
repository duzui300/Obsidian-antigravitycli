// Unit tests for the agy NDJSON protocol helpers (pure, no Node/Obsidian deps).
//
// Fixtures under tests/fixtures/ are verbatim captures from `agy` 1.2.7 on
// 2026-09-19 (see prd.md section 3.2), so a parser regression against the real
// wire format is caught here rather than in Obsidian.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseAgyLine,
  parseModelsOutput,
  buildUserInputLine,
  classifyFailure,
  toolPreview,
  humanizeModel
} from "./.build/protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8");
const lines = (name) => fixture(name).split(/\r?\n/).filter((l) => l.trim());

test("parseAgyLine returns null for blank or invalid JSON and never throws", () => {
  assert.equal(parseAgyLine(""), null);
  assert.equal(parseAgyLine("   "), null);
  assert.equal(parseAgyLine("not json"), null);
  assert.equal(parseAgyLine("[1,2]"), null);
});

test("parseAgyLine ignores unknown events instead of failing", () => {
  const ev = parseAgyLine('{"event":"something_new","payload":{}}');
  assert.equal(ev.kind, "ignored");
});

test("init event exposes conversation id, model, cwd and permission mode", () => {
  const ev = parseAgyLine(lines("two-turn.ndjson")[0]);
  assert.equal(ev.kind, "init");
  assert.equal(ev.conversationId, "0b10a5b5-cbbb-4ad1-beb2-3f47a3874593");
  assert.equal(ev.model, "gemini-3.8-flash-low");
  assert.ok(ev.cwd.includes("Obsidian-antigravitycli"));
  // This fixture ran WITHOUT --dangerously-skip-permissions (native rules).
  assert.equal(ev.permissionMode, "request-review");
  // The single-turn fixture ran WITH it.
  assert.equal(parseAgyLine(lines("single-turn.ndjson")[0]).permissionMode, "always-proceed");
});

test("init without a model field (no --model passed) still parses", () => {
  const ev = parseAgyLine(lines("single-turn.ndjson")[0]);
  assert.equal(ev.kind, "init");
  assert.equal(ev.model, "");
});

test("user_input and system_message steps are ignored", () => {
  const ev = parseAgyLine(lines("two-turn.ndjson")[1]);
  assert.equal(ev.kind, "ignored");
  const sys = parseAgyLine(
    '{"event":"step_update","step_update":{"conversation_id":"x","step_index":3,"state":"DONE","step_type":"system_message","duration_seconds":0.001}}'
  );
  assert.equal(sys.kind, "ignored");
});

test("ACTIVE agent_response step yields a text delta", () => {
  const ev = parseAgyLine(lines("two-turn.ndjson")[2]);
  assert.equal(ev.kind, "text");
  assert.equal(ev.text, "Artificial intelligence is changing the way we write.");
  assert.equal(ev.conversationId, "0b10a5b5-cbbb-4ad1-beb2-3f47a3874593");
});

test("DONE agent_response step yields both its trailing delta and per-turn usage", () => {
  const ev = parseAgyLine(lines("two-turn.ndjson")[3]);
  assert.equal(ev.kind, "text");
  assert.equal(ev.text, "\n");
  assert.deepEqual(ev.usage, {
    inputTokens: 11750,
    outputTokens: 9,
    thinkingTokens: 0,
    totalTokens: 11759
  });
});

test("DONE agent_response with usage but no text still reports usage", () => {
  // The tool-call fixture's first agent step is thinking-only (no text_delta).
  const ev = parseAgyLine(lines("tool-call.ndjson")[2]);
  assert.equal(ev.kind, "text");
  assert.equal(ev.text, "");
  assert.equal(ev.usage.outputTokens, 827);
});

test("tool steps map to running then completed ToolEvents with a parameter preview", () => {
  const running = parseAgyLine(lines("tool-call.ndjson")[3]);
  assert.equal(running.kind, "tool");
  assert.equal(running.tool.name, "run_command");
  assert.equal(running.tool.status, "running");
  assert.equal(running.tool.stepIndex, 2);
  assert.equal(running.tool.preview, 'CommandLine: "Get-ChildItem"');

  const done = parseAgyLine(lines("tool-call.ndjson")[4]);
  assert.equal(done.kind, "tool");
  assert.equal(done.tool.status, "completed");
  assert.equal(done.tool.stepIndex, 2);
});

test("tool step with an error object or ERROR state is failed", () => {
  const errState = parseAgyLine(
    '{"event":"step_update","step_update":{"conversation_id":"x","step_index":5,"state":"ERROR","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"C:/a.md"}}}}'
  );
  assert.equal(errState.tool.status, "failed");
  const errObj = parseAgyLine(
    '{"event":"step_update","step_update":{"conversation_id":"x","step_index":5,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{},"error":{"type":"denied","message":"permission denied"}}}}'
  );
  assert.equal(errObj.tool.status, "failed");
  assert.equal(errObj.tool.error, "permission denied");
});

test("result event carries status, per-turn response, cumulative usage and turn count", () => {
  const all = lines("two-turn.ndjson");
  const first = parseAgyLine(all[4]);
  assert.equal(first.kind, "result");
  assert.equal(first.status, "SUCCESS");
  assert.equal(first.response, "Artificial intelligence is changing the way we write.\n");
  assert.equal(first.numTurns, 1);
  assert.equal(first.error, "");

  const second = parseAgyLine(all[all.length - 1]);
  assert.equal(second.kind, "result");
  assert.equal(second.numTurns, 2);
  assert.equal(second.response, "ARTIFICIAL INTELLIGENCE IS CHANGING THE WAY WE WRITE.\n");
  // cumulative: bigger than the first turn's usage
  assert.ok(second.usage.inputTokens > first.usage.inputTokens);
});

test("result exposes structured_output when the session used --json-schema", () => {
  const ev = parseAgyLine(
    '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"{\\"tags\\":[\\"a\\"],\\"title\\":\\"T\\"}\\n","duration_seconds":4.2,"num_turns":2,"structured_output":{"tags":["a"],"title":"T"},"json_schema":{"type":"object"},"usage":{"input_tokens":1,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":2}}}'
  );
  assert.equal(ev.kind, "result");
  assert.deepEqual(ev.structured, { tags: ["a"], title: "T" });
  const plain = parseAgyLine(lines("single-turn.ndjson")[4]);
  assert.equal(plain.structured, undefined);
});

test("ERROR result surfaces the error string", () => {
  const ev = parseAgyLine(
    '{"event":"result","result":{"conversation_id":"e1","status":"ERROR","response":"","error":"stream input message is missing the \\"event\\" field","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}'
  );
  assert.equal(ev.kind, "result");
  assert.equal(ev.status, "ERROR");
  assert.match(ev.error, /missing the "event" field/);
});

test("a full single-turn fixture streams to exactly the result response", () => {
  let text = "";
  let result = null;
  for (const l of lines("single-turn.ndjson")) {
    const ev = parseAgyLine(l);
    if (ev.kind === "text") text += ev.text;
    if (ev.kind === "result") result = ev;
  }
  assert.equal(text, result.response);
});

test("parseModelsOutput parses tab-separated slug/label lines and skips the banner", () => {
  const out = parseModelsOutput(
    "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\nbad line without tab\n"
  );
  assert.deepEqual(out, [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" }
  ]);
});

test("parseModelsOutput de-duplicates ids and rejects unsafe slugs", () => {
  const out = parseModelsOutput("a-1\tA\na-1\tA again\nbad slug\tB\n--flag\tC\n");
  assert.deepEqual(out, [{ id: "a-1", label: "A" }]);
});

test("buildUserInputLine emits the documented stdin shape with a trailing newline", () => {
  const line = buildUserInputLine('say "hi"\nplease');
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1); // single line
  assert.deepEqual(JSON.parse(line), { event: "user", message: { content: 'say "hi"\nplease' } });
});

test("classifyFailure maps the known failure modes", () => {
  assert.equal(classifyFailure({ notFound: true }).category, "cli-not-found");
  assert.equal(classifyFailure({ timedOut: true }).category, "timeout");
  assert.equal(
    classifyFailure({ exitCode: 1, stderr: "error getting token source: You are not logged into Antigravity." }).category,
    "not-logged-in"
  );
  assert.equal(classifyFailure({ exitCode: 1, resultError: "invalid model selection: nope" }).category, "invalid-model");
  assert.equal(classifyFailure({ exitCode: 0, resultError: "something else" }).category, "provider");
  const proc = classifyFailure({ exitCode: 3, stderr: "boom" });
  assert.equal(proc.category, "process");
  assert.match(proc.message, /boom/);
});

test("toolPreview compacts parameters to a short single line", () => {
  assert.equal(toolPreview({ CommandLine: "ls -la" }), 'CommandLine: "ls -la"');
  assert.equal(toolPreview({}), "");
  assert.equal(toolPreview(undefined), "");
  const long = toolPreview({ AbsolutePath: "C:/" + "x".repeat(300) });
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith("..."));
});

test("humanizeModel produces a readable label from a slug", () => {
  assert.equal(humanizeModel("gemini-3.8-flash-high"), "Gemini 3.8 Flash (High)");
  assert.equal(humanizeModel("claude-opus-4-6-thinking"), "Claude Opus 4 6 Thinking");
  assert.equal(humanizeModel(""), "");
});
