"use client";

import AuthScreen from "@/components/AuthScreen";
import ChatApp from "@/components/ChatApp";
import Logo from "@/components/Logo";
import { useAuth } from "@/context/AuthProvider";

export default function Home() {
  const { user, isReady } = useAuth();

  // A single route that swaps on auth state, rather than /login + a redirect.
  // Redirecting would flash the chat shell (or the sign-in page) for a frame
  // while the stored session is read from localStorage on the client.
  if (!isReady) return <BootSplash />;
  return user ? <ChatApp /> : <AuthScreen />;
}

function BootSplash() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <Logo size={44} className="animate-pulse" />
      <p className="text-[11px] uppercase tracking-[0.2em] text-fg-subtle">Axiom AI</p>
      <span className="sr-only" role="status">
        Loading your session…
      </span>
    </main>
  );
}
