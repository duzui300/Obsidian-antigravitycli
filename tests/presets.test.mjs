import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_PRESETS,
  DEFAULT_PRESET_ICON,
  normalizePresetIcon,
  normalizePresets,
  presetApplicable,
  presetIcon,
  presetTarget,
  presetInstruction,
  presetCommandId,
  slugifyPresetId
} from "./.build/presets.mjs";

test("built-in presets are valid and have unique ids", () => {
  const ids = BUILTIN_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["summarize", "translate", "rewrite", "key-points", "title-tags"]);
  for (const p of BUILTIN_PRESETS) {
    assert.ok(p.name && p.instruction);
    assert.ok(["note", "selection", "either"].includes(p.appliesTo));
  }
});

test("normalizePresets returns fresh built-ins for a missing or corrupt value", () => {
  const a = normalizePresets(undefined);
  assert.deepEqual(a, BUILTIN_PRESETS);
  a[0].name = "mutated";
  assert.equal(BUILTIN_PRESETS[0].name, "Summarize", "built-ins are copied, not shared");
  assert.deepEqual(normalizePresets("junk"), BUILTIN_PRESETS);
});

test("normalizePresets keeps an intentionally empty list", () => {
  assert.deepEqual(normalizePresets([]), []);
});

test("normalizePresets drops invalid entries, defaults fields, slugifies and dedupes ids", () => {
  const out = normalizePresets([
    { name: "Polish", instruction: "Polish it." },
    { name: "Polish", instruction: "Again.", appliesTo: "selection", suggestedAction: "replace" },
    { id: "Bad Id!", name: "Weird", instruction: "x", appliesTo: "nope", suggestedAction: "nope" },
    { name: "", instruction: "no name" },
    { name: "no instruction" },
    "string",
    null
  ]);
  assert.deepEqual(
    out.map((p) => p.id),
    ["polish", "polish-2", "weird"]
  );
  assert.equal(out[0].appliesTo, "either");
  assert.equal(out[0].suggestedAction, "copy");
  assert.equal(out[1].appliesTo, "selection");
  assert.equal(out[1].suggestedAction, "replace");
  assert.equal(out[2].appliesTo, "either");
});

test("slugifyPresetId produces safe ids", () => {
  assert.equal(slugifyPresetId("Key points!"), "key-points");
  assert.equal(slugifyPresetId("   "), "preset");
  assert.ok(slugifyPresetId("x".repeat(100)).length <= 40);
});

test("presetApplicable and presetTarget follow appliesTo", () => {
  const sel = { ...BUILTIN_PRESETS[2] }; // rewrite: selection
  const note = { ...BUILTIN_PRESETS[4] }; // title-tags: note
  const either = { ...BUILTIN_PRESETS[0] }; // summarize: either

  assert.equal(presetApplicable(sel, false, true), false);
  assert.equal(presetApplicable(sel, true, false), true);
  assert.equal(presetApplicable(note, true, false), false);
  assert.equal(presetApplicable(either, false, false), false);
  assert.equal(presetApplicable(either, false, true), true);

  assert.equal(presetTarget(either, true, true), "selection", "selection wins when present");
  assert.equal(presetTarget(either, false, true), "note");
  assert.equal(presetTarget(sel, false, true), null);
  assert.equal(presetTarget(note, true, true), "note");
});

test("presetInstruction names the attached target", () => {
  const p = BUILTIN_PRESETS[0];
  assert.ok(presetInstruction(p, "selection").endsWith("(The attached text is the selected text.)"));
  assert.ok(presetInstruction(p, "note").startsWith(p.instruction));
});

test("the Title + tags built-in carries a valid schema and suggests frontmatter", () => {
  const p = BUILTIN_PRESETS.find((x) => x.id === "title-tags");
  assert.equal(p.suggestedAction, "frontmatter");
  const schema = JSON.parse(p.outputSchema);
  assert.deepEqual(schema.required, ["title", "tags"]);
});

test("normalizePresets validates outputSchema and demotes frontmatter without one", () => {
  const out = normalizePresets([
    { name: "A", instruction: "x", suggestedAction: "frontmatter", outputSchema: '{"type":"object"}' },
    { name: "B", instruction: "x", suggestedAction: "frontmatter" },
    { name: "C", instruction: "x", outputSchema: "not json" },
    { name: "D", instruction: "x", outputSchema: "[1,2]" }
  ]);
  assert.equal(out[0].suggestedAction, "frontmatter");
  assert.equal(out[0].outputSchema, '{"type":"object"}');
  assert.equal(out[1].suggestedAction, "copy");
  assert.equal("outputSchema" in out[1], false);
  assert.equal("outputSchema" in out[2], false);
  assert.equal("outputSchema" in out[3], false);
});

test("presetCommandId is prefixed", () => {
  assert.equal(presetCommandId(BUILTIN_PRESETS[1]), "preset-translate");
});

test("built-in presets each carry a distinct icon", () => {
  const icons = BUILTIN_PRESETS.map(presetIcon);
  assert.equal(icons.filter((i) => i === DEFAULT_PRESET_ICON).length, 0, "built-ins name their own icon");
  assert.equal(new Set(icons).size, icons.length);
});

test("presetIcon falls back for presets without a usable icon", () => {
  assert.equal(presetIcon({ name: "x", instruction: "y" }), DEFAULT_PRESET_ICON);
  assert.equal(presetIcon({ name: "x", instruction: "y", icon: "" }), DEFAULT_PRESET_ICON);
  assert.equal(presetIcon({ name: "x", instruction: "y", icon: "tags" }), "tags");
});

test("normalizePresetIcon keeps kebab-case names and drops junk", () => {
  assert.equal(normalizePresetIcon("Book-Open"), "book-open");
  assert.equal(normalizePresetIcon("  tags  "), "tags");
  assert.equal(normalizePresetIcon(""), undefined);
  assert.equal(normalizePresetIcon("has space"), undefined);
  assert.equal(normalizePresetIcon("<img src=x>"), undefined);
  assert.equal(normalizePresetIcon(42), undefined);
  assert.equal(normalizePresetIcon(null), undefined);
});

test("normalizePresets carries a valid icon through and omits an invalid one", () => {
  const out = normalizePresets([
    { name: "A", instruction: "x", icon: "book-open" },
    { name: "B", instruction: "x", icon: "not an icon" },
    { name: "C", instruction: "x" }
  ]);
  assert.equal(out[0].icon, "book-open");
  assert.equal("icon" in out[1], false);
  assert.equal("icon" in out[2], false);
});

