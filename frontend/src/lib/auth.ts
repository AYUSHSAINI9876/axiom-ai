import { API_BASE, describeError } from "./api";
import type { Session, StoredSession, User } from "./types";

// Session storage lives in its own module so the API layer can read it without
// importing this one — see the note there on why localStorage and not cookies.
export { clearSession, loadSession, saveSession } from "./session-storage";

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
