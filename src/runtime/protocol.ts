// Pure protocol helpers for the Antigravity CLI (agy) headless wire format.
//
// Deliberately free of Node/Obsidian imports so they can be unit-tested in
// isolation (tests/protocol.test.mjs, fixtures captured from agy 1.2.7).
//
// Wire format recap (stream-json):
//   {"event":"init","conversation_id":"...","init":{model?,cwd,tools[],permission_mode}}
//   {"event":"step_update","step_update":{conversation_id,step_index,state,step_type,
//        text_delta?,tool_name?,tool_info?{name,parameters,output?,error?},usage?}}
//   {"event":"result","result":{conversation_id,status,response,error?,num_turns,usage}}
// Input (stdin): {"event":"user","message":{"content":"..."}}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

export interface ToolEvent {
  stepIndex: number;
  name: string;
  status: "running" | "completed" | "failed";
  preview?: string;
  output?: string;
  error?: string;
}

export interface AgyModel {
  id: string;
  label: string;
}

export type AgyEvent =
  | { kind: "init"; conversationId: string; model: string; cwd: string; permissionMode: string }
  | { kind: "text"; conversationId: string; text: string; usage?: UsageInfo }
  | { kind: "tool"; conversationId: string; tool: ToolEvent }
  | {
      kind: "result";
      conversationId: string;
      status: string;
      response: string;
      error: string;
      numTurns: number;
      usage?: UsageInfo;
    }
  | { kind: "ignored" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function usageFrom(v: unknown): UsageInfo | undefined {
  if (!isRecord(v)) return undefined;
  return {
    inputTokens: num(v.input_tokens),
    outputTokens: num(v.output_tokens),
    thinkingTokens: num(v.thinking_tokens),
    totalTokens: num(v.total_tokens)
  };
}

/** Compact one-line preview of a tool's parameters (for the tool card). */
export function toolPreview(params: unknown, max = 120): string {
  if (!isRecord(params)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    const val = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
    parts.push(`${k}: ${val}`);
  }
  const line = parts.join(", ").replace(/\s+/g, " ");
  if (line.length <= max) return line;
  return line.slice(0, max - 3) + "...";
}

/**
 * Parse one stdout line into a normalized event. Returns null for blank or
 * non-JSON lines, and `{kind:"ignored"}` for well-formed lines we do not
 * render (unknown events, user_input/system_message/checkpoint steps).
 */
export function parseAgyLine(line: string): AgyEvent | null {
  const trimmed = (line || "").trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const event = str(raw.event);

  if (event === "init") {
    const init = isRecord(raw.init) ? raw.init : {};
    return {
      kind: "init",
      conversationId: str(raw.conversation_id),
      model: str(init.model),
      cwd: str(init.cwd),
      permissionMode: str(init.permission_mode)
    };
  }

  if (event === "step_update") {
    const step = isRecord(raw.step_update) ? raw.step_update : {};
    const conversationId = str(step.conversation_id);
    const stepType = str(step.step_type);
    const state = str(step.state);

    if (stepType === "agent_response") {
      const usage = usageFrom(step.usage);
      return {
        kind: "text",
        conversationId,
        text: str(step.text_delta),
        ...(usage ? { usage } : {})
      };
    }

    if (stepType === "tool") {
      const info = isRecord(step.tool_info) ? step.tool_info : {};
      const errObj = isRecord(info.error) ? info.error : null;
      const errorMessage = errObj ? str(errObj.message) || str(errObj.type) : "";
      const failed = state === "ERROR" || !!errObj;
      const status: ToolEvent["status"] = failed ? "failed" : state === "DONE" ? "completed" : "running";
      const preview = toolPreview(info.parameters);
      const output = str(info.output);
      const tool: ToolEvent = {
        stepIndex: num(step.step_index),
        name: str(info.name) || str(step.tool_name) || "tool",
        status,
        ...(preview ? { preview } : {}),
        ...(output ? { output } : {}),
        ...(errorMessage ? { error: errorMessage } : {})
      };
      return { kind: "tool", conversationId, tool };
    }

    return { kind: "ignored" };
  }

  if (event === "result") {
    const res = isRecord(raw.result) ? raw.result : {};
    const usage = usageFrom(res.usage);
    return {
      kind: "result",
      conversationId: str(res.conversation_id),
      status: str(res.status),
      response: str(res.response),
      error: str(res.error),
      numTurns: num(res.num_turns),
      ...(usage ? { usage } : {})
    };
  }

  return { kind: "ignored" };
}

/** Model slugs we accept from `agy models` (same shape the reference fork validates). */
const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

/**
 * Parse `agy models` stdout: a "Fetching available models..." banner followed
 * by `<slug>\t<label>` lines. Lines without a tab are skipped; ids are unique.
 */
export function parseModelsOutput(text: string): AgyModel[] {
  const seen = new Map<string, AgyModel>();
  for (const rawLine of (text || "").split(/\r?\n/)) {
    const tab = rawLine.indexOf("\t");
    if (tab <= 0) continue;
    const id = rawLine.slice(0, tab).trim();
    const label = rawLine.slice(tab + 1).trim();
    if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.set(id, { id, label: label || id });
  }
  return [...seen.values()];
}

/** One NDJSON stdin line for a user turn (documented headless input shape). */
export function buildUserInputLine(content: string): string {
  return JSON.stringify({ event: "user", message: { content } }) + "\n";
}

export type FailureCategory =
  | "cli-not-found"
  | "not-logged-in"
  | "invalid-model"
  | "timeout"
  | "process"
  | "provider";

export interface FailureInfo {
  category: FailureCategory;
  message: string;
}

export interface FailureInput {
  exitCode?: number | null;
  stderr?: string;
  resultError?: string;
  timedOut?: boolean;
  notFound?: boolean;
}

/** Map raw process/result facts to a user-facing category + message. */
export function classifyFailure(input: FailureInput): FailureInfo {
  const stderr = (input.stderr || "").trim();
  const resultError = (input.resultError || "").trim();
  const combined = `${stderr}\n${resultError}`;

  if (input.notFound) {
    return {
      category: "cli-not-found",
      message: "Antigravity CLI (agy) was not found. Set the executable path in the plugin settings."
    };
  }
  if (input.timedOut) {
    return {
      category: "timeout",
      message: "Antigravity did not respond in time. The turn was stopped; try again or raise the idle timeout in settings."
    };
  }
  if (/not logged in/i.test(combined) || /login required/i.test(combined)) {
    return {
      category: "not-logged-in",
      message: "Antigravity CLI is not logged in. Run `agy` in a terminal and sign in, then retry."
    };
  }
  if (/invalid model/i.test(combined) || /unknown model/i.test(combined)) {
    return {
      category: "invalid-model",
      message: `Model rejected by Antigravity: ${resultError || stderr}. Pick another model in settings.`
    };
  }
  if (resultError) {
    return { category: "provider", message: `Antigravity error: ${resultError}` };
  }
  const code = input.exitCode;
  if (typeof code === "number" && code !== 0) {
    return {
      category: "process",
      message: `Antigravity exited with code ${code}${stderr ? `: ${stderr.slice(-600)}` : ""}`
    };
  }
  return { category: "process", message: stderr || "Antigravity ended without a result." };
}

/** "gemini-3.8-flash-high" -> "Gemini 3.8 Flash (High)". */
export function humanizeModel(id: string): string {
  const s = (id || "").trim();
  if (!s) return "";
  const parts = s.split(/[-_/]+/).filter(Boolean);
  if (parts.length === 0) return s;
  const efforts = new Set(["low", "medium", "high"]);
  const last = parts[parts.length - 1].toLowerCase();
  const effort = efforts.has(last) ? parts.pop() : "";
  const words = parts.map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)));
  const base = words.join(" ");
  if (!effort) return base;
  return `${base} (${effort.charAt(0).toUpperCase() + effort.slice(1)})`;
}
