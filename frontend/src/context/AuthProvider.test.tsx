import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { screen, waitFor } from "@testing-library/react";
import { fetchDocuments } from "@/lib/api";
import { makeSession, renderWithProviders } from "@/test-utils";

// Deliberately NOT mocking @/lib/api here: the point of these tests is the
// real wiring between AuthProvider and the request helpers.

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A child that fires a request in its mount effect, like UploadPanel does. */
function EagerChild() {
  useEffect(() => {
    fetchDocuments().catch(() => {});
  }, []);
  return <p>child mounted</p>;
}

describe("AuthProvider token wiring", () => {
  // Effects flush child-first, so registering the token getter in an effect
  // would leave a child's mount request unauthenticated. This asserts the
  // header is attached on that very first call.
  it("attaches the token to a request fired from a child's mount effect", async () => {
    window.localStorage.setItem("axiom-ai-session", JSON.stringify(makeSession()));
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ documents: [] }), { status: 200 })
    );

    renderWithProviders(<EagerChild />);
    await screen.findByText("child mounted");

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer access-token");
  });

  it("refreshes once and retries after a 401", async () => {
    window.localStorage.setItem("axiom-ai-session", JSON.stringify(makeSession()));

    vi.mocked(fetch)
      // The original request, with an expired token.
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "expired" }), { status: 401 }))
      // The refresh exchange.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: makeSession().user,
            access_token: "fresh-token",
            refresh_token: "fresh-refresh",
            expires_in: 900,
            token_type: "Bearer",
          }),
          { status: 200 }
        )
      )
      // The retry.
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [] }), { status: 200 }));

    renderWithProviders(<EagerChild />);
    await screen.findByText("child mounted");

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));

    const retryInit = vi.mocked(fetch).mock.calls[2][1] as RequestInit;
    expect(new Headers(retryInit.headers).get("Authorization")).toBe("Bearer fresh-token");
  });

  it("gives up after one failed refresh rather than looping", async () => {
    window.localStorage.setItem("axiom-ai-session", JSON.stringify(makeSession()));

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "expired" }), { status: 401 }))
      // The refresh itself is rejected — the session is genuinely dead.
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid" }), { status: 401 }));

    renderWithProviders(<EagerChild />);
    await screen.findByText("child mounted");

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    // A third call would mean the retry ran with a null token, or worse, looped.
    expect(fetch).toHaveBeenCalledTimes(2);

    // …and the dead session is cleared, so the app falls back to sign-in.
    await waitFor(() => expect(window.localStorage.getItem("axiom-ai-session")).toBeNull());
  });
});
