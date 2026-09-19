// Build the text sent to agy for one turn: the user's message, optional note
// context, and a trailing application-context block.
//
// agy has no system-prompt flag in headless mode, so (like the reference
// claudian-antigravity fork) house instructions travel INSIDE the user
// message, in a clearly labelled block after the user's own text. Pure module,
// unit-tested in tests/context.test.mjs.

export interface NoteContext {
  notePath?: string;
  selection?: string;
  noteContent?: string;
}

export type OutputLanguage = "auto" | "zh-CN" | "en";

export interface AppContextOptions {
  /** Absolute vault root (or working folder). Empty -> omitted. */
  vaultPath: string;
  /** Language the reply must use. "auto" -> follow the source text. */
  outputLanguage: OutputLanguage;
  /** User-authored instructions appended last. */
  customPrompt?: string;
  /** Include the built-in Markdown-formatting reminder. Default true. */
  markdownReminder?: boolean;
  /** True when --dangerously-skip-permissions is in effect. */
  fullAccess?: boolean;
}

/** User text + XML-ish context tags (same shape as the hermes-agent plugin). */
export function buildPrompt(userText: string, ctx: NoteContext): string {
  const parts: string[] = [(userText || "").trim()];

  if (ctx.selection && ctx.selection.trim()) {
    parts.push(
      [
        "<editor_selection>",
        `<file_path>${ctx.notePath ?? ""}</file_path>`,
        "<selection>",
        ctx.selection,
        "</selection>",
        "</editor_selection>"
      ].join("\n")
    );
  }

  if (ctx.noteContent && ctx.noteContent.trim()) {
    parts.push(
      [
        "<current_note>",
        `<file_path>${ctx.notePath ?? ""}</file_path>`,
        "<content>",
        ctx.noteContent,
        "</content>",
        "</current_note>"
      ].join("\n")
    );
  } else if (ctx.notePath) {
    parts.push(`<current_note>${ctx.notePath}</current_note>`);
  }

  return parts.filter(Boolean).join("\n\n");
}

/** The reply-language rule for the app-context block. */
export function languageInstruction(lang: OutputLanguage): string {
  switch (lang) {
    case "zh-CN":
      return "Reply in Simplified Chinese unless the user explicitly asks for another language.";
    case "en":
      return "Reply in English unless the user explicitly asks for another language.";
    default:
      return "Reply in the same language as the user's message and the attached text (default to that language for summaries and rewrites).";
  }
}

/** Markdown-in-a-narrow-sidebar reminder (ported from hermes-agent). */
export function markdownFormattingInstructions(): string {
  return (
    "Your replies are rendered as Markdown inside a narrow Obsidian sidebar panel, " +
    "so formatting choices matter. Fence code with triple backticks and a language tag, " +
    'use "-" for bullet lists and "1." for ordered lists with a blank line before/after, ' +
    "use real Markdown tables instead of hand-aligned ASCII tables, wrap inline " +
    'code/identifiers/paths in single backticks, and keep headings to "##" or lower. ' +
    "Prefer short paragraphs and lists over long blocks of prose. Do not wrap the entire " +
    "reply in a code fence. When asked to summarize, translate, or rewrite attached text, " +
    "output only the requested result, without a preamble such as \"Here is the summary\"."
  );
}

/** Workspace + permission facts for the agent. */
export function workspaceInstructions(vaultPath: string, fullAccess: boolean): string {
  const v = (vaultPath || "").trim();
  const lines: string[] = [];
  if (v) {
    lines.push(
      `Current vault root: ${v}. This folder is the user's Obsidian vault and your working ` +
        `directory; resolve note paths inside it. Attached note/selection text (in ` +
        `<current_note> / <editor_selection> tags) is already the content to work on - ` +
        `do not re-read it from disk unless asked.`
    );
  }
  lines.push(
    "This turn runs through Antigravity headless mode inside Obsidian; interactive approvals are unavailable."
  );
  if (fullAccess) {
    lines.push(
      "Full tool access is enabled by the user: file and command tools are auto-approved. Use only what the task requires and report actual results."
    );
  } else {
    lines.push(
      "Native permission rules apply. For ordinary note tasks prefer the attached text; if a file or command operation is denied, say so plainly and do not retry it or claim it succeeded."
    );
  }
  return lines.join(" ");
}

/** The full application-context block body (without the wrapping tag). */
export function buildAppContext(opts: AppContextOptions): string {
  const parts: string[] = [];
  parts.push(workspaceInstructions(opts.vaultPath, !!opts.fullAccess));
  parts.push(languageInstruction(opts.outputLanguage));
  if (opts.markdownReminder !== false) parts.push(markdownFormattingInstructions());
  const custom = (opts.customPrompt || "").trim();
  if (custom) parts.push(custom);
  return parts.filter(Boolean).join("\n\n");
}

export const APP_CONTEXT_TAG = "antigravity_app_context";

/**
 * Final text for one turn: prompt (user text + context tags) followed by the
 * labelled app-context block. An empty app context yields the bare prompt.
 */
export function assembleTurn(userText: string, ctx: NoteContext, appContext: string): string {
  const prompt = buildPrompt(userText, ctx);
  const block = (appContext || "").trim();
  if (!block) return prompt;
  return `${prompt}\n\n<${APP_CONTEXT_TAG}>\n${block}\n</${APP_CONTEXT_TAG}>`;
}

/**
 * Strip the app-context block from a stored prompt so history previews and
 * restored bubbles do not show house instructions.
 */
export function stripAppContext(text: string): string {
  const re = new RegExp(`\\n*<${APP_CONTEXT_TAG}>[\\s\\S]*?</${APP_CONTEXT_TAG}>\\s*$`);
  return (text || "").replace(re, "");
}
