"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "@/lib/types";

interface Props {
  message: Message;
}

export default function MessageBubble({ message }: Props) {
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
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} group`}>
      <div className="max-w-[85%] sm:max-w-[80%] flex flex-col">
        <div
          className={`p-4 rounded-2xl ${
            isUser
              ? "bg-cyan-600 text-white rounded-tr-none shadow-lg self-end"
              : message.isError
                ? "bg-red-500/10 text-red-200 border border-red-500/30 rounded-tl-none"
                : "bg-white/5 text-gray-200 border border-white/10 rounded-tl-none"
          }`}
        >
          {isUser ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {message.content}
            </p>
          ) : (
            <div className="axiom-prose text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content || " "}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {!isUser && message.content && (
          <div className="mt-1.5 flex items-center gap-3 px-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={handleCopy}
              className="text-[11px] text-gray-500 hover:text-cyan-400 transition-colors"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <span className="text-[11px] text-gray-600">
              {new Date(message.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        )}

        {!isUser && message.citations && message.citations.length > 0 && (
          <Citations citations={message.citations} />
        )}
      </div>
    </div>
  );
}

function Citations({
  citations,
}: {
  citations: NonNullable<Message["citations"]>;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {citations.map((citation, i) => (
        <div key={i} className="max-w-full">
          <button
            type="button"
            onClick={() => setExpanded(expanded === i ? null : i)}
            aria-expanded={expanded === i}
            className="flex items-center gap-1.5 text-[11px] bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-2.5 py-1 text-cyan-300 transition-colors"
          >
            <span className="font-mono">[{i + 1}]</span>
            <span className="truncate max-w-[160px]">
              {citation.file ?? "source"}
            </span>
          </button>
          {expanded === i && (
            <div className="mt-1.5 p-2.5 rounded-lg bg-black/30 border border-white/10 text-[11px] text-gray-400 leading-relaxed max-w-sm">
              {citation.text}
              {typeof citation.score === "number" && (
                <div className="mt-1 text-cyan-500/70">
                  relevance {citation.score.toFixed(3)}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
