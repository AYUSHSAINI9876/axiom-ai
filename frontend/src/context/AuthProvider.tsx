"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { configureAuth } from "@/lib/api";
import {
  clearSession,
  loadSession,
  login as loginRequest,
  loginAsDemo as demoRequest,
  logout as logoutRequest,
  refreshSession,
  register as registerRequest,
  saveSession,
} from "@/lib/auth";
import type { StoredSession, User } from "@/lib/types";

interface AuthContextValue {
  user: User | null;
  /** False only until the stored session has been read on the client. */
  isReady: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, name: string, password: string) => Promise<void>;
  signInAsDemo: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an <AuthProvider>");
  return context;
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [isReady, setIsReady] = useState(false);

  // The ref mirrors the state so the token getter handed to api.ts always sees
  // the current session. Reading React state from that callback would capture
  // whatever value existed when the effect last ran.
  const sessionRef = useRef<StoredSession | null>(null);
  const setBoth = useCallback((next: StoredSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  // A single in-flight refresh shared by every caller. Without this, a page
  // that fires several requests at once would send several refreshes with the
  // same token — and rotation means all but the first would be rejected as
  // reuse, logging the user out.
  const refreshInFlight = useRef<Promise<string | null> | null>(null);

  const refresh = useCallback(async (): Promise<string | null> => {
    const current = sessionRef.current;
    if (!current) return null;

    if (!refreshInFlight.current) {
      refreshInFlight.current = (async () => {
        try {
          const next = await refreshSession(current.refreshToken);
          setBoth(next);
          saveSession(next);
          return next.accessToken;
        } catch {
          // The refresh token is dead (expired, revoked, or replayed). Drop the
          // session so the app falls back to the sign-in page.
          setBoth(null);
          clearSession();
          return null;
        } finally {
          refreshInFlight.current = null;
        }
      })();
    }
    return refreshInFlight.current;
  }, [setBoth]);

  // Register the token accessors with the API layer exactly once, before any
  // child can fire a request.
  useEffect(() => {
    configureAuth(() => sessionRef.current?.accessToken ?? null, refresh);
  }, [refresh]);

  useEffect(() => {
    // Reading localStorage during render would break SSR hydration, so the
    // first client render matches the server's "signed out" markup and the
    // stored session lands on the next one. isReady gates the UI meanwhile.
    const stored = loadSession();
    if (stored) {
      sessionRef.current = stored;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above
      setSession(stored);
    }
    setIsReady(true);
  }, []);

  // Renew shortly before expiry so a long idle tab still holds a live token.
  useEffect(() => {
    if (!session) return;
    const delay = Math.max(session.expiresAt - Date.now(), 5_000);
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [session, refresh]);

  // Signing out in one tab should sign out the others, and signing in should
  // propagate too. The storage event fires only in *other* tabs, which is
  // exactly the semantic wanted here.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "axiom-ai-session") return;
      const stored = loadSession();
      setBoth(stored);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setBoth]);

  const adopt = useCallback(
    (next: StoredSession) => {
      setBoth(next);
      saveSession(next);
    },
    [setBoth]
  );

  const signIn = useCallback(
    async (email: string, password: string) => adopt(await loginRequest(email, password)),
    [adopt]
  );

  const signUp = useCallback(
    async (email: string, name: string, password: string) =>
      adopt(await registerRequest(email, name, password)),
    [adopt]
  );

  const signInAsDemo = useCallback(async () => adopt(await demoRequest()), [adopt]);

  const signOut = useCallback(async () => {
    const current = sessionRef.current;
    setBoth(null);
    clearSession();
    if (current) await logoutRequest(current.refreshToken);
  }, [setBoth]);

  const value = useMemo(
    () => ({ user: session?.user ?? null, isReady, signIn, signUp, signInAsDemo, signOut }),
    [session, isReady, signIn, signUp, signInAsDemo, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
