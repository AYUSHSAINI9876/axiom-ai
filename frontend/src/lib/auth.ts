import { API_BASE, describeError } from "./api";
import type { Session, StoredSession, User } from "./types";

const SESSION_KEY = "axiom-ai-session";

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
--------------------------------------------------------------------------- */

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

function toStoredSession(payload: Session): StoredSession {
  return {
    user: payload.user,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    // Renew a minute early so a request never starts with a token that expires
    // while it is in flight.
    expiresAt: Date.now() + Math.max(payload.expires_in - 60, 30) * 1000,
  };
}

async function postAuth(path: string, body: unknown): Promise<StoredSession> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach Axiom Gateway. Is it running?");
  }

  if (!res.ok) throw new Error(await describeError(res));
  return toStoredSession((await res.json()) as Session);
}

export function register(email: string, name: string, password: string): Promise<StoredSession> {
  return postAuth("register", { email, name, password });
}

export function login(email: string, password: string): Promise<StoredSession> {
  return postAuth("login", { email, password });
}

export function loginAsDemo(): Promise<StoredSession> {
  return postAuth("demo", {});
}

export function refreshSession(refreshToken: string): Promise<StoredSession> {
  return postAuth("refresh", { refresh_token: refreshToken });
}

export async function logout(refreshToken: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    // A failed revoke shouldn't trap someone in a signed-in UI. The local
    // session is cleared regardless, and the token expires on its own.
  }
}

export async function fetchMe(accessToken: string): Promise<User> {
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(await describeError(res));
  const body = await res.json();
  return body.user as User;
}
