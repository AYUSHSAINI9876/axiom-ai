"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./Sidebar";
import MessageBubble from "./MessageBubble";
import StatusIndicator from "./StatusIndicator";
import { streamChat } from "@/lib/api";
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
  "Summarize the key findings in the indexed documents.",
  "What does the Eyring equation describe?",
  "Explain the synthesis of catalyst C-104 step by step.",
];

export default function ChatApp() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [documentsVersion, setDocumentsVersion] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Deliberately not a lazy useState initializer: this reads localStorage,
    // which is unavailable during SSR. Starting from empty state and loading
    // here keeps the client's first render identical to the server's,
    // avoiding a hydration mismatch; the real data lands on the next render.
    const stored = sortByRecent(loadConversations());
    if (stored.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above
      setConversations(stored);
      setActiveId(stored[0].id);
    } else {
      const fresh = createConversation();
      setConversations([fresh]);
      setActiveId(fresh.id);
    }
  }, []);

  useEffect(() => {
    if (conversations.length === 0) return;
    const timeout = setTimeout(() => saveConversations(conversations), 300);
    return () => clearTimeout(timeout);
  }, [conversations]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  );
  const messages = useMemo(
    () => activeConversation?.messages ?? [],
    [activeConversation]
  );

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

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

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-animate">
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

      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/20 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              className="md:hidden text-gray-300 hover:text-white shrink-0"
              onClick={() => setIsSidebarOpen(true)}
              aria-label="Open conversation list"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="w-9 h-9 bg-cyan-500 rounded-lg flex items-center justify-center glow shrink-0">
              <span className="text-white font-bold text-lg">A</span>
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-white tracking-tight leading-none truncate">
                AXIOM AI
              </h1>
              <p className="text-[10px] text-cyan-400 font-medium uppercase tracking-widest">
                Scientific RAG Engine
              </p>
            </div>
          </div>
          <StatusIndicator key={documentsVersion} />
        </header>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 scrollbar-hide"
          role="log"
          aria-live="polite"
        >
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-4">
              <div className="p-4 bg-white/5 rounded-full">
                <svg className="w-12 h-12 text-cyan-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.628.282a2 2 0 01-1.806 0l-.628-.282a6 6 0 00-3.86-.517l-2.387.477a2 2 0 00-1.022.547l-.34.34a2 2 0 000 2.828l1.245 1.245a2 2 0 002.828 0L14 14.828a2 2 0 012.828 0L19.428 15.428z"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-white">
                How can I assist your research today?
              </h2>
              <p className="text-gray-400 max-w-md">
                Ask complex questions about your indexed documents, or upload
                new ones from the sidebar.
              </p>
              <div className="flex flex-wrap justify-center gap-2 pt-2 max-w-lg">
                {EXAMPLE_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => send(prompt)}
                    className="text-xs text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-3 py-1.5 transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {isStreaming && messages[messages.length - 1]?.content === "" && (
            <div className="flex justify-start">
              <div className="bg-white/5 p-4 rounded-2xl rounded-tl-none border border-white/10 flex gap-1">
                <div className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <div className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
              </div>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="border-t border-white/10 bg-black/20 p-4 sm:p-6">
          <div className="flex items-center justify-between mb-2 px-1 h-4">
            {!isStreaming && messages.some((m) => m.role === "user") && (
              <button
                type="button"
                onClick={handleRegenerate}
                className="text-[11px] text-gray-400 hover:text-cyan-400 transition-colors"
              >
                Regenerate response
              </button>
            )}
            {isStreaming && (
              <button
                type="button"
                onClick={handleStop}
                className="text-[11px] text-red-400 hover:text-red-300 transition-colors ml-auto"
              >
                Stop generating
              </button>
            )}
          </div>
          <div className="relative flex items-center">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Query the scientific corpus..."
              aria-label="Message"
              className="w-full bg-white/5 border border-white/10 rounded-xl py-4 pl-6 pr-16 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 text-white placeholder-gray-500 transition-all"
            />
            <button
              type="submit"
              disabled={isStreaming || !input.trim()}
              aria-label="Send message"
              className="absolute right-3 p-2 bg-cyan-500 hover:bg-cyan-400 rounded-lg text-white transition-colors disabled:opacity-50"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          <p className="mt-3 text-[10px] text-center text-gray-500 uppercase tracking-widest">
            Powered by Axiom Hybrid RAG • Llama 3 • BGE Embeddings
          </p>
        </form>
      </div>
    </div>
  );
}
