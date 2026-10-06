// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, ApiError } from "@/lib/queryClient";
import * as api from "@/lib/queryClient";
import { useInvoiceAwareCertificatSend } from "@/hooks/use-invoice-aware-certificat-send";
import { ArchitectInvoiceSection } from "@/components/certificats/ArchitectInvoiceSection";
import { architectInvoiceKey, architectInvoiceDeliveryLabel, validateArchitectInvoice, type ArchitectInvoiceStatus } from "@/lib/architect-invoice";

const status: ArchitectInvoiceStatus = {
  attached: false, fileName: null, locked: false, deliveryStatus: null,
  sentWithInvoice: null, historicalDeliveryUnknown: false,
};
const success = vi.fn();
const error = vi.fn();
function Harness() {
  const send = useInvoiceAwareCertificatSend<unknown, number>({
    target: (certId) => ({ projectId: 9, certId }),
    onSuccess: success, onError: error,
  });
  return <><button onClick={() => send.mutate(42)} disabled={send.isPending}>Send certificate</button>{send.confirmationDialog}</>;
}
function mount() {
  return render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
}
function response() { return { json: async () => ({ id: 91 }) } as Response; }

beforeEach(() => {
  queryClient.clear();
  success.mockClear();
  error.mockClear();
  vi.spyOn(queryClient, "fetchQuery").mockResolvedValue(status);
  vi.spyOn(api, "apiRequest").mockResolvedValue(response());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); queryClient.clear(); });

describe("architect invoice send reminder", () => {
  it("offers cancellation without issuing a send or firing success", async () => {
    mount();
    fireEvent.click(screen.getByText("Send certificate"));
    await screen.findByTestId("architect-invoice-send-reminder");
    expect(api.apiRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Annuler"));
    await waitFor(() => expect(screen.queryByTestId("architect-invoice-send-reminder")).toBeNull());
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it("only sends the explicit confirmation after the user chooses send without", async () => {
    mount();
    fireEvent.click(screen.getByText("Send certificate"));
    fireEvent.click(await screen.findByTestId("send-without-architect-invoice"));
    await waitFor(() => expect(success).toHaveBeenCalledWith({ id: 91 }, 42));
    expect(api.apiRequest).toHaveBeenCalledWith("POST", "/api/projects/9/certificats/42/send", { confirmWithoutArchitectInvoice: true });
  });
  it("sends an attached invoice normally, then handles an authoritative 409 race", async () => {
    vi.mocked(queryClient.fetchQuery).mockResolvedValue({ ...status, attached: true });
    vi.mocked(api.apiRequest).mockRejectedValueOnce(new ApiError(409, "Attachment missing", { code: "ARCHITECT_INVOICE_CONFIRMATION_REQUIRED" }));
    mount();
    fireEvent.click(screen.getByText("Send certificate"));
    await screen.findByTestId("architect-invoice-send-reminder");
    expect(api.apiRequest).toHaveBeenCalledWith("POST", "/api/projects/9/certificats/42/send", {});
    expect(error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("send-without-architect-invoice"));
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(api.apiRequest).toHaveBeenLastCalledWith("POST", "/api/projects/9/certificats/42/send", { confirmWithoutArchitectInvoice: true });
  });
  it("preserves other send error handling", async () => {
    vi.mocked(queryClient.fetchQuery).mockResolvedValue({ ...status, attached: true });
    const bankingError = new ApiError(422, "IBAN missing", { code: "BANKING_DETAILS_MISSING" });
    vi.mocked(api.apiRequest).mockRejectedValueOnce(bankingError);
    mount();
    fireEvent.click(screen.getByText("Send certificate"));
    await waitFor(() => expect(error).toHaveBeenCalledWith(bankingError));
    expect(screen.queryByTestId("architect-invoice-send-reminder")).toBeNull();
  });
  it("fails closed if status cannot be verified", async () => {
    vi.mocked(queryClient.fetchQuery).mockRejectedValueOnce(new Error("Unavailable"));
    mount();
    fireEvent.click(screen.getByText("Send certificate"));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(api.apiRequest).not.toHaveBeenCalled();
  });
  it("opens attachment management without sending when requested", async () => {
    queryClient.setQueryData(architectInvoiceKey(42), status);
    mount();
    fireEvent.click(screen.getByText("Send certificate"));
    await screen.findByTestId("architect-invoice-send-reminder");
    fireEvent.click(screen.getByText("Gérer la facture"));
    await screen.findByTestId("architect-invoice-section-42");
    expect(screen.queryByTestId("architect-invoice-send-reminder")).toBeNull();
    expect(vi.mocked(api.apiRequest).mock.calls.every(([method]) => method === "GET")).toBe(true);
    expect(screen.getByTestId("upload-architect-invoice-42").hasAttribute("disabled")).toBe(false);
  });
});

describe("attachment locking", () => {
  it("leaves a locked PDF viewable but disallows replacement and removal", () => {
    queryClient.setQueryData(architectInvoiceKey(42), {
      ...status, locked: true, attached: true, fileName: "honoraires.pdf",
      sentWithInvoice: true,
    });
    render(<QueryClientProvider client={queryClient}><ArchitectInvoiceSection certId={42} /></QueryClientProvider>);
    expect(screen.getByTestId("upload-architect-invoice-42").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("remove-architect-invoice-42").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Voir / télécharger").getAttribute("href")).toBe("/api/certificats/42/architect-invoice/pdf");
    expect(screen.getByText("Envoyé avec facture d’architecte")).toBeTruthy();
  });
});

describe("invoice status and PDF validation", () => {
  it("does not claim a legacy email contained or lacked an invoice", () => {
    expect(architectInvoiceDeliveryLabel({ ...status, historicalDeliveryUnknown: true })).toContain("inconnue");
    expect(architectInvoiceDeliveryLabel({ ...status, sentWithInvoice: true })).toContain("avec");
    expect(architectInvoiceDeliveryLabel({ ...status, sentWithInvoice: false })).toContain("sans");
    expect(architectInvoiceDeliveryLabel(status)).toBeNull();
  });
  it("allows PDFs up to 10 MiB and rejects invalid, empty or oversized files", () => {
    expect(validateArchitectInvoice({ name: "honoraires.PDF", type: "application/pdf", size: 10 * 1024 * 1024 })).toBeNull();
    expect(validateArchitectInvoice({ name: "honoraires.pdf", type: "", size: 2187 })).toBeNull();
    expect(validateArchitectInvoice({ name: "honoraires.exe", type: "", size: 2187 })).not.toBeNull();
    expect(validateArchitectInvoice({ name: "honoraires.pdf", type: "text/plain", size: 2187 })).not.toBeNull();
    expect(validateArchitectInvoice({ name: "honoraires.pdf", type: "application/pdf", size: 0 })).not.toBeNull();
    expect(validateArchitectInvoice({ name: "honoraires.pdf", type: "application/pdf", size: 10 * 1024 * 1024 + 1 })).not.toBeNull();
  });
});
