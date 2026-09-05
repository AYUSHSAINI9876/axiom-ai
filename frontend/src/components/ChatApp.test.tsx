import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatApp from "./ChatApp";
import * as api from "@/lib/api";
import { renderWithProviders, signIn } from "@/test-utils";

vi.mock("@/lib/api", () => ({
  streamChat: vi.fn(),
  fetchDocuments: vi.fn(),
  uploadDocument: vi.fn(),
  deleteDocument: vi.fn(),
  fetchHealth: vi.fn(),
  configureAuth: vi.fn(),
  API_BASE: "http://localhost:8080",
}));

beforeEach(() => {
  window.localStorage.clear();
  signIn();
  vi.mocked(api.fetchDocuments).mockResolvedValue([]);
  vi.mocked(api.fetchHealth).mockResolvedValue({
    gatewayOnline: true,
    mlServiceOnline: true,
    llmBackend: "ollama",
    docCount: 1,
  });
  vi.mocked(api.streamChat).mockReset();
});

describe("ChatApp", () => {
  it("greets the signed-in user and shows example prompts", async () => {
    renderWithProviders(<ChatApp />);
    expect(await screen.findByText(/Hello, Test\./i)).toBeInTheDocument();
    expect(screen.getByText(/Summarize the key findings/i)).toBeInTheDocument();
  });

  it("sends a message and renders the streamed response with citations", async () => {
    vi.mocked(api.streamChat).mockImplementation(async (_query, _history, callbacks) => {
      callbacks.onToken("Hello ");
      callbacks.onToken("world");
      callbacks.onSources([{ text: "snippet", score: 0.87, file: "doc.md" }]);
      callbacks.onDone();
    });

    const user = userEvent.setup();
    renderWithProviders(<ChatApp />);

    const input = await screen.findByLabelText(/^message$/i);
    await user.type(input, "What is the Eyring equation?");
    await user.click(screen.getByLabelText(/send message/i));

    // The same text also becomes the sidebar's auto-generated conversation
    // title, so queries must be scoped to the message log to stay unambiguous.
    const log = screen.getByRole("log");
    expect(await within(log).findByText("What is the Eyring equation?")).toBeInTheDocument();
    await waitFor(() => expect(within(log).getByText(/Hello world/)).toBeInTheDocument());
    expect(within(log).getByText("doc.md")).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledWith(
      "What is the Eyring equation?",
      [],
      expect.anything(),
      expect.anything()
    );
  });

  it("submits on Enter but inserts a newline on Shift+Enter", async () => {
    vi.mocked(api.streamChat).mockImplementation(async (_query, _history, callbacks) => {
      callbacks.onToken("ok");
      callbacks.onDone();
    });

    const user = userEvent.setup();
    renderWithProviders(<ChatApp />);

    const input = await screen.findByLabelText(/^message$/i);
    await user.type(input, "first line{Shift>}{Enter}{/Shift}second line");
    expect(api.streamChat).not.toHaveBeenCalled();
    expect(input).toHaveValue("first line\nsecond line");

    await user.type(input, "{Enter}");
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.streamChat).mock.calls[0][0]).toBe("first line\nsecond line");
  });

  it("shows an inline error bubble when the stream reports an error", async () => {
    vi.mocked(api.streamChat).mockImplementation(async (_query, _history, callbacks) => {
      callbacks.onError("The ML service rejected the request.");
    });

    const user = userEvent.setup();
    renderWithProviders(<ChatApp />);

    const input = await screen.findByLabelText(/^message$/i);
    await user.type(input, "hello");
    await user.click(screen.getByLabelText(/send message/i));

    expect(await screen.findByText("The ML service rejected the request.")).toBeInTheDocument();
  });

  it("starts a new chat and lists both conversations in the sidebar", async () => {
    vi.mocked(api.streamChat).mockImplementation(async (_query, _history, callbacks) => {
      callbacks.onToken("Answer one");
      callbacks.onSources([]);
      callbacks.onDone();
    });

    const user = userEvent.setup();
    renderWithProviders(<ChatApp />);

    const input = await screen.findByLabelText(/^message$/i);
    await user.type(input, "First conversation question");
    await user.click(screen.getByLabelText(/send message/i));
    await screen.findByText("Answer one");

    await user.click(screen.getByRole("button", { name: /new chat/i }));

    expect(await screen.findByText("First conversation question")).toBeInTheDocument();
    expect(screen.getByText(/What are we researching\?/i)).toBeInTheDocument();
  });

  it("shows the signed-in account and a way out", async () => {
    renderWithProviders(<ChatApp />);
    expect(await screen.findByText("Test User")).toBeInTheDocument();
    expect(screen.getByText("tester@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });
});
