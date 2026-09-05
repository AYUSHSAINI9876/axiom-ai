"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar, { initialsOf } from "./Sidebar";
import MessageBubble from "./MessageBubble";
import StatusIndicator from "./StatusIndicator";
import ThemeToggle from "./ThemeToggle";
import { streamChat } from "@/lib/api";
import { useAuth } from "@/context/AuthProvider";
import {
  createConversation,
  deleteConversation as removeConversation,
  generateId,
  loadConversations,
  saveConversations,
  sortByRecent,
  titleFromMessage,
  upsertConversation,
} from "@/lib/conversations";
import type { Citation, Conversation, Message } from "@/lib/types";

const EXAMPLE_PROMPTS = [
  {
    label: "Summarize the corpus",
    prompt: "Summarize the key findings in the indexed documents.",
    accent: "violet",
    icon: "M4 6h16M4 12h16M4 18h7",
  },
  {
    label: "Explain a concept",
    prompt: "What does the Eyring equation describe?",
    accent: "cyan",
    icon: "M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z",
  },
  {
    label: "Walk through a procedure",
    prompt: "Explain the synthesis of catalyst C-104 step by step.",
    accent: "amber",
    icon: "M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.628.282a2 2 0 01-1.806 0l-.628-.282a6 6 0 00-3.86-.517l-2.387.477a2 2 0 00-1.022.547",
  },
];

const ACCENT_CLASSES: Record<string, string> = {
  violet: "bg-violet/12 text-violet group-hover:bg-violet/20",
  cyan: "bg-cyan/12 text-cyan group-hover:bg-cyan/20",
  amber: "bg-amber/12 text-amber group-hover:bg-amber/20",
};

