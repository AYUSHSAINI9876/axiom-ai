import type { Conversation } from "./types";

/**
 * Conversations are stored per user.
 *
 * Two people using the same browser must not see each other's chat history,
 * and signing out then in as someone else must not inherit the previous
 * account's sidebar — so the account id is part of the key rather than
 * something to remember to clear.
 */
function storageKey(userId: string): string {
  return `axiom-ai-conversations:${userId}`;
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function loadConversations(userId: string): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Conversation[]) : [];
  } catch {
    return [];
  }
}

export function saveConversations(userId: string, conversations: Conversation[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(conversations));
  } catch {
    // localStorage can throw (quota exceeded, private browsing). Losing
    // persistence is an acceptable degradation; the session keeps working.
  }
}

export function createConversation(): Conversation {
  const now = Date.now();
  return {
    id: generateId(),
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function titleFromMessage(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  if (!trimmed) return "New chat";
  return trimmed.length <= 48 ? trimmed : `${trimmed.slice(0, 48)}…`;
}

export function upsertConversation(
  conversations: Conversation[],
  updated: Conversation
): Conversation[] {
  const index = conversations.findIndex((c) => c.id === updated.id);
  if (index === -1) return [updated, ...conversations];
  const next = [...conversations];
  next[index] = updated;
  return next;
}

export function deleteConversation(
  conversations: Conversation[],
  id: string
): Conversation[] {
  return conversations.filter((c) => c.id !== id);
}

export function renameConversation(
  conversations: Conversation[],
  id: string,
  title: string
): Conversation[] {
  return conversations.map((c) =>
    c.id === id ? { ...c, title, updatedAt: Date.now() } : c
  );
}

export function sortByRecent(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}
