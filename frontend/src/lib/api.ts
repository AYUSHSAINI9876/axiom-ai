import type { Citation, DocumentInfo, Role } from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export interface HistoryItem {
  role: Role;
  content: string;
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
    res = await fetch(`${API_BASE}/api/chat/stream`, {
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

async function describeError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) return body.error;
    if (body?.detail) return body.detail;
  } catch {
    // response wasn't JSON — fall through to the generic message
  }
  return `Request failed (${res.status})`;
}

export async function fetchDocuments(): Promise<DocumentInfo[]> {
  const res = await fetch(`${API_BASE}/api/documents`);
  if (!res.ok) throw new Error(await describeError(res));
  const data = await res.json();
  return data.documents ?? [];
}

export async function uploadDocument(file: File): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(await describeError(res));
}

export interface HealthResult {
  gatewayOnline: boolean;
  mlServiceOnline: boolean;
  llmBackend?: string;
  embeddingModel?: string;
  docCount?: number;
}

export async function fetchHealth(): Promise<HealthResult> {
  const result: HealthResult = { gatewayOnline: false, mlServiceOnline: false };

  try {
    const gatewayRes = await fetch(`${API_BASE}/health`);
    result.gatewayOnline = gatewayRes.ok;
  } catch {
    result.gatewayOnline = false;
  }

  try {
    const mlRes = await fetch(`${API_BASE}/api/health`);
    if (mlRes.ok) {
      const body = await mlRes.json();
      result.mlServiceOnline = true;
      result.llmBackend = body.llm_backend;
      result.embeddingModel = body.embedding_model;
      result.docCount = body.doc_count;
    }
  } catch {
    result.mlServiceOnline = false;
  }

  return result;
}
