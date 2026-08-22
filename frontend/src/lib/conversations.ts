import type { Conversation } from "./types";

const STORAGE_KEY = "axiom-ai-conversations";

export function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function loadConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Conversation[]) : [];
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
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
