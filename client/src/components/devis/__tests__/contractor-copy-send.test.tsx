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
import type { ExternalDelivery } from "../ContractorCopyExternalRecord";
import { queryClient } from "@/lib/queryClient";

const payload = {
  canRecordExternal: true, externalRecordVersion: "version-1", externalDeliveries: [] as ExternalDelivery[],
  canSend: true, reason: null as string | null, signatureSource: "manual_upload",
  contractorName: "Test contractor", recipientEmail: "contractor@example.test",
  quotationRef: "021997", confirmationToken: "test-confirmation", deliveries: [],
};
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function mount(data = payload, flags = { isSigned: true, isArchived: false }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => data }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ContractorCopySend devisId={42} projectId={1} {...flags} /></QueryClientProvider>);
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

async function openExternal() {
  const button = screen.getByRole("button", { name: "Sent by other means" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
const saveExternal = () => screen.getByRole("button", { name: "Record delivery — no email" });
const attest = () => fireEvent.click(screen.getByRole("checkbox"));

describe("externally delivered contractor copy", () => {
  it("records without email eligibility and never posts an email send", async () => {
    mocks.request.mockResolvedValueOnce({ json: async () => payload });
    mount({ ...payload, canSend: false, confirmationToken: "", recipientEmail: "", reason: "No email PDF provenance" });
    await openExternal();
    expect(screen.getByLabelText("Recipient")).toHaveValue("Test contractor");
    const date = new Date();
    const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    expect(screen.getByLabelText("Date sent")).toHaveValue(localDate);
    expect(saveExternal()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Delivery method"), { target: { value: "hand" } });
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "Delivered at site meeting" } });
    attest();
    fireEvent.click(saveExternal());
    await screen.findByRole("status");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith("POST", "/api/devis/42/contractor-copy/external", {
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), expectedVersion: "version-1",
      sentOn: localDate, method: "hand", recipient: "Test contractor", note: "Delivered at site meeting", confirmed: true,
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/devis", 42, "contractor-copy"] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/devis", 42, "contractor-copy-status"] });
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("shows external history with method, date, recipient and note, even when recording is disabled", async () => {
    mount({ ...payload, canRecordExternal: false, externalDeliveries: [{
      id: 4, sentOn: "2026-01-09", method: "whatsapp", recipient: "Mireille Laurent",
      note: "Shared after site meeting", recordedAt: "2026-01-10T10:32:00Z", currentDocument: true,
    }] });
    expect(await screen.findByText("Recorded manually · WhatsApp")).toBeVisible();
    expect(screen.getByText("2026-01-09")).toBeVisible();
    expect(screen.getByText("Mireille Laurent")).toBeVisible();
    expect(screen.getByText("Shared after site meeting")).toBeVisible();
    expect(screen.getByText("Operator recorded; does not confirm receipt.")).toBeVisible();
  });
  it("requires a recipient and disallows a future date", async () => {
    mount();
    await openExternal();
    attest();
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "  " } });
    expect(saveExternal()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "Mireille Laurent" } });
    fireEvent.change(screen.getByLabelText("Date sent"), { target: { value: "2999-01-01" } });
    expect(saveExternal()).toBeDisabled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("cancels without any POST", async () => {
    mount();
    await openExternal();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Date sent")).not.toBeInTheDocument();
  });
  it.each([
    { canRecordExternal: false, isArchived: false, isSigned: true },
    { canRecordExternal: true, isArchived: true, isSigned: true },
    { canRecordExternal: true, isArchived: false, isSigned: false },
  ])("disables unavailable manual recording: %j", async flags => {
    mount({ ...payload, canRecordExternal: flags.canRecordExternal }, flags);
    await screen.findByText("Contractor copy");
    expect(screen.getByRole("button", { name: "Sent by other means" })).toBeDisabled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("retains failed drafts and request identity for retry, including after cancel", async () => {
    mocks.request.mockRejectedValueOnce(new Error("Connection interrupted"));
    mocks.request.mockResolvedValueOnce({ json: async () => payload });
    mount();
    await openExternal();
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "Mireille Laurent" } });
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "By courier" } });
    attest();
    fireEvent.click(saveExternal());
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
    expect(screen.getByLabelText("Recipient")).toHaveValue("Mireille Laurent");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openExternal();
    expect(screen.getByLabelText("Note (optional)")).toHaveValue("By courier");
    fireEvent.click(saveExternal());
    await screen.findByRole("status");
    expect(mocks.request.mock.calls[1]).toEqual(mocks.request.mock.calls[0]);
  });
  it("disables form and cancel while recording", async () => {
    let resolve!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    mount();
    await openExternal();
    attest();
    fireEvent.click(saveExternal());
    await waitFor(() => expect(screen.getByRole("button", { name: "Recording…" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByLabelText("Recipient")).toBeDisabled();
    resolve({ json: async () => payload });
    await screen.findByRole("status");
  });
});
