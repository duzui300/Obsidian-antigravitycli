import test from "node:test";
import assert from "node:assert/strict";
import {
  selectBatchNotes,
  normalizeTags,
  mergeFrontmatterFields,
  structuredToMarkdown,
  summarizeBatch
} from "./.build/batch.mjs";

const files = [
  { path: "Articles/a.md", extension: "md" },
  { path: "Articles/sub/b.md", extension: "md" },
  { path: "Articles/img.png", extension: "png" },
  { path: "Other/c.md", extension: "md" },
  { path: "root.md", extension: "md" }
];

test("selectBatchNotes picks direct .md children, or recursive, sorted", () => {
  assert.deepEqual(selectBatchNotes(files, "Articles", false).map((f) => f.path), ["Articles/a.md"]);
  assert.deepEqual(selectBatchNotes(files, "Articles/", true).map((f) => f.path), ["Articles/a.md", "Articles/sub/b.md"]);
  assert.deepEqual(selectBatchNotes(files, "/", false).map((f) => f.path), ["root.md"]);
  assert.deepEqual(selectBatchNotes(files, "", true).length, 4);
});

test("normalizeTags strips #, lowercases, hyphenates, dedupes, accepts strings", () => {
  assert.deepEqual(normalizeTags(["#Obsidian", " gemini ", "Cli Tools", "obsidian", "", 5, "#"]), ["obsidian", "gemini", "cli-tools"]);
  assert.deepEqual(normalizeTags("#a, b c"), ["a", "b", "c"]);
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags(["中文标签", "nested/tag"]), ["中文标签", "nested/tag"]);
});

test("mergeFrontmatterFields sets title, merges tags, adds other scalars only when absent", () => {
  const fm = { tags: "existing", author: "me" };
  const changed = mergeFrontmatterFields(fm, { title: " T ", tags: ["#New", "existing"], author: "model", summary: "s", nested: { x: 1 } });
  assert.deepEqual(changed, ["title", "tags", "summary"]);
  assert.equal(fm.title, "T");
  assert.deepEqual(fm.tags, ["existing", "new"]);
  assert.equal(fm.author, "me");
  assert.equal(fm.summary, "s");
  assert.equal("nested" in fm, false);
});

test("mergeFrontmatterFields reports no change when nothing differs", () => {
  const fm = { title: "T", tags: ["a"] };
  assert.deepEqual(mergeFrontmatterFields(fm, { title: "T", tags: ["#a"] }), []);
  assert.deepEqual(mergeFrontmatterFields(fm, "junk"), []);
});

test("structuredToMarkdown renders title, tags and extra fields", () => {
  const md = structuredToMarkdown({ title: "T", tags: ["#a", "b"], summary: "S", list: ["x", "y"], obj: { k: 1 } });
  assert.equal(md, "**Title:** T\n**Tags:** #a #b\n**summary:** S\n**list:** x, y\n**obj:** `{\"k\":1}`");
  assert.equal(structuredToMarkdown(null), "");
});

test("summarizeBatch counts statuses", () => {
  const items = [
    { path: "a", status: "done" },
    { path: "b", status: "done" },
    { path: "c", status: "error" },
    { path: "d", status: "skipped" },
    { path: "e", status: "cancelled" }
  ];
  assert.equal(summarizeBatch(items), "2 done, 1 failed, 1 skipped, 1 cancelled");
  assert.equal(summarizeBatch([{ path: "a", status: "done" }]), "1 done");
});
