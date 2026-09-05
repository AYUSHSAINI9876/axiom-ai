"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "@/lib/types";

interface Props {
  message: Message;
  /** Initials shown in the user's avatar; falls back to a neutral glyph. */
  userInitials?: string;
}

export default function MessageBubble({ message, userInitials = "" }: Props) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (older browser / insecure context) — ignore.
    }
  };

  return (
    <div className={`animate-rise flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"} group`}>
      <Avatar isUser={isUser} initials={userInitials} isError={message.isError} />

      <div className={`flex min-w-0 max-w-[calc(100%-3.25rem)] flex-col sm:max-w-[80%] ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`w-fit max-w-full rounded-2xl px-4 py-3 ${
            isUser
              ? "gradient-brand rounded-tr-sm text-white shadow-md"
              : message.isError
                ? "rounded-tl-sm border border-rose/30 bg-rose/10 text-fg"
                : "glass rounded-tl-sm"
          }`}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
          ) : (
            <div className="axiom-prose text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || " "}</ReactMarkdown>
            </div>
          )}
        </div>

        {!isUser && message.content && (
          <div className="mt-1.5 flex items-center gap-3 px-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={handleCopy}
              className="focus-ring rounded text-[11px] text-fg-subtle transition-colors hover:text-violet"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <time className="text-[11px] text-fg-subtle" dateTime={new Date(message.createdAt).toISOString()}>
              {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </time>
          </div>
        )}

        {!isUser && message.citations && message.citations.length > 0 && (
          <Citations citations={message.citations} />
        )}
      </div>
    </div>
  );
}

function Avatar({ isUser, initials, isError }: { isUser: boolean; initials: string; isError?: boolean }) {
  if (isUser) {
    return (
      <span
        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-elevated text-[11px] font-semibold text-fg-muted"
        aria-hidden="true"
      >
        {initials || (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
            />
          </svg>
        )}
      </span>
    );
  }

  return (
    <span
      className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
        isError ? "bg-rose" : "gradient-brand"
      }`}
      aria-hidden="true"
    >
      <svg
        className="h-4 w-4 text-white"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {isError ? (
          <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        ) : (
          <>
            <path d="M4 20 L12 4 L20 20" />
            <path d="M8.2 14.4 H15.8" />
          </>
        )}
      </svg>
    </span>
  );
}

function Citations({ citations }: { citations: NonNullable<Message["citations"]> }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="mt-2 flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-widest text-fg-subtle">
          Sources
        </span>
        {citations.map((citation, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setExpanded(expanded === i ? null : i)}
            aria-expanded={expanded === i}
            className={`focus-ring flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              expanded === i
                ? "border-cyan/50 bg-cyan/15 text-cyan"
                : "border-border bg-surface text-fg-muted hover:border-cyan/40 hover:text-cyan"
            }`}
          >
            <span className="font-mono opacity-70">[{i + 1}]</span>
            <span className="truncate">{citation.file ?? "source"}</span>
            {typeof citation.score === "number" && (
              <span className="shrink-0 font-mono text-[10px] opacity-60">
                {citation.score.toFixed(2)}
              </span>
            )}
          </button>
        ))}
      </div>

      {expanded !== null && citations[expanded] && (
        <div className="animate-rise rounded-xl border border-cyan/25 bg-cyan/5 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-cyan">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            {citations[expanded].file ?? "source"}
          </p>
          <p className="text-[12px] leading-relaxed text-fg-muted">{citations[expanded].text}</p>
        </div>
      )}
    </div>
  );
}
