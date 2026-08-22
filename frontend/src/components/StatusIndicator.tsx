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
  const label = !health
    ? "Checking connection…"
    : online
      ? `${health.docCount ?? 0} document${health.docCount === 1 ? "" : "s"} indexed • Llama 3 via ${
          health.llmBackend === "groq" ? "Groq" : "Ollama"
        }`
      : !health.gatewayOnline
        ? "Gateway offline"
        : "ML service offline";

  return (
    <div className="flex items-center gap-2" title={label}>
      <span
        className={`h-2 w-2 rounded-full shrink-0 ${
          online ? "bg-emerald-400 animate-pulse" : health ? "bg-red-400" : "bg-yellow-400"
        }`}
        aria-hidden="true"
      />
      <span className="text-[11px] text-gray-400 truncate max-w-[160px] sm:max-w-none">
        {label}
      </span>
    </div>
  );
}