export default function ChatApp() {
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [documentsVersion, setDocumentsVersion] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Deliberately not a lazy useState initializer: this reads localStorage,
    // which is unavailable during SSR. Starting from empty state and loading
    // here keeps the client's first render identical to the server's,
    // avoiding a hydration mismatch; the real data lands on the next render.
    //
    // Keyed on userId so switching accounts swaps the whole sidebar rather
    // than showing the previous account's conversations.
    const stored = sortByRecent(loadConversations(userId));
    if (stored.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above
      setConversations(stored);
      setActiveId(stored[0].id);
    } else {
      const fresh = createConversation();
      setConversations([fresh]);
      setActiveId(fresh.id);
    }
  }, [userId]);

  useEffect(() => {
    if (conversations.length === 0) return;
    const timeout = setTimeout(() => saveConversations(userId, conversations), 300);
    return () => clearTimeout(timeout);
  }, [conversations, userId]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  );
  const messages = useMemo(() => activeConversation?.messages ?? [], [activeConversation]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

  // Grow the composer with its content, up to a cap, then scroll inside it.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const handleNewChat = () => {
    const fresh = createConversation();
    setConversations((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    setIsSidebarOpen(false);
  };

  const handleSelect = (id: string) => {
    setActiveId(id);
    setIsSidebarOpen(false);
  };

  const handleDelete = (id: string) => {
    const next = removeConversation(conversations, id);
    if (next.length === 0) {
      const fresh = createConversation();
      setConversations([fresh]);
      setActiveId(fresh.id);
      return;
    }
    setConversations(next);
    if (id === activeId) setActiveId(next[0].id);
  };

  // Shared by both "send a new message" and "regenerate the last response":
  // both just differ in which messages count as history/base state, so this
  // is the single place that owns the streaming lifecycle.
  const runQuery = async (query: string, baseMessages: Message[]) => {
    if (!query.trim() || isStreaming || !activeConversation) return;

    const conversationId = activeConversation.id;
    const history = baseMessages.map((m) => ({ role: m.role, content: m.content }));

    // runQuery only ever runs from event handlers (submit/regenerate/example
    // prompts), never during render, so timestamping here is safe even though
    // the linter's static analysis can't trace that through the call chain.
    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content: query,
      // eslint-disable-next-line react-hooks/purity -- see comment above
      createdAt: Date.now(),
    };
    const assistantMessage: Message = {
      id: generateId(),
      role: "assistant",
      content: "",
      // eslint-disable-next-line react-hooks/purity -- see comment above
      createdAt: Date.now(),
    };
    const isFirstMessage = baseMessages.length === 0;

    setConversations((prev) => {
      const conversation = prev.find((c) => c.id === conversationId);
      if (!conversation) return prev;
      return upsertConversation(prev, {
        ...conversation,
        title: isFirstMessage ? titleFromMessage(query) : conversation.title,
        messages: [...baseMessages, userMessage, assistantMessage],
        updatedAt: Date.now(),
      });
    });
    setInput("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const patchAssistant = (updater: (m: Message) => Message) => {
      setConversations((prev) => {
        const conversation = prev.find((c) => c.id === conversationId);
        if (!conversation) return prev;
        return upsertConversation(prev, {
          ...conversation,
          messages: conversation.messages.map((m) =>
            m.id === assistantMessage.id ? updater(m) : m
          ),
        });
      });
    };

    await streamChat(
      query,
      history,
      {
        onToken: (token) => patchAssistant((m) => ({ ...m, content: m.content + token })),
        onSources: (sources: Citation[]) => patchAssistant((m) => ({ ...m, citations: sources })),
        onDone: () => setIsStreaming(false),
        onError: (message) => {
          patchAssistant((m) => ({ ...m, content: m.content || message, isError: true }));
          setIsStreaming(false);
        },
      },
      controller.signal
    );

    setIsStreaming(false);
  };

  const send = (query: string) => runQuery(query, messages);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    send(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline. The composer is a textarea
    // so multi-line questions (pasted equations, code) stay readable.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setIsStreaming(false);
  };

  const handleRegenerate = () => {
    const lastUserIndex = [...messages].map((m) => m.role).lastIndexOf("user");
    if (lastUserIndex === -1) return;
    const lastUserMessage = messages[lastUserIndex];
    runQuery(lastUserMessage.content, messages.slice(0, lastUserIndex));
  };

  const initials = initialsOf(user?.name);
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? "";

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNewChat}
        onDelete={handleDelete}
        onDocumentsChanged={() => setDocumentsVersion((v) => v + 1)}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="focus-ring shrink-0 rounded-lg p-1.5 text-fg-muted transition-colors hover:text-fg md:hidden"
              onClick={() => setIsSidebarOpen(true)}
              aria-label="Open conversation list"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">
              {activeConversation?.title ?? "New chat"}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusIndicator key={documentsVersion} />
            <ThemeToggle />
          </div>
        </header>

        <div
          ref={scrollRef}
          className="scrollbar-thin flex-1 space-y-5 overflow-y-auto p-4 sm:p-6"
          role="log"
          aria-live="polite"
        >
          {messages.length === 0 && (
            <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center text-center">
              <span className="gradient-brand glow mb-5 flex h-14 w-14 items-center justify-center rounded-2xl">
                <svg
                  className="h-7 w-7 text-white"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 20 L12 4 L20 20" />
                  <path d="M8.2 14.4 H15.8" />
                </svg>
              </span>
              <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
                {firstName ? `Hello, ${firstName}.` : "Hello."}{" "}
                <span className="gradient-text">What are we researching?</span>
              </h2>
              <p className="mt-2 max-w-md text-sm text-fg-muted">
                Ask anything about your indexed documents, or add new ones from the
                sidebar. Answers stream in with citations you can open.
              </p>

              <div className="mt-7 grid w-full gap-2 sm:grid-cols-3">
                {EXAMPLE_PROMPTS.map((example) => (
                  <button
                    key={example.prompt}
                    type="button"
                    onClick={() => send(example.prompt)}
                    className="focus-ring group glass flex flex-col items-start gap-2 rounded-xl p-3 text-left transition-colors hover:border-border-strong"
                  >
                    <span
                      className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${ACCENT_CLASSES[example.accent]}`}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d={example.icon} />
                      </svg>
                    </span>
                    <span className="text-[12px] font-medium text-fg">{example.label}</span>
                    <span className="text-[11px] leading-snug text-fg-subtle">{example.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} userInitials={initials} />
          ))}

          {isStreaming && messages[messages.length - 1]?.content === "" && (
            <div className="flex gap-3">
              <span className="gradient-brand mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" aria-hidden="true">
                <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 20 L12 4 L20 20" />
                  <path d="M8.2 14.4 H15.8" />
                </svg>
              </span>
              <div className="glass flex items-center gap-1.5 rounded-2xl rounded-tl-sm px-4 py-3.5">
                <span className="h-2 w-2 animate-bounce rounded-full bg-violet" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-fuchsia [animation-delay:-0.15s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-cyan [animation-delay:-0.3s]" />
                <span className="sr-only">Axiom is composing an answer…</span>
              </div>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="border-t border-border px-4 py-3 sm:px-6 sm:py-4">
          <div className="mx-auto max-w-3xl">
            <div className="mb-1.5 flex h-5 items-center justify-between px-1">
              {!isStreaming && messages.some((m) => m.role === "user") && (
                <button
                  type="button"
                  onClick={handleRegenerate}
                  className="focus-ring flex items-center gap-1.5 rounded text-[11px] text-fg-subtle transition-colors hover:text-violet"
                >
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Regenerate
                </button>
              )}
              {isStreaming && (
                <button
                  type="button"
                  onClick={handleStop}
                  className="focus-ring ml-auto flex items-center gap-1.5 rounded text-[11px] text-rose transition-opacity hover:opacity-80"
                >
                  <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                  Stop generating
                </button>
              )}
            </div>

            <div className="glass focus-within:ring-2 focus-within:ring-[color:var(--ring)] relative flex items-end gap-2 rounded-2xl p-2 transition-shadow">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder="Query the corpus…  (Enter to send, Shift+Enter for a new line)"
                aria-label="Message"
                className="scrollbar-thin max-h-50 flex-1 resize-none bg-transparent px-2.5 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle"
              />
              <button
                type="submit"
                disabled={isStreaming || !input.trim()}
                aria-label="Send message"
                className="gradient-brand focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            <p className="mt-2 text-center text-[10px] uppercase tracking-widest text-fg-subtle">
              Hybrid RAG · Dense + BM25 fusion · Answers are grounded in your documents
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}
