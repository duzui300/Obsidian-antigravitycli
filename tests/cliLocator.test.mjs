import test from "node:test";
import assert from "node:assert/strict";
import { cliCandidates, splitPathList, cliBinaryNames } from "./.build/cliLocator.mjs";

test("cliCandidates puts the configured path first and dedupes case-insensitively", () => {
  const out = cliCandidates(
    "C:\\Users\\me\\AppData\\Local\\agy\\bin\\AGY.EXE",
    { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" },
    "win32",
    "C:\\Users\\me"
  );
  assert.equal(out[0], "C:\\Users\\me\\AppData\\Local\\agy\\bin\\AGY.EXE");
  assert.equal(out.filter((p) => p.toLowerCase().includes("appdata\\local\\agy")).length, 1);
});

test("cliCandidates on Windows derives the LOCALAPPDATA default", () => {
  const out = cliCandidates("", { USERPROFILE: "C:\\Users\\me" }, "win32", "C:\\Users\\me");
  assert.equal(out[0], "C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe");
  assert.ok(out.includes("C:\\Users\\me\\.local\\bin\\agy.exe"));
});

test("cliCandidates on POSIX lists home and system bins", () => {
  const out = cliCandidates("", { HOME: "/home/me" }, "linux", "/home/me");
  assert.deepEqual(out, ["/home/me/.local/bin/agy", "/usr/local/bin/agy", "/opt/homebrew/bin/agy"]);
});

test("cliCandidates ignores blank configured values", () => {
  const out = cliCandidates("   ", { HOME: "/h" }, "darwin", "/h");
  assert.equal(out[0], "/h/.local/bin/agy");
});

test("splitPathList uses the platform separator and drops empties", () => {
  assert.deepEqual(splitPathList("C:\\a;;C:\\b ;", "win32"), ["C:\\a", "C:\\b"]);
  assert.deepEqual(splitPathList("/a::/b", "linux"), ["/a", "/b"]);
  assert.deepEqual(splitPathList(undefined, "linux"), []);
});

test("cliBinaryNames is platform-specific", () => {
  assert.deepEqual(cliBinaryNames("win32"), ["agy.exe", "agy.cmd", "agy.bat"]);
  assert.deepEqual(cliBinaryNames("darwin"), ["agy"]);
});
