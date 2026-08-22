import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDocuments, fetchHealth, streamChat, uploadDocument } from "./api";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

describe("streamChat", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses token, sources, and done SSE frames", async () => {
    const body = sseStream([
      'data: {"type": "token", "content": "Hel"}\n\n',
      'data: {"type": "token", "content": "lo"}\n\n',
      'data: {"type": "sources", "sources": [{"text": "snippet", "score": 0.9, "file": "doc.md"}]}\n\n',
      'data: {"type": "done"}\n\n',
    ]);
    vi.mocked(fetch).mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const tokens: string[] = [];
    let sources: unknown = null;
    let done = false;
    let error: string | null = null;

    await streamChat("hello", [], {
      onToken: (t) => tokens.push(t),
      onSources: (s) => {
        sources = s;
      },
      onDone: () => {
        done = true;
      },
      onError: (e) => {
        error = e;
      },
    });

    expect(tokens.join("")).toBe("Hello");
    expect(sources).toEqual([{ text: "snippet", score: 0.9, file: "doc.md" }]);
    expect(done).toBe(true);
    expect(error).toBeNull();
  });

  it("reports a friendly error when the gateway is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    let error: string | null = null;
    await streamChat("hello", [], {
      onToken: () => {},
      onSources: () => {},
      onDone: () => {},
      onError: (e) => {
        error = e;
      },
    });

    expect(error).toMatch(/Axiom Gateway/);
  });

  it("surfaces backend error events emitted mid-stream", async () => {
    const body = sseStream([
      'data: {"type": "error", "message": "No documents indexed yet."}\n\n',
    ]);
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));

    let error: string | null = null;
    await streamChat("hello", [], {
      onToken: () => {},
      onSources: () => {},
      onDone: () => {},
      onError: (e) => {
        error = e;
      },
    });

    expect(error).toBe("No documents indexed yet.");
  });
});

describe("fetchDocuments / uploadDocument / fetchHealth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchDocuments returns the documents array", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          documents: [{ name: "a.md", size_bytes: 10, modified: "now" }],
        }),
        { status: 200 }
      )
    );
    const docs = await fetchDocuments();
    expect(docs).toEqual([{ name: "a.md", size_bytes: 10, modified: "now" }]);
  });

  it("uploadDocument throws with the backend's error detail on failure", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "bad file" }), { status: 400 })
    );
    const file = new File(["content"], "test.txt", { type: "text/plain" });
    await expect(uploadDocument(file)).rejects.toThrow("bad file");
  });

  it("fetchHealth reports both services offline when fetch fails entirely", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("down"));
    const health = await fetchHealth();
    expect(health.gatewayOnline).toBe(false);
    expect(health.mlServiceOnline).toBe(false);
  });
});
