import type { StoredSession } from "./types";

/* ---------------------------------------------------------------------------
   Where the tokens live
   ---------------------------------------------------------------------------
   The gateway is on a different origin from the frontend in every deployed
   configuration (Vercel → Render), which rules out cookies: a cross-site
   cookie needs SameSite=None, and browsers increasingly block those outright.
   So tokens travel in the Authorization header and persist in localStorage.

   The tradeoff is honest rather than hidden: localStorage is readable by any
   script on the page, so this design leans on the access token being
   short-lived (15 minutes) and the refresh token being revocable and rotated
   on every use, which is what bounds the damage from a leak.

   This module is deliberately dependency-free. Both the API layer and the auth
   layer read it, and putting it in either one would make them import each
   other.
--------------------------------------------------------------------------- */

const SESSION_KEY = "axiom-ai-session";

export function loadSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.accessToken || !parsed?.refreshToken || !parsed?.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Quota or private-browsing failures cost persistence across reloads, not
    // the current session — the in-memory copy keeps working.
  }
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing useful to do; the in-memory state is cleared by the caller.
  }
}

export { SESSION_KEY };
