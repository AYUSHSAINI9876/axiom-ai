import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import AuthProvider from "@/context/AuthProvider";
import ThemeProvider from "@/context/ThemeProvider";
import ToastProvider from "@/context/ToastProvider";
import type { StoredSession, User } from "@/lib/types";

export const TEST_USER: User = {
  id: "usr_test",
  email: "tester@example.com",
  name: "Test User",
  created_at: "2026-01-01T00:00:00Z",
};

export function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    user: TEST_USER,
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 15 * 60 * 1000,
    ...overrides,
  };
}

/**
 * Seed a signed-in session before rendering.
 *
 * AuthProvider reads localStorage in an effect on mount, so writing the
 * session here is what makes a component render in its authenticated state —
 * there's no prop to pass instead.
 */
export function signIn(session: StoredSession = makeSession()): void {
  window.localStorage.setItem("axiom-ai-session", JSON.stringify(session));
}

/** render() wrapped in the provider stack the real app mounts. */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">
): RenderResult {
  return render(ui, {
    wrapper: ({ children }) => (
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    ),
    ...options,
  });
}
