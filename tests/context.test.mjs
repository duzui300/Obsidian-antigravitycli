import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  buildAppContext,
  assembleTurn,
  stripAppContext,
  languageInstruction,
  APP_CONTEXT_TAG
} from "./.build/context.mjs";

test("buildPrompt with no context returns the trimmed user text", () => {
  assert.equal(buildPrompt("  hello  ", {}), "hello");
});

test("buildPrompt appends a selection block with the file path", () => {
  const out = buildPrompt("translate", { notePath: "a/b.md", selection: "some text" });
  assert.match(out, /^translate\n\n<editor_selection>\n<file_path>a\/b.md<\/file_path>\n<selection>\nsome text\n<\/selection>\n<\/editor_selection>/);
  // With a path but no content, the note is referenced by path only.
  assert.ok(out.endsWith("</editor_selection>\n\n<current_note>a/b.md</current_note>"));
});

test("buildPrompt appends full note content, or only the path when content is absent", () => {
  const full = buildPrompt("summarize", { notePath: "n.md", noteContent: "# Title\nbody" });
  assert.ok(full.includes("<current_note>\n<file_path>n.md</file_path>\n<content>\n# Title\nbody\n</content>\n</current_note>"));
  const pathOnly = buildPrompt("summarize", { notePath: "n.md" });
  assert.ok(pathOnly.endsWith("<current_note>n.md</current_note>"));
});

test("buildPrompt ignores whitespace-only selection and content", () => {
  assert.equal(buildPrompt("x", { selection: "  \n", noteContent: " " }), "x");
});

test("languageInstruction covers the three modes", () => {
  assert.match(languageInstruction("zh-CN"), /Simplified Chinese/);
  assert.match(languageInstruction("en"), /English/);
  assert.match(languageInstruction("auto"), /same language/);
});

test("buildAppContext orders workspace, language, markdown reminder, custom prompt", () => {
  const out = buildAppContext({
    vaultPath: "C:\\vault",
    outputLanguage: "zh-CN",
    customPrompt: "  Always be brief.  ",
    fullAccess: false
  });
  const iVault = out.indexOf("Current vault root: C:\\vault");
  const iLang = out.indexOf("Simplified Chinese");
  const iMd = out.indexOf("rendered as Markdown");
  const iCustom = out.indexOf("Always be brief.");
  assert.ok(iVault >= 0 && iVault < iLang && iLang < iMd && iMd < iCustom);
  assert.match(out, /Native permission rules apply/);
  assert.ok(out.endsWith("Always be brief."));
});

test("buildAppContext reflects full access and can drop the markdown reminder", () => {
  const out = buildAppContext({ vaultPath: "", outputLanguage: "auto", markdownReminder: false, fullAccess: true });
  assert.match(out, /Full tool access is enabled/);
  assert.ok(!out.includes("rendered as Markdown"));
  assert.ok(!out.includes("Current vault root"));
});

test("assembleTurn wraps the app context in the labelled tag after the prompt", () => {
  const out = assembleTurn("hi", { selection: "s" }, "RULES");
  assert.ok(out.startsWith("hi\n\n<editor_selection>"));
  assert.ok(out.endsWith(`\n\n<${APP_CONTEXT_TAG}>\nRULES\n</${APP_CONTEXT_TAG}>`));
});

test("assembleTurn with an empty app context is just the prompt", () => {
  assert.equal(assembleTurn("hi", {}, "   "), "hi");
});

test("stripAppContext removes the trailing block and leaves everything else", () => {
  const full = assembleTurn("hi", { notePath: "n.md" }, "RULES\nmore");
  assert.equal(stripAppContext(full), "hi\n\n<current_note>n.md</current_note>");
  assert.equal(stripAppContext("no block here"), "no block here");
});
