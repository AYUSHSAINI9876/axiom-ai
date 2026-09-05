import { beforeEach, describe, expect, it } from "vitest";
import {
  createConversation,
  deleteConversation,
  loadConversations,
  renameConversation,
  saveConversations,
  sortByRecent,
  titleFromMessage,
  upsertConversation,
} from "./conversations";
import type { Conversation } from "./types";

beforeEach(() => {
  window.localStorage.clear();
});

describe("titleFromMessage", () => {
  it("returns the trimmed message when short", () => {
    expect(titleFromMessage("  Hello world  ")).toBe("Hello world");
  });

  it("falls back to 'New chat' for empty content", () => {
    expect(titleFromMessage("   ")).toBe("New chat");
  });

  it("truncates long messages with an ellipsis", () => {
    const long = "a".repeat(80);
    const title = titleFromMessage(long);
    expect(title.length).toBe(49); // 48 chars + ellipsis
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("conversation store", () => {
  const USER = "usr_alice";

  it("round-trips through localStorage", () => {
    const conversation = createConversation();
    saveConversations(USER, [conversation]);
    const loaded = loadConversations(USER);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(conversation.id);
  });

  it("returns an empty array when storage is empty or corrupt", () => {
    expect(loadConversations(USER)).toEqual([]);
    window.localStorage.setItem(`axiom-ai-conversations:${USER}`, "not json");
    expect(loadConversations(USER)).toEqual([]);
  });

  // Two accounts on one browser must not see each other's chat history, and
  // signing out then in as someone else must not inherit the previous
  // account's sidebar.
  it("keeps each user's conversations separate", () => {
    const alices = createConversation();
    const bobs = createConversation();
    saveConversations("usr_alice", [alices]);
    saveConversations("usr_bob", [bobs]);

    expect(loadConversations("usr_alice").map((c) => c.id)).toEqual([alices.id]);
    expect(loadConversations("usr_bob").map((c) => c.id)).toEqual([bobs.id]);
    expect(loadConversations("usr_carol")).toEqual([]);
  });

  it("upserts new conversations at the front and updates existing ones in place", () => {
    const a = createConversation();
    const b = createConversation();
    let list = upsertConversation([], a);
    list = upsertConversation(list, b);
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);

    list = upsertConversation(list, { ...a, title: "Renamed" });
    expect(list.find((c) => c.id === a.id)?.title).toBe("Renamed");
    expect(list).toHaveLength(2);
  });

  it("deletes a conversation by id", () => {
    const a = createConversation();
    const b = createConversation();
    expect(deleteConversation([a, b], a.id).map((c) => c.id)).toEqual([b.id]);
  });

  it("renames a conversation and bumps updatedAt", () => {
    const a = createConversation();
    const list = renameConversation([a], a.id, "New title");
    expect(list[0].title).toBe("New title");
    expect(list[0].updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
  });

  it("sorts conversations by most recently updated first", () => {
    const older: Conversation = { ...createConversation(), updatedAt: 100 };
    const newer: Conversation = { ...createConversation(), updatedAt: 200 };
    expect(sortByRecent([older, newer]).map((c) => c.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });
});
