// Pure helpers for batch runs and structured (frontmatter) results. No
// Obsidian imports; unit-tested in tests/batch.test.mjs.

export type BatchOutput = "append" | "new-note" | "frontmatter";

/** Minimal file shape so selection logic can be tested without TFile. */
export interface BatchCandidate {
  path: string;
  extension: string;
}

/** Notes above this many characters are skipped in a batch. */
export const BATCH_MAX_CHARS = 200000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Markdown notes under `folderPath` (recursive or direct children only), sorted by path. */
export function selectBatchNotes(files: BatchCandidate[], folderPath: string, recursive: boolean): BatchCandidate[] {
  const root = (folderPath || "").replace(/^\/+|\/+$/g, "");
  const prefix = root ? `${root}/` : "";
  const out = files.filter((f) => {
    if (f.extension !== "md") return false;
    if (!f.path.startsWith(prefix)) return false;
    const rest = f.path.slice(prefix.length);
    if (!rest) return false;
    return recursive || !rest.includes("/");
  });
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Normalize tag values from the model: strip a leading "#", trim, lowercase,
 * spaces -> "-", drop empties/invalid, dedupe (order kept).
 */
export function normalizeTags(raw: unknown): string[] {
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    if (typeof v !== "string") continue;
    const tag = v
      .trim()
      .replace(/^#+/, "")
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_\-/]/gu, "");
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Merge a structured result into a frontmatter object in place (the shape
 * Obsidian's processFrontMatter hands us). `title` overwrites; `tags` are
 * merged (existing first) and normalized; other string/number/boolean fields
 * are set only when absent. Returns the keys that changed.
 */
export function mergeFrontmatterFields(fm: Record<string, unknown>, structured: unknown): string[] {
  if (!isRecord(structured)) return [];
  const changed: string[] = [];

  if (typeof structured.title === "string" && structured.title.trim()) {
    const title = structured.title.trim();
    if (fm.title !== title) {
      fm.title = title;
      changed.push("title");
    }
  }

  if (structured.tags !== undefined) {
    const existing = normalizeTags(fm.tags);
    const incoming = normalizeTags(structured.tags);
    const merged = [...existing];
    for (const t of incoming) if (!merged.includes(t)) merged.push(t);
    if (merged.length !== existing.length || merged.some((t, i) => existing[i] !== t)) {
      fm.tags = merged;
      changed.push("tags");
    }
  }

  for (const [k, v] of Object.entries(structured)) {
    if (k === "title" || k === "tags") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) continue;
    if (fm[k] !== undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      fm[k] = v;
      changed.push(k);
    }
  }
  return changed;
}

/** Render a structured result as readable Markdown for the chat bubble. */
export function structuredToMarkdown(structured: unknown): string {
  if (!isRecord(structured)) return "";
  const lines: string[] = [];
  if (typeof structured.title === "string") lines.push(`**Title:** ${structured.title}`);
  if (structured.tags !== undefined) {
    const tags = normalizeTags(structured.tags);
    if (tags.length) lines.push(`**Tags:** ${tags.map((t) => `#${t}`).join(" ")}`);
  }
  for (const [k, v] of Object.entries(structured)) {
    if (k === "title" || k === "tags") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      lines.push(`**${k}:** ${String(v)}`);
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) {
      lines.push(`**${k}:** ${v.map(String).join(", ")}`);
    } else {
      lines.push(`**${k}:** \`${JSON.stringify(v)}\``);
    }
  }
  return lines.join("\n");
}

export type BatchItemStatus = "queued" | "running" | "done" | "skipped" | "error" | "cancelled";

export interface BatchItem {
  path: string;
  status: BatchItemStatus;
  detail?: string;
}

/** Summary line for a finished batch. */
export function summarizeBatch(items: BatchItem[]): string {
  const count = (s: BatchItemStatus) => items.filter((i) => i.status === s).length;
  const parts = [`${count("done")} done`];
  if (count("error")) parts.push(`${count("error")} failed`);
  if (count("skipped")) parts.push(`${count("skipped")} skipped`);
  if (count("cancelled")) parts.push(`${count("cancelled")} cancelled`);
  return parts.join(", ");
}
