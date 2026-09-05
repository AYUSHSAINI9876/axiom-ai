"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

type ToastTone = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  notify: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside a <ToastProvider>");
  return context;
}

const TONE_STYLES: Record<ToastTone, { bar: string; icon: string }> = {
  success: { bar: "bg-emerald", icon: "M5 13l4 4L19 7" },
  error: { bar: "bg-rose", icon: "M6 18L18 6M6 6l12 12" },
  info: { bar: "bg-cyan", icon: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
};

let nextId = 0;

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, message, tone }]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss]
  );

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-live so a toast is announced without stealing focus. */}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="animate-rise glass pointer-events-auto flex items-start gap-3 overflow-hidden rounded-xl p-3 shadow-lg"
            style={{ boxShadow: "var(--shadow-lg)" }}
          >
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${TONE_STYLES[toast.tone].bar}`}
            >
              <svg
                className="h-3.5 w-3.5 text-on-accent"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d={TONE_STYLES[toast.tone].icon} />
              </svg>
            </span>
            <p className="flex-1 text-sm leading-snug text-fg">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="focus-ring shrink-0 rounded text-fg-subtle transition-colors hover:text-fg"
              aria-label="Dismiss notification"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
