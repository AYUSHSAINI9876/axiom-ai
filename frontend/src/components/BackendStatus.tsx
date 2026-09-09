"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";

type State = "checking" | "online" | "offline";

/**
 * Tells a signed-out visitor whether the backend is actually reachable.
 *
 * Without this the sign-in page looks completely healthy while the gateway is
 * down, and the only feedback is an error *after* filling in the form and
 * pressing the button — which reads as "the buttons don't work" rather than
 * "the server isn't running". This is the most common local-setup failure, so
 * it gets stated up front, with the command that fixes it.
 */
export default function BackendStatus() {
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        // The gateway's /health is public precisely so this works signed out.
        const res = await fetch(`${API_BASE}/health`, { cache: "no-store" });
        if (!cancelled) setState(res.ok ? "online" : "offline");
      } catch {
        if (!cancelled) setState("offline");
      }
    };

    check();
    // Keep checking so the banner clears on its own once the stack finishes
    // starting, instead of demanding a page reload.
    const interval = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (state !== "offline") return null;

  return (
    <div
      role="alert"
      className="animate-rise mb-6 rounded-xl border border-amber/40 bg-amber/10 p-3.5"
    >
      <p className="flex items-center gap-2 text-[13px] font-semibold text-amber">
        <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.71-3L13.71 4a2 2 0 00-3.42 0L3.36 16a2 2 0 001.71 3z"
          />
        </svg>
        Backend not reachable
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-fg-muted">
        Nothing will work until the API is running. Signing in and creating an
        account both need it.
      </p>
      <p className="mt-2 text-[12px] text-fg-muted">
        Start it with{" "}
        <code className="rounded bg-bg-sunken px-1.5 py-0.5 font-mono text-[11px]">
          docker compose up
        </code>{" "}
        in the project root, then this message disappears on its own.
      </p>
      <p className="mt-2 break-all text-[11px] text-fg-subtle">
        Expected at <span className="font-mono">{API_BASE}</span>
      </p>
    </div>
  );
}
