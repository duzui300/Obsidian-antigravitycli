// Pure helpers for the plugin's local chat-history store (ported from the
// hermes-agent plugin; the gateway session id became the agy conversation id).
//
// No Obsidian imports here, so these functions are unit-testable in isolation.
// The plugin persists conversations to a separate `history.json` in the plugin
// folder - deliberately NOT in data.json, so settings stay small and history
// can grow independently.

export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /**
   * UI-only fields for user messages that had a note/selection attached:
   * `display` is the short text actually typed (or the preset name), and
   * `attachments` is the raw attached text, shown as a collapsed chip.
   */
  display?: string;
  attachments?: { notePath?: string; noteContent?: string; selection?: string };
}

export interface Conversation {
  /** Stable id (the originating tab id, or a restored conversation's id). */
  id: string;
  /** Short single-line label derived from the first user message. */
  title: string;
  /** Native agy conversation id, so a restored chat resumes with --conversation. */
  conversationId?: string;
  /** Model slug used by this conversation (restored into the tab). */
  model?: string;
  /** Epoch ms of the last turn - used for ordering and the age label. */
  updatedAt: number;
  messages: StoredMessage[];
}

/** Max conversations retained on disk (oldest dropped beyond this). */
export const MAX_CONVERSATIONS = 100;

function displayText(m: StoredMessage): string {
  return m.display ?? m.content;
}

/** First non-empty user line, collapsed and trimmed to a short title. */
export function deriveTitle(messages: StoredMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && displayText(m).trim());
  const raw = displayText(firstUser ?? { role: "user", content: "" })
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "New chat";
  return raw.length > 60 ? raw.slice(0, 57) + "..." : raw;
}

/** A one-line preview of where the conversation left off, role-prefixed. */
export function lastMessagePreview(messages: StoredMessage[], max = 80): string {
  const visible = messages.filter((m) => m.role !== "system" && displayText(m).trim());
  if (visible.length < 2) return "";
  const last = visible[visible.length - 1];
  const who = last.role === "user" ? "You" : "Antigravity";
  const raw = displayText(last).replace(/\s+/g, " ").trim();
  const body = raw.length > max ? raw.slice(0, max - 3) + "..." : raw;
  return `${who}: ${body}`;
}

/** A compact label for a chat tab (ASCII-only ellipsis per project rules). */
export function tabLabel(title: string): string {
  const t = (title || "").trim();
  if (!t) return "Chat";
  return t.length > 20 ? t.slice(0, 18) + "..." : t;
}

/** Insert or replace a conversation by id, newest first, capped to `max`. */
export function upsertConversation(
  list: Conversation[],
  entry: Conversation,
  max: number = MAX_CONVERSATIONS
): Conversation[] {
  const rest = list.filter((c) => c.id !== entry.id);
  const next = [entry, ...rest];
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next.slice(0, Math.max(1, max));
}

/** Remove a conversation by id. */
export function removeConversation(list: Conversation[], id: string): Conversation[] {
  return list.filter((c) => c.id !== id);
}

/** Human-friendly age label given the current time (both epoch ms). */
export function relativeTime(nowMs: number, thenMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const VALID_ROLES = new Set(["user", "assistant", "system"]);

/** Parse the on-disk history file defensively (never throws). */
export function parseHistoryFile(text: string): Conversation[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  let rawArr: unknown[] = [];
  if (Array.isArray(data)) {
    rawArr = data as unknown[];
  } else if (isRecord(data) && Array.isArray(data.conversations)) {
    rawArr = data.conversations as unknown[];
  }

  const out: Conversation[] = [];
  for (const c of rawArr) {
    if (!isRecord(c) || typeof c.id !== "string" || !Array.isArray(c.messages)) continue;
    const messages: StoredMessage[] = [];
    for (const m of c.messages as unknown[]) {
      if (
        isRecord(m) &&
        typeof m.content === "string" &&
        typeof m.role === "string" &&
        VALID_ROLES.has(m.role)
      ) {
        const msg: StoredMessage = { role: m.role as StoredMessage["role"], content: m.content };
        if (typeof m.display === "string") msg.display = m.display;
        if (isRecord(m.attachments)) {
          const a = m.attachments;
          const attachments: StoredMessage["attachments"] = {};
          if (typeof a.notePath === "string") attachments.notePath = a.notePath;
          if (typeof a.noteContent === "string") attachments.noteContent = a.noteContent;
          if (typeof a.selection === "string") attachments.selection = a.selection;
          if (Object.keys(attachments).length > 0) msg.attachments = attachments;
        }
        messages.push(msg);
      }
    }
    const entry: Conversation = {
      id: c.id,
      title: typeof c.title === "string" ? c.title : deriveTitle(messages),
      updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
      messages
    };
    if (typeof c.conversationId === "string" && c.conversationId) entry.conversationId = c.conversationId;
    if (typeof c.model === "string" && c.model) entry.model = c.model;
    out.push(entry);
  }
  return out;
}

/** Serialize the store for disk (stable, human-readable). */
export function serializeHistoryFile(list: Conversation[]): string {
  return JSON.stringify({ version: 1, conversations: list }, null, 2);
}
