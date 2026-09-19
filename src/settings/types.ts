// Plugin settings shape + defaults (persisted to data.json).

import type { OutputLanguage } from "../runtime/context";
import { BUILTIN_PRESETS, Preset } from "../runtime/presets";
import type { AgyModel } from "../runtime/protocol";

export type ToolAccess = "native" | "full";

export interface AntigravitySettings {
  /** Absolute path to agy. Empty -> auto-detect (well-known folders, then PATH). */
  cliPath: string;
  /** Default model slug for new tabs (D1: gemini-3.8-flash-high). */
  model: string;
  /** Language rule for replies. */
  outputLanguage: OutputLanguage;
  /**
   * native = agy's own permission rules (tools needing approval are soft-denied);
   * full   = adds --dangerously-skip-permissions to every session (D4: off).
   */
  toolAccess: ToolAccess;
  /** When sending the current note, include its full text (not just the path). */
  includeNoteContent: boolean;
  /** Kill a turn if agy prints nothing for this long (ms). */
  idleTimeoutMs: number;
  /** Maximum number of concurrent chat tabs (each is one agy process). */
  maxTabs: number;
  /** Your name, used to personalize the empty-chat greeting. Optional. */
  userName: string;
  /** Free-text instructions appended to every turn's app-context block. */
  customSystemPrompt: string;
  /** Include the built-in Markdown-formatting reminder. */
  markdownFormattingPromptEnabled: boolean;
  /** Article-toolkit presets (editable). */
  presets: Preset[];
  /** Last model list from `agy models` (for the pickers; refreshed on demand). */
  cachedModels: AgyModel[];
  /** Agent working folder relative to the vault root; empty = vault root. */
  workingFolder: string;
}

export const DEFAULT_SETTINGS: AntigravitySettings = {
  cliPath: "",
  model: "gemini-3.8-flash-high",
  outputLanguage: "auto",
  toolAccess: "native",
  includeNoteContent: true,
  idleTimeoutMs: 120000,
  maxTabs: 3,
  userName: "",
  customSystemPrompt: "",
  markdownFormattingPromptEnabled: true,
  presets: BUILTIN_PRESETS.map((p) => ({ ...p })),
  cachedModels: [],
  workingFolder: ""
};
