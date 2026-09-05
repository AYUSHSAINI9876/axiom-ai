import { loadSession } from "./session-storage";
import type { Citation, DocumentInfo, Role } from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export interface HistoryItem {
  role: Role;
  content: string;
}

/* ---------------------------------------------------------------------------
   Access-token plumbing
   ---------------------------------------------------------------------------
   Every /api/* call needs a bearer token, and the token expires every 15
   minutes. Rather than thread it through each call site, the AuthProvider
   registers a getter and a refresh callback here; the request helpers below use
   them to attach the header and to retry exactly once after a 401.

   Module-level state (not React state) because `streamChat` and friends are
   plain async functions called from event handlers, not hooks.

   The default getter reads stored session directly, so it works before any
   provider has mounted. That matters: React flushes effects child-first, so a
   component firing a request from its own mount effect would otherwise race the
   provider's registration and send the request with no token at all.
--------------------------------------------------------------------------- */

type TokenGetter = () => string | null;
type TokenRefresher = () => Promise<string | null>;

let getAccessToken: TokenGetter = () => loadSession()?.accessToken ?? null;
// No default refresher: rotating a refresh token without the provider knowing
// would leave it holding a token the server has already revoked. Until the
// provider registers one, a 401 simply surfaces.
let refreshAccessToken: TokenRefresher = async () => null;

export function configureAuth(getter: TokenGetter, refresher: TokenRefresher): void {
  getAccessToken = getter;
  refreshAccessToken = refresher;
}

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

/**
 * fetch with the bearer token attached, retrying once on 401 with a refreshed
 * token.
 *
 * The retry is what makes an expired access token invisible to the user: the
 * first call 401s, the refresh token mints a new access token, and the same
 * request goes out again. It retries only once — if the second attempt also
 * 401s the session is genuinely dead and the caller surfaces that.
 */
async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(input, { ...init, headers: authHeaders(init.headers) });
  if (response.status !== 401) return response;

  const refreshed = await refreshAccessToken();
  if (!refreshed) return response;

  const retryHeaders = new Headers(init.headers);
  retryHeaders.set("Authorization", `Bearer ${refreshed}`);
  return fetch(input, { ...init, headers: retryHeaders });
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onSources: (sources: Citation[]) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

interface StreamFrame {
  type: "token" | "sources" | "done" | "error";
  content?: string;
  sources?: Citation[];
  message?: string;
}

export async function streamChat(
  query: string,
  history: HistoryItem[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await authedFetch(`${API_BASE}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, history }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    callbacks.onError("Could not reach Axiom Gateway. Is it running?");
    return;
  }

  if (!res.ok || !res.body) {
    callbacks.onError(await describeError(res));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        processFrame(frame, callbacks);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      callbacks.onError("Connection to Axiom Gateway was interrupted.");
    }
  }
}

function processFrame(frame: string, callbacks: StreamCallbacks): void {
  const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return;

  const jsonStr = dataLine.slice("data:".length).trim();
  if (!jsonStr) return;

  let payload: StreamFrame;
  try {
    payload = JSON.parse(jsonStr);
  } catch {
    return;
  }

  switch (payload.type) {
    case "token":
      if (payload.content) callbacks.onToken(payload.content);
      break;
    case "sources":
      callbacks.onSources(payload.sources ?? []);
      break;
    case "done":
      callbacks.onDone();
      break;
    case "error":
      callbacks.onError(payload.message ?? "Unknown error from Axiom ML Service.");
      break;
  }
}

export async function describeError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) return body.error;
    if (body?.detail) return body.detail;
  } catch {
    // response wasn't JSON — fall through to the generic message
  }
  if (res.status === 401) return "Your session expired. Please sign in again.";
  return `Request failed (${res.status})`;
}

export async function fetchDocuments(): Promise<DocumentInfo[]> {
  const res = await authedFetch(`${API_BASE}/api/documents`);
  if (!res.ok) throw new Error(await describeError(res));
  const data = await res.json();
  return data.documents ?? [];
}

export async function uploadDocument(file: File): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  // No Content-Type header: the browser has to set it itself so the multipart
  // boundary is included.
  const res = await authedFetch(`${API_BASE}/api/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await describeError(res));
}

export async function deleteDocument(name: string): Promise<void> {
  const res = await authedFetch(`${API_BASE}/api/documents/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await describeError(res));
}

export interface HealthResult {
  gatewayOnline: boolean;
  mlServiceOnline: boolean;
  llmBackend?: string;
  llmModel?: string;
  embeddingModel?: string;
  docCount?: number;
}

export async function fetchHealth(): Promise<HealthResult> {
  const result: HealthResult = { gatewayOnline: false, mlServiceOnline: false };

  try {
    // The gateway's own /health is public — it must stay reachable while
    // signed out so the sign-in page can report a dead backend.
    const gatewayRes = await fetch(`${API_BASE}/health`);
    result.gatewayOnline = gatewayRes.ok;
  } catch {
    result.gatewayOnline = false;
  }

  try {
    const mlRes = await authedFetch(`${API_BASE}/api/health`);
    if (mlRes.ok) {
      const body = await mlRes.json();
      result.mlServiceOnline = true;
      result.llmBackend = body.llm_backend;
      result.llmModel = body.llm_model;
      result.embeddingModel = body.embedding_model;
      result.docCount = body.doc_count;
    }
  } catch {
    result.mlServiceOnline = false;
  }

  return result;
}
