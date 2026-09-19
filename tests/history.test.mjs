// Unit tests for the chat-history store helpers (pure, no Node/Obsidian deps).

import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTitle,
  lastMessagePreview,
  tabLabel,
  upsertConversation,
  removeConversation,
  relativeTime,
  parseHistoryFile,
  serializeHistoryFile,
  MAX_CONVERSATIONS
} from "./.build/history.mjs";

test("deriveTitle uses the first non-empty user message, collapsed and trimmed", () => {
  assert.equal(deriveTitle([{ role: "user", content: "  hello   world \n" }]), "hello world");
  assert.equal(
    deriveTitle([
      { role: "assistant", content: "hi there" },
      { role: "user", content: "what is the weather" }
    ]),
    "what is the weather"
  );
});

test("deriveTitle truncates long titles to 60 chars and falls back to 'New chat'", () => {
  const out = deriveTitle([{ role: "user", content: "a".repeat(80) }]);
  assert.equal(out.length, 60);
  assert.ok(out.endsWith("..."));
  assert.equal(deriveTitle([]), "New chat");
});

test("lastMessagePreview role-prefixes the final visible turn", () => {
  assert.equal(lastMessagePreview([{ role: "user", content: "only one" }]), "");
  assert.equal(
    lastMessagePreview([
      { role: "user", content: "q" },
      { role: "assistant", content: "  the   answer " }
    ]),
    "Antigravity: the answer"
  );
  assert.equal(
    lastMessagePreview([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "system", content: "ctx" }
    ]),
    "Antigravity: a"
  );
});

test("tabLabel shortens long titles", () => {
  assert.equal(tabLabel("short"), "short");
  assert.equal(tabLabel(""), "Chat");
  assert.equal(tabLabel("a".repeat(40)).length, 21);
});

test("upsertConversation sorts newest first, replaces by id, caps the list", () => {
  let list = [];
  list = upsertConversation(list, { id: "a", title: "A", updatedAt: 100, messages: [] });
  list = upsertConversation(list, { id: "b", title: "B", updatedAt: 200, messages: [] });
  assert.deepEqual(list.map((c) => c.id), ["b", "a"]);
  list = upsertConversation(list, { id: "a", title: "A2", updatedAt: 300, messages: [] });
  assert.equal(list.length, 2);
  assert.equal(list[0].title, "A2");
  for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
    list = upsertConversation(list, { id: `c${i}`, title: `C${i}`, updatedAt: 1000 + i, messages: [] });
  }
  assert.equal(list.length, MAX_CONVERSATIONS);
});

test("removeConversation drops the matching id only", () => {
  const out = removeConversation(
    [
      { id: "a", title: "A", updatedAt: 1, messages: [] },
      { id: "b", title: "B", updatedAt: 2, messages: [] }
    ],
    "a"
  );
  assert.deepEqual(out.map((c) => c.id), ["b"]);
});

test("relativeTime buckets", () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeTime(now, now - 10_000), "just now");
  assert.equal(relativeTime(now, now - 5 * 60_000), "5m ago");
  assert.equal(relativeTime(now, now - 3 * 3_600_000), "3h ago");
  assert.equal(relativeTime(now, now - 2 * 86_400_000), "2d ago");
});

test("parse/serialize round-trips conversations including conversationId and model", () => {
  const list = [
    {
      id: "a",
      title: "A",
      conversationId: "0b10a5b5-cbbb-4ad1-beb2-3f47a3874593",
      model: "gemini-3.8-flash-high",
      updatedAt: 123,
      messages: [
        { role: "user", content: "full prompt", display: "short", attachments: { notePath: "n.md", selection: "s" } },
        { role: "assistant", content: "hello" }
      ]
    }
  ];
  assert.deepEqual(parseHistoryFile(serializeHistoryFile(list)), list);
});

test("parseHistoryFile is defensive against junk and omits empty optional fields", () => {
  assert.deepEqual(parseHistoryFile("not json"), []);
  assert.deepEqual(parseHistoryFile("{}"), []);
  const out = parseHistoryFile(
    JSON.stringify({
      conversations: [
        { id: "ok", conversationId: "", messages: [{ role: "user", content: "x", attachments: { unrelated: true } }, { role: "user" }] },
        { messages: [] }
      ]
    })
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].messages.length, 1);
  assert.equal("conversationId" in out[0], false);
  assert.equal(out[0].messages[0].attachments, undefined);
  assert.equal(out[0].title, "x");
});
