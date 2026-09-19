// Article-toolkit presets: one-click instructions applied to the current note
// or selection. Pure module (no Obsidian imports), unit-tested in
// tests/presets.test.mjs. Users can edit the list in settings; this module
// validates whatever comes back from data.json.

export type PresetTarget = "note" | "selection" | "either";

/** What to do with the reply by default (the user can always pick another). */
export type ResultAction = "copy" | "insert" | "replace" | "append" | "new-note" | "frontmatter";

export interface Preset {
  /** Stable id, used for the command id and history. */
  id: string;
  /** Short label for buttons and the command palette. */
  name: string;
  /** The instruction sent as the user text (context is attached separately). */
  instruction: string;
  /** Which context the preset needs. */
  appliesTo: PresetTarget;
  /** Suggested result action, highlighted on the reply. */
  suggestedAction: ResultAction;
  /**
   * Optional JSON Schema (as a string). When set, the preset runs in a
   * dedicated `--json-schema` session and the reply is the parsed object
   * (title/tags/... fields) instead of free text.
   */
  outputSchema?: string;
}

/** Schema of the built-in Title + tags preset (kept small for the CLI argv). */
export const TITLE_TAGS_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    title: { type: "string", description: "A concise title, under 12 words" },
    tags: { type: "array", items: { type: "string" }, description: "3-5 lowercase, hyphenated tags" }
  },
  required: ["title", "tags"]
});

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: "summarize",
    name: "Summarize",
    instruction:
      "Summarize the attached text. Start with a one-sentence takeaway, then 3-7 bullet points covering the key arguments, facts, and conclusions. Keep names, numbers, and terms exact.",
    appliesTo: "either",
    suggestedAction: "append"
  },
  {
    id: "translate",
    name: "Translate",
    instruction:
      "Translate the attached text. If it is Chinese, translate into natural English; otherwise translate into Simplified Chinese. Preserve Markdown structure, headings, lists, links, and code. Output only the translation.",
    appliesTo: "either",
    suggestedAction: "replace"
  },
  {
    id: "rewrite",
    name: "Rewrite",
    instruction:
      "Rewrite the attached text to be clearer and more concise while keeping its meaning, tone, and all facts. Keep the same language and Markdown structure. Output only the rewritten text.",
    appliesTo: "selection",
    suggestedAction: "replace"
  },
  {
    id: "key-points",
    name: "Key points",
    instruction:
      "Extract the key points of the attached text as a Markdown bullet list (5-12 items). Each bullet is one self-contained fact or argument. Add a final 'Open questions' list if the text leaves anything unresolved.",
    appliesTo: "either",
    suggestedAction: "append"
  },
  {
    id: "title-tags",
    name: "Title + tags",
    instruction:
      "Propose a concise title (under 12 words) and 3-5 tags for the attached text. Tags are lowercase, hyphenated, and specific to the content. Return the structured result only.",
    appliesTo: "note",
    suggestedAction: "frontmatter",
    outputSchema: TITLE_TAGS_SCHEMA
  }
];

const TARGETS = new Set<PresetTarget>(["note", "selection", "either"]);
const ACTIONS = new Set<ResultAction>(["copy", "insert", "replace", "append", "new-note", "frontmatter"]);

/** A valid schema string is a JSON object; anything else is dropped. */
export function normalizeSchema(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? JSON.stringify(parsed) : undefined;
  } catch {
    return undefined;
  }
}
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A safe id from a display name ("Key points" -> "key-points"). */
export function slugifyPresetId(name: string): string {
  const slug = (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "preset";
}

/**
 * Validate a stored preset list. A non-array (missing/corrupt) value yields the
 * built-ins; an array is filtered to valid entries (may be empty if the user
 * removed everything). Ids are de-duplicated by suffixing "-2", "-3", ...
 */
export function normalizePresets(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) return BUILTIN_PRESETS.map((p) => ({ ...p }));
  const out: Preset[] = [];
  const ids = new Set<string>();
  for (const item of raw as unknown[]) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const instruction = typeof item.instruction === "string" ? item.instruction.trim() : "";
    if (!name || !instruction) continue;
    let id = typeof item.id === "string" && ID_RE.test(item.id) ? item.id : slugifyPresetId(name);
    if (ids.has(id)) {
      let n = 2;
      while (ids.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    ids.add(id);
    const appliesTo = TARGETS.has(item.appliesTo as PresetTarget) ? (item.appliesTo as PresetTarget) : "either";
    const outputSchema = normalizeSchema(item.outputSchema);
    let suggestedAction = ACTIONS.has(item.suggestedAction as ResultAction)
      ? (item.suggestedAction as ResultAction)
      : "copy";
    // "frontmatter" only makes sense for structured output.
    if (suggestedAction === "frontmatter" && !outputSchema) suggestedAction = "copy";
    out.push({ id, name, instruction, appliesTo, suggestedAction, ...(outputSchema ? { outputSchema } : {}) });
  }
  return out;
}

/** Can this preset run given what context is available right now? */
export function presetApplicable(preset: Preset, hasSelection: boolean, hasNote: boolean): boolean {
  switch (preset.appliesTo) {
    case "selection":
      return hasSelection;
    case "note":
      return hasNote;
    default:
      return hasSelection || hasNote;
  }
}

/**
 * Which context a preset should use for this run: the selection when the
 * preset accepts one and a selection exists, otherwise the note.
 */
export function presetTarget(preset: Preset, hasSelection: boolean, hasNote: boolean): "selection" | "note" | null {
  if (preset.appliesTo === "selection") return hasSelection ? "selection" : null;
  if (preset.appliesTo === "note") return hasNote ? "note" : null;
  if (hasSelection) return "selection";
  return hasNote ? "note" : null;
}

/** The user-visible text of a preset run (also what the chat bubble shows). */
export function presetInstruction(preset: Preset, target: "selection" | "note"): string {
  const where = target === "selection" ? "selected text" : "current note";
  return `${preset.instruction.trim()}\n\n(The attached text is the ${where}.)`;
}

/** Command-palette id for a preset. */
export function presetCommandId(preset: Preset): string {
  return `preset-${preset.id}`;
}
