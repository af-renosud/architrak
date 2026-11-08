// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => mocks.request(...args),
  queryClient: { invalidateQueries: vi.fn(), setQueryData: vi.fn() },
  projectScopedKey: (id: number, resource: string) => ["/api/projects", id, resource],
}));
import { ContractorCopySend } from "../ContractorCopySend";

const payload = {
  canSend: true, reason: null as string | null, signatureSource: "manual_upload",
  contractorName: "Test contractor", recipientEmail: "contractor@example.test",
  quotationRef: "021997", confirmationToken: "test-confirmation", deliveries: [],
};
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function mount(data = payload) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => data }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ContractorCopySend devisId={42} projectId={1} isSigned isArchived={false} /></QueryClientProvider>);
}

describe("contractor copy confirmation", () => {
  it("shows manual provenance and PDF preview, but does not send on opening or cancelling", async () => {
    mount();
    const button = screen.getByTestId("button-send-to-contractor-42");
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText(/Recorded by an architect; not verified through Archisign/)).toBeVisible();
    expect(screen.getByText("contractor@example.test")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open the signed PDF to be attached" })).toHaveAttribute("href", "/api/devis/42/signed-pdf");
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("sends only after explicit confirmation with a stable request identity", async () => {
    mocks.request.mockResolvedValue({ json: async () => ({ ...payload, deliveries: [{ id: 1, status: "sent" }] }) });
    mount();
    await waitFor(() => expect(screen.getByTestId("button-send-to-contractor-42")).toBeEnabled());
    fireEvent.click(screen.getByTestId("button-send-to-contractor-42"));
    await screen.findByText(/Recorded by an architect/);
    fireEvent.click(screen.getByTestId("button-send-to-contractor-confirm-42"));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    expect(mocks.request).toHaveBeenCalledWith("POST", "/api/devis/42/contractor-copy", {
      confirmationToken: "test-confirmation", requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
  });
  it("keeps unavailable signed documents disabled", async () => {
    mount({ ...payload, canSend: false, reason: "Stored signed PDF bytes are unavailable" });
    await screen.findByText("Stored signed PDF bytes are unavailable");
    expect(screen.getByTestId("button-send-to-contractor-42")).toBeDisabled();
  });
});
