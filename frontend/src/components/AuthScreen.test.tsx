import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import * as auth from "@/lib/auth";
import { makeSession, renderWithProviders } from "@/test-utils";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof auth>();
  return {
    ...actual,
    login: vi.fn(),
    register: vi.fn(),
    loginAsDemo: vi.fn(),
    logout: vi.fn(),
    refreshSession: vi.fn(),
  };
});

vi.mock("@/lib/api", () => ({
  streamChat: vi.fn(),
  fetchDocuments: vi.fn().mockResolvedValue([]),
  uploadDocument: vi.fn(),
  deleteDocument: vi.fn(),
  fetchHealth: vi.fn().mockResolvedValue({ gatewayOnline: true, mlServiceOnline: true }),
  configureAuth: vi.fn(),
  API_BASE: "http://localhost:8080",
}));

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(auth.login).mockReset();
  vi.mocked(auth.register).mockReset();
  vi.mocked(auth.loginAsDemo).mockReset();
});

describe("authentication gate", () => {
  // The app is a single route that swaps on auth state. If this regressed, the
  // chat UI would render for a signed-out visitor and every request would 401.
  it("shows the sign-in screen when there is no session", async () => {
    renderWithProviders(<Home />);
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^message$/i)).not.toBeInTheDocument();
  });

  it("shows the chat app once a session exists", async () => {
    window.localStorage.setItem("axiom-ai-session", JSON.stringify(makeSession()));
    renderWithProviders(<Home />);
    expect(await screen.findByLabelText(/^message$/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /welcome back/i })).not.toBeInTheDocument();
  });

  it("signs in with an email and password and reveals the chat app", async () => {
    vi.mocked(auth.login).mockResolvedValue(makeSession());

    const user = userEvent.setup();
    renderWithProviders(<Home />);

    await user.type(await screen.findByLabelText(/^email$/i), "tester@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "a-good-password");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(auth.login).toHaveBeenCalledWith("tester@example.com", "a-good-password"));
    expect(await screen.findByLabelText(/^message$/i)).toBeInTheDocument();
  });

  it("surfaces a failed sign-in without leaving the form", async () => {
    vi.mocked(auth.login).mockRejectedValue(new Error("incorrect email or password"));

    const user = userEvent.setup();
    renderWithProviders(<Home />);

    await user.type(await screen.findByLabelText(/^email$/i), "tester@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "wrong-password");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("incorrect email or password");
    expect(screen.queryByLabelText(/^message$/i)).not.toBeInTheDocument();
  });

  it("switches to the sign-up form and registers a new account", async () => {
    vi.mocked(auth.register).mockResolvedValue(makeSession());

    const user = userEvent.setup();
    renderWithProviders(<Home />);

    await user.click(await screen.findByRole("button", { name: /create one/i }));
    expect(screen.getByRole("heading", { name: /create your account/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^name$/i), "Ada Lovelace");
    await user.type(screen.getByLabelText(/^email$/i), "ada@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "analytical-engine");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(auth.register).toHaveBeenCalledWith("ada@example.com", "Ada Lovelace", "analytical-engine")
    );
  });

  it("offers a one-click demo sign-in", async () => {
    vi.mocked(auth.loginAsDemo).mockResolvedValue(makeSession());

    const user = userEvent.setup();
    renderWithProviders(<Home />);

    await user.click(await screen.findByRole("button", { name: /try the demo account/i }));
    await waitFor(() => expect(auth.loginAsDemo).toHaveBeenCalled());
    expect(await screen.findByLabelText(/^message$/i)).toBeInTheDocument();
  });

  it("keeps the password hidden until the reveal control is used", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Home />);

    const password = await screen.findByLabelText(/^password$/i);
    expect(password).toHaveAttribute("type", "password");

    await user.click(screen.getByRole("button", { name: /show password/i }));
    expect(password).toHaveAttribute("type", "text");

    await user.click(screen.getByRole("button", { name: /hide password/i }));
    expect(password).toHaveAttribute("type", "password");
  });
});
