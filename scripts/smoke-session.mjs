// Live smoke test for AgySession against the real `agy` CLI (opt-in, uses quota).
//
//   npm run build:test && npm run smoke [-- --model gemini-3.8-flash-low] [--stop]
//
// Runs a two-turn session, prints streamed text, closes the session, and on
// Windows checks that no agy.exe survived (the orphan-process risk R2 / P1).
// With --stop it aborts the first turn mid-stream instead, then resumes the
// same conversation in a fresh session (verifies stop + --conversation).

import { execFileSync } from "node:child_process";
import { AgySession } from "../tests/.build/agySession.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const cliPath = opt("--cli", process.platform === "win32" ? `${process.env.LOCALAPPDATA}\\agy\\bin\\agy.exe` : "agy");
const model = opt("--model", "gemini-3.8-flash-low");
const doStop = args.includes("--stop");
const cwd = process.cwd();

function agyProcesses() {
  if (process.platform !== "win32") return "(not checked on this platform)";
  const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq agy.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return out.split(/\r?\n/).filter((l) => l.includes("agy.exe")).length;
}

function runTurn(session, prompt, { abortAfterChars = 0 } = {}) {
  return new Promise((resolve) => {
    let text = "";
    const handle = session.send(prompt, {
      onChunk: (t) => {
        text += t;
        process.stdout.write(t);
        if (abortAfterChars && text.length >= abortAfterChars) {
          process.stdout.write("\n[abort]\n");
          handle.abort();
          resolve({ aborted: true, text });
        }
      },
      onToolEvent: (e) => process.stdout.write(`\n[tool ${e.name} ${e.status}] ${e.preview || ""}\n`),
      onUsage: (u) => process.stdout.write(`\n[usage in=${u.inputTokens} out=${u.outputTokens}]\n`),
      onError: (m, c) => {
        process.stdout.write(`\n[error ${c}] ${m}\n`);
        resolve({ error: m, text });
      },
      onDone: (id, response) => {
        process.stdout.write(`\n[done ${id}]\n`);
        resolve({ id, response, text });
      }
    });
  });
}

console.log(`agy.exe processes before: ${agyProcesses()}`);
const t0 = Date.now();
const session = new AgySession({ cliPath, cwd, model, addDirs: [cwd], mode: "accept-edits", idleTimeoutMs: 120000 });
const info = await session.start();
console.log(`init in ${Date.now() - t0} ms: conversation=${info.conversationId} model=${info.model} perms=${info.permissionMode}`);

if (doStop) {
  const r1 = await runTurn(session, "Count from 1 to 40, one number per line, slowly and with a short remark after each number.", { abortAfterChars: 40 });
  console.log(`first turn aborted=${!!r1.aborted}; alive=${session.alive}; conversationId=${session.conversationId}`);
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`agy.exe processes after stop: ${agyProcesses()}`);
  const resumed = new AgySession({ cliPath, cwd, model, addDirs: [cwd], mode: "accept-edits", conversationId: session.conversationId });
  const i2 = await resumed.start();
  console.log(`resumed conversation=${i2.conversationId}`);
  await runTurn(resumed, "In one short sentence, what was I asking you to do just now?");
  await resumed.close();
} else {
  await runTurn(session, "Reply with exactly the two words: hello world");
  await runTurn(session, "Now say the same two words in uppercase.");
  await session.close();
}

await new Promise((r) => setTimeout(r, 1500));
console.log(`agy.exe processes after close: ${agyProcesses()}`);
