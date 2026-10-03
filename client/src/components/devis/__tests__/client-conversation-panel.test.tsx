// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DevisLineItem } from "@shared/schema";

const { apiRequestMock, invalidateQueriesMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
  invalidateQueriesMock: vi.fn(),
}));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  queryClient: { invalidateQueries: invalidateQueriesMock },
}));
import { ClientConversationPanel } from "../ClientConversationPanel";

const conversation = {
  id: 73, devisId: 42, status: "open", queryText: "Does this include the window surround?",
  devisLineItemId: 11, openedAt: "2026-09-05T09:00:00.000Z", resolutionNote: null,
  messages: [
    { id: 1, checkId: 73, authorType: "client", authorName: "Marie Dupont", authorEmail: "marie@example.test", body: "Please confirm the finish.", createdAt: "2026-09-05T09:02:00.000Z" },
    { id: 2, checkId: 73, authorType: "architect", authorName: "Luc Martin", authorEmail: "luc@example.test", body: "We are checking the specification.", createdAt: "2026-09-05T09:03:00.000Z" },
  ],
};
const clients: QueryClient[] = [];
function renderPanel(options: { status?: string; archived?: boolean; empty?: boolean; queryFn?: () => Promise<unknown> } = {}) {
  const checks = options.empty ? [] : [{ ...conversation, status: options.status ?? "open" }];
  const queryFn = options.queryFn ?? vi.fn().mockResolvedValue(checks);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn }, mutations: { retry: false } } });
  clients.push(client);
  if (!options.queryFn) client.setQueryData(["/api/devis", 42, "client-checks"], checks);
  return {
    queryFn,
    ...render(<QueryClientProvider client={client}>
      <ClientConversationPanel devisId={42} isArchived={options.archived ?? false} lineItems={[{ id: 11, lineNumber: 4, description: "Exterior render" } as DevisLineItem]} />
    </QueryClientProvider>),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  apiRequestMock.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.useRealTimers();
});

describe("ClientConversationPanel", () => {
  it("reads original query, referenced line, authors, times, history and count", async () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Client conversations" })).toBeVisible();
    expect(screen.getByLabelText("1 conversations, 1 open")).toHaveTextContent("1 · 1 open");
    expect(screen.getByText(conversation.queryText)).toBeVisible();
    expect(screen.getByText("Line 4 · Exterior render")).toBeVisible();
    expect(screen.getByText("Marie Dupont")).toBeVisible();
    expect(screen.getByText("Luc Martin")).toBeVisible();
    expect(screen.getByText("Please confirm the finish.")).toBeVisible();
    expect(screen.getByText("We are checking the specification.")).toBeVisible();
    expect(document.querySelector('time[datetime="2026-09-05T09:02:00.000Z"]')).toBeInTheDocument();
    expect(screen.getByText(/Your reply appears in the shared client portal/)).toBeVisible();
  });

  it("sends trimmed reply once, disables duplicate submission, clears only on success and invalidates", async () => {
    let finish!: () => void;
    apiRequestMock.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderPanel();
    const input = screen.getByRole("textbox", { name: "Reply to client" });
    fireEvent.change(input, { target: { value: "  The surround is included.  " } });
    const send = screen.getByRole("button", { name: "Send reply" });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    expect(apiRequestMock).toHaveBeenCalledWith("POST", "/api/client-checks/73/messages", { body: "The surround is included." });
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: /Sending/ })).toBeDisabled();
    expect(input).toHaveValue("  The surround is included.  ");
    finish();
    await waitFor(() => expect(input).toHaveValue(""));
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["/api/devis", 42, "client-checks"] });
    expect(screen.getByRole("status")).toHaveTextContent("Reply posted to the shared client portal.");
  });

  it("preserves failed draft and lets the architect retry", async () => {
    apiRequestMock.mockRejectedValueOnce(new Error("Connection lost"));
    renderPanel();
    const input = screen.getByRole("textbox", { name: "Reply to client" });
    fireEvent.change(input, { target: { value: "The surround is included." } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Connection lost"));
    expect(input).toHaveValue("The surround is included.");
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: "resolved", archived: false },
    { status: "cancelled", archived: false },
    { status: "open", archived: true },
  ])("keeps history read-only for $status / archived=$archived", (options) => {
    renderPanel(options);
    expect(screen.getByText("Please confirm the finish.")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send reply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve conversation" })).not.toBeInTheDocument();
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it("resolves explicitly with optional note and retains it on failure", async () => {
    apiRequestMock.mockRejectedValueOnce(new Error("Try later"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Resolve conversation" }));
    const note = screen.getByRole("textbox", { name: "Resolution note (optional)" });
    fireEvent.change(note, { target: { value: "  Scope confirmed with the client.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm resolution" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Try later"));
    expect(note).toHaveValue("  Scope confirmed with the client.  ");
    fireEvent.click(screen.getByRole("button", { name: "Confirm resolution" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Conversation resolved."));
    expect(apiRequestMock).toHaveBeenLastCalledWith("POST", "/api/client-checks/73/resolve", { resolutionNote: "Scope confirmed with the client." });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["/api/devis", 42, "client-checks"] });
  });

  it("composes an empty state", () => {
    renderPanel({ empty: true });
    expect(screen.getByText("No client questions yet")).toBeVisible();
    expect(screen.getByLabelText("0 conversations, 0 open")).toBeVisible();
  });

  it("polls for incoming messages without replacing an unsent reply", async () => {
    vi.useFakeTimers();
    const queryFn = vi.fn()
      .mockResolvedValueOnce([conversation])
      .mockResolvedValue([{ ...conversation, messages: [...conversation.messages, {
        id: 3, checkId: 73, authorType: "client", authorName: "Marie Dupont",
        body: "Could you also confirm the colour?", createdAt: "2026-09-05T09:05:00.000Z",
      }] }]);
    renderPanel({ queryFn });
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    const input = screen.getByRole("textbox", { name: "Reply to client" });
    fireEvent.change(input, { target: { value: "I am checking the finish." } });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_010); });
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Could you also confirm the colour?")).toBeVisible();
    expect(input).toHaveValue("I am checking the finish.");
  });

  it("shows loading skeletons then a retryable read error", async () => {
    const queryFn = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue([]);
    renderPanel({ queryFn });
    expect(screen.getByLabelText("Loading client conversations")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not refresh client conversations"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("No client questions yet")).toBeVisible());
  });
});