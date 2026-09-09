"use client";

import { useEffect, useState } from "react";
import { fetchHealth, type HealthResult } from "@/lib/api";

const POLL_INTERVAL_MS = 15000;

export default function StatusIndicator() {
  const [health, setHealth] = useState<HealthResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const result = await fetchHealth();
      if (!cancelled) setHealth(result);
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const online = Boolean(health?.gatewayOnline && health?.mlServiceOnline);
  const state = !health ? "checking" : online ? "online" : "offline";

  const docs = health?.docCount ?? 0;
  const backend = health?.llmBackend === "groq" ? "Groq" : "Ollama";

  const label =
    state === "checking"
      ? "Checking connection…"
      : state === "online"
        ? `${docs} document${docs === 1 ? "" : "s"} · ${backend}`
        : !health?.gatewayOnline
          ? "Gateway offline"
          : "ML service warming up";

  const detail =
    state === "online"
      ? `${docs} document${docs === 1 ? "" : "s"} indexed · ${health?.llmModel ?? "model"} via ${backend} · ${health?.embeddingModel ?? "BGE"} embeddings`
      : label;

  const dotColor =
    state === "online" ? "bg-emerald" : state === "offline" ? "bg-rose" : "bg-amber";

  return (
    <div
      className="glass flex items-center gap-2 rounded-full py-1 pl-2.5 pr-3"
      title={detail}
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
        {state === "online" && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dotColor} opacity-60`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dotColor}`} />
      </span>
      <span className="max-w-36 truncate text-[11px] font-medium text-fg-muted sm:max-w-none">
        {label}
      </span>
      {/* The visible label is abbreviated to fit the header; the full detail
          only lives in the tooltip, which a screen reader won't read. */}
      <span className="sr-only">{detail}</span>
    </div>
  );
}
