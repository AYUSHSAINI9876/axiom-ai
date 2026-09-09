"use client";

import { useState } from "react";
import { useAuth } from "@/context/AuthProvider";
import { useToast } from "@/context/ToastProvider";
import BackendStatus from "./BackendStatus";
import Logo from "./Logo";
import ThemeToggle from "./ThemeToggle";

type Mode = "signin" | "signup";

const HIGHLIGHTS = [
  {
    accent: "var(--violet)",
    title: "Hybrid retrieval",
    body: "Dense vector search and BM25 keyword search, fused with reciprocal rank reranking.",
    icon: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
  },
  {
    accent: "var(--cyan)",
    title: "Grounded citations",
    body: "Every answer names the source chunks it was built from, with relevance scores.",
    icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  },
  {
    accent: "var(--amber)",
    title: "Your corpus, yours alone",
    body: "Documents are scoped to your account end to end — nobody else's text can reach your answers.",
    icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z",
  },
];

export default function AuthScreen() {
  const { signIn, signUp } = useAuth();
  const { notify } = useToast();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignUp = mode === "signup";

  const switchMode = () => {
    setMode(isSignUp ? "signin" : "signup");
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;

    setError(null);
    setBusy(true);
    try {
      if (isSignUp) {
        await signUp(email, name, password);
        notify(`Welcome to Axiom, ${name.split(" ")[0] || name}.`, "success");
      } else {
        await signIn(email, password);
        notify("Signed in.", "success");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col lg:flex-row">
      {/* ---- Brand panel. Hidden on small screens, where it would push the
           form below the fold for no informational gain. ---- */}
      <section className="gradient-brand animate-aurora relative hidden overflow-hidden lg:flex lg:w-[46%] lg:flex-col lg:justify-between lg:p-12">
        <div className="relative z-10 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20 backdrop-blur">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fff"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 20 L12 4 L20 20" />
              <path d="M8.2 14.4 H15.8" />
            </svg>
          </span>
          <div>
            <p className="text-lg font-bold leading-none tracking-tight text-white">AXIOM AI</p>
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-white/70">
              Scientific RAG Engine
            </p>
          </div>
        </div>

        <div className="relative z-10 max-w-md">
          <h2 className="text-3xl font-bold leading-tight tracking-tight text-white">
            Ask your own literature.
            <br />
            Get answers you can check.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-white/80">
            Axiom indexes your papers, specs and notes, then answers questions against
            them — streaming, cited, and grounded in the source text.
          </p>

          <ul className="mt-10 flex flex-col gap-5">
            {HIGHLIGHTS.map((item) => (
              <li key={item.title} className="flex gap-3.5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15 backdrop-blur">
                  <svg
                    className="h-4 w-4 text-white"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                  </svg>
                </span>
                <div>
                  <p className="text-sm font-semibold text-white">{item.title}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-white/70">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 text-[11px] text-white/60">
          Go gateway · FastAPI + LlamaIndex · Qdrant · Llama 3
        </p>
      </section>

      {/* ---- Form panel ---- */}
      <section className="flex flex-1 flex-col px-5 py-8 sm:px-10">
        <div className="flex items-center justify-between lg:justify-end">
          <div className="flex items-center gap-2.5 lg:hidden">
            <Logo size={32} />
            <span className="text-base font-bold tracking-tight">AXIOM AI</span>
          </div>
          <ThemeToggle />
        </div>

        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="text-2xl font-bold tracking-tight">
            {isSignUp ? "Create your account" : "Welcome back"}
          </h1>
          <p className="mt-1.5 text-sm text-fg-muted">
            {isSignUp
              ? "Your documents and conversations stay scoped to you."
              : "Sign in to reach your indexed corpus."}
          </p>

          <div className="mt-6">
            <BackendStatus />
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            {isSignUp && (
              <Field
                id="name"
                label="Name"
                type="text"
                value={name}
                onChange={setName}
                autoComplete="name"
                placeholder="Ada Lovelace"
                required
              />
            )}

            <Field
              id="email"
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              placeholder="you@lab.org"
              required
            />

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-[13px] font-medium text-fg-muted">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={isSignUp ? "new-password" : "current-password"}
                  placeholder={isSignUp ? "At least 8 characters" : "••••••••"}
                  required
                  minLength={isSignUp ? 8 : undefined}
                  className="focus-ring w-full rounded-xl border border-border bg-bg-elevated px-3.5 py-2.5 pr-11 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle hover:border-border-strong"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="focus-ring absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-fg-subtle transition-colors hover:text-fg"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                    {showPassword ? (
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                      />
                    ) : (
                      <>
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                        />
                      </>
                    )}
                  </svg>
                </button>
              </div>
              {isSignUp && (
                <p className="text-[11px] text-fg-subtle">
                  At least 8 characters. Stored as a bcrypt hash — never in plain text.
                </p>
              )}
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-xl border border-rose/30 bg-rose/10 px-3.5 py-2.5 text-[13px] text-rose"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="gradient-brand focus-ring mt-1 flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy && <Spinner />}
              {busy
                ? isSignUp
                  ? "Creating account…"
                  : "Signing in…"
                : isSignUp
                  ? "Create account"
                  : "Sign in"}
            </button>
          </form>

          <p className="mt-8 text-center text-sm text-fg-muted">
            {isSignUp ? "Already have an account?" : "No account yet?"}{" "}
            <button
              type="button"
              onClick={switchMode}
              className="focus-ring rounded font-semibold text-violet underline-offset-2 hover:underline"
            >
              {isSignUp ? "Sign in" : "Create one"}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  placeholder,
  required,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  placeholder: string;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        className="focus-ring w-full rounded-xl border border-border bg-bg-elevated px-3.5 py-2.5 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle hover:border-border-strong"
      />
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}
