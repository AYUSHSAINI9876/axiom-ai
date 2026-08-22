import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatApp from "./ChatApp";
import * as api from "@/lib/api";

vi.mock("@/lib/api", () => ({
  streamChat: vi.fn(),
  fetchDocuments: vi.fn(),
  uploadDocument: vi.fn(),
  fetchHealth: vi.fn(),
}));

beforeEach(() => {
  window.localStorage.clear();
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
  it("shows the empty state with example prompts", async () => {
    render(<ChatApp />);
    expect(
      await screen.findByText(/How can I assist your research today/i)
    ).toBeInTheDocument();
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
    render(<ChatApp />);

    const input = await screen.findByLabelText(/^message$/i);
    await user.type(input, "What is the Eyring equation?");
    await user.click(screen.getByLabelText(/send message/i));

    // The same text also becomes the sidebar's auto-generated conversation
    // title, so queries must be scoped to the message log to stay unambiguous.
    const log = screen.getByRole("log");
    expect(
      await within(log).findByText("What is the Eyring equation?")
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(log).getByText(/Hello world/)).toBeInTheDocument()
    );
    expect(within(log).getByText("doc.md")).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledWith(
      "What is the Eyring equation?",
      [],
      expect.anything(),
      expect.anything()
    );
  });

  it("shows an inline error bubble when the stream reports an error", async () => {
    vi.mocked(api.streamChat).mockImplementation(async (_query, _history, callbacks) => {
      callbacks.onError("The ML service rejected the request.");
    });

    const user = userEvent.setup();
    render(<ChatApp />);

    const input = await screen.findByLabelText(/^message$/i);
    await user.type(input, "hello");
    await user.click(screen.getByLabelText(/send message/i));

    expect(
      await screen.findByText("The ML service rejected the request.")
    ).toBeInTheDocument();
  });

  it("starts a new chat and lists both conversations in the sidebar", async () => {
    vi.mocked(api.streamChat).mockImplementation(async (_query, _history, callbacks) => {
      callbacks.onToken("Answer one");
      callbacks.onSources([]);
      callbacks.onDone();
    });

    const user = userEvent.setup();
    render(<ChatApp />);

    const input = await screen.findByLabelText(/^message$/i);
    await user.type(input, "First conversation question");
    await user.click(screen.getByLabelText(/send message/i));
    await screen.findByText("Answer one");

    await user.click(screen.getByRole("button", { name: /new chat/i }));

    expect(await screen.findByText("First conversation question")).toBeInTheDocument();
    expect(screen.getByText(/How can I assist your research today/i)).toBeInTheDocument();
  });
});
