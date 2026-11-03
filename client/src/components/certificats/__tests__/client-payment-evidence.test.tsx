// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Certificat } from "@shared/schema";
import { CertificatPaymentsSection } from "../CertificatDetailDialog";
import { InvoicePaymentDialog } from "../InvoicePaymentDialog";
import { apiRequest, invalidateCertificatPaymentData } from "@/lib/queryClient";
import { allocationsMatch, evidenceFileError } from "@/hooks/use-certificat-payment-context";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", async (original) => ({
  ...await original<typeof import("@/lib/queryClient")>(),
  apiRequest: vi.fn(),
  invalidateCertificatPaymentData: vi.fn(),
}));
vi.mock("@/components/devis/PdfPopoutViewer", () => ({
  PdfPopoutViewer: ({ pdfUrl }: { pdfUrl: string }) => <div data-testid="proof-popout">{pdfUrl}</div>,
}));

const cert = { id: 17, projectId: 4, status: "issued", netToPayTtc: "912.48", certificateRef: "CP-017" } as Certificat;
const payment = { id: 28, certificatId: 17, amount: "214.37", datePaid: "2026-06-12", method: "virement", note: "Premier versement", reference: "VIR-28", invoiceAllocations: [{ invoiceId: 9, amount: "214.37" }], evidenceFileName: null };
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(["/api/certificats", "17", "payment-context"], { cert, archived: false, invoices: [{ id: 9, invoiceNumber: "F-009", amountTtc: "912.48" }] });
  client.setQueryData(["/api/certificats", "17", "payments"], { payments: [payment], paidToDate: 214.37, outstanding: 698.11, fullyPaid: false, overpaid: false });
  client.setQueryData(["/api/certificats", "17", "payment-suggestions"], []);
});
afterEach(() => { cleanup(); client.clear(); });
function mount(initialInvoiceId?: number) {
  return render(<QueryClientProvider client={client}><CertificatPaymentsSection cert={cert} initialInvoiceId={initialInvoiceId} /></QueryClientProvider>);
}
function fillPayment() {
  fireEvent.click(screen.getByTestId("button-log-payment"));
  fireEvent.change(screen.getByTestId("input-payment-amount"), { target: { value: "137.29" } });
  fireEvent.change(screen.getByTestId("input-payment-note"), { target: { value: "Acompte déclaré par le client" } });
}

describe("shared client-payment evidence", () => {
  it("creates payment and PDF atomically, defaults single-invoice allocation and preserves request ID/file after failure", async () => {
    const api = vi.mocked(apiRequest);
    api.mockRejectedValueOnce(new Error("Réseau indisponible")).mockResolvedValueOnce(new Response(JSON.stringify({ fullyPaid: false })));
    mount();
    fillPayment();
    const pdf = new File(["%PDF"], "virement.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("input-payment-evidence"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByTestId("button-save-payment"));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByTestId("button-save-payment") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText(/virement.pdf — conservé/)).toBeTruthy();
    const first = api.mock.calls[0][2] as FormData;
    const payload = JSON.parse(String(first.get("data")));
    expect(first.get("file")).toBe(pdf);
    expect(payload).toMatchObject({ amount: "137.29", note: "Acompte déclaré par le client", invoiceAllocations: [{ invoiceId: 9, amount: "137.29" }] });
    expect(payload.requestId).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-save-payment"));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((api.mock.calls[1][2] as FormData).get("data"))).requestId).toBe(payload.requestId);
    await waitFor(() => expect(screen.queryByTestId("form-payment")).toBeNull());
    expect(invalidateCertificatPaymentData).toHaveBeenCalled();
  });

  it.each(["draft", "superseded", "archived"])("refuses changes for %s and explains why", (status) => {
    client.setQueryData(["/api/certificats", "17", "payment-context"], { cert: { ...cert, status }, archived: status === "archived", invoices: [] });
    mount();
    expect(screen.getByTestId("button-log-payment").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByTestId("button-log-payment"));
    expect(screen.queryByTestId("form-payment")).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBeTruthy();
    expect(screen.queryByTestId("button-add-payment-evidence-28")).toBeNull();
    expect(screen.queryByTestId("button-edit-payment-28")).toBeNull();
  });

  it("blocks an issued certificate when its project is archived", () => {
    client.setQueryData(["/api/certificats", "17", "payment-context"], { cert, archived: true, invoices: [] });
    mount();
    expect(screen.getByTestId("button-log-payment").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("archivé");
    expect(screen.queryByTestId("button-add-payment-evidence-28")).toBeNull();
  });

  it("creates without evidence or guessed invoice links when context has no sources", async () => {
    client.setQueryData(["/api/certificats", "17", "payment-context"], { cert, archived: false, invoices: [] });
    vi.mocked(apiRequest).mockResolvedValueOnce(new Response(JSON.stringify({ fullyPaid: false })));
    mount(9);
    fillPayment();
    fireEvent.click(screen.getByTestId("button-save-payment"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1));
    const data = vi.mocked(apiRequest).mock.calls[0][2] as FormData;
    expect(data.get("file")).toBeNull();
    expect(JSON.parse(String(data.get("data"))).invoiceAllocations).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId("form-payment")).toBeNull());
  });

  it("includes updated allocations in a monetary PATCH without issuing a second evidence request", async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce(new Response(JSON.stringify({ fullyPaid: false })));
    mount();
    fireEvent.click(screen.getByTestId("button-edit-payment-28"));
    fireEvent.change(screen.getByTestId("input-payment-amount"), { target: { value: "193.42" } });
    fireEvent.change(screen.getByTestId("input-payment-note"), { target: { value: "Montant corrigé" } });
    expect(screen.queryByTestId("input-payment-evidence")).toBeNull();
    fireEvent.click(screen.getByTestId("button-save-payment"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1));
    const [method, url, body] = vi.mocked(apiRequest).mock.calls[0];
    expect([method, url]).toEqual(["PATCH", "/api/certificat-payments/28"]);
    expect(body).toMatchObject({ amount: "193.42", note: "Montant corrigé", invoiceAllocations: [{ invoiceId: 9, amount: "193.42" }] });
    await waitFor(() => expect(screen.queryByTestId("form-payment")).toBeNull());
  });

  it("accepts late proof on fully-paid ledger, retains failed upload for retry, and does not send a monetary mutation", async () => {
    client.setQueryData(["/api/certificats", "17", "payments"], { payments: [payment], paidToDate: 912.48, outstanding: 0, fullyPaid: true, overpaid: false });
    const api = vi.mocked(apiRequest);
    api.mockRejectedValueOnce(new Error("Le justificatif n'a pas été enregistré")).mockResolvedValueOnce(new Response(JSON.stringify({ ...payment, evidenceFileName: "preuve.pdf" })));
    mount();
    expect(screen.queryByTestId("button-edit-payment-28")).toBeNull();
    fireEvent.click(screen.getByTestId("button-add-payment-evidence-28"));
    const pdf = new File(["%PDF"], "preuve.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Justificatif PDF du paiement existant"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter le justificatif" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Justificatif PDF du paiement existant") as HTMLInputElement).files?.[0]).toBe(pdf);
    fireEvent.click(screen.getByRole("button", { name: "Ajouter le justificatif" }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(api.mock.calls[1].slice(0, 2)).toEqual(["POST", "/api/certificat-payments/28/evidence"]);
    expect((api.mock.calls[1][2] as FormData).get("file")).toBe(pdf);
    await waitFor(() => expect(screen.queryByTestId("form-payment-evidence")).toBeNull());
  });

  it("requires exact multi-invoice allocations and preselects the originating invoice in the shared dialog", () => {
    client.setQueryData(["/api/certificats", "17", "payment-context"], { cert, archived: false, invoices: [{ id: 9, invoiceNumber: "F-009", amountTtc: "612.48" }, { id: 10, invoiceNumber: "F-010", amountTtc: "300" }] });
    render(<QueryClientProvider client={client}><InvoicePaymentDialog certificatId={17} invoiceId={9} invoiceNumber="F-009" onClose={vi.fn()} /></QueryClientProvider>);
    fillPayment();
    expect((screen.getByLabelText("Affectation facture F-009") as HTMLInputElement).value).toBe("137.29");
    fireEvent.change(screen.getByLabelText("Affectation facture F-010"), { target: { value: "20" } });
    expect(screen.getByTestId("button-save-payment").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByTestId("button-save-payment"));
    expect(apiRequest).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Affectation facture F-009"), { target: { value: "117.29" } });
    expect(screen.getByTestId("button-save-payment").getAttribute("aria-disabled")).toBeNull();
  });

  it("opens active and deleted evidence using the in-app viewer and displays audit notes", () => {
    client.setQueryData(["/api/certificats", "17", "payments"], { payments: [{ ...payment, evidenceFileName: "actuel.pdf" }], audits: [{ id: 4, paymentId: 23, action: "deleted", createdAt: "2026-06-11", snapshot: { ...payment, note: "Doublon retiré", evidenceFileName: "ancien.pdf" } }], fullyPaid: false, paidToDate: 214.37, outstanding: 698.11 });
    const open = vi.spyOn(window, "open");
    mount();
    fireEvent.click(screen.getByTestId("button-payment-evidence-28"));
    expect(screen.getByTestId("proof-popout").textContent).toBe("/api/certificat-payments/28/evidence");
    fireEvent.click(screen.getByRole("button", { name: /Justificatif conservé/ }));
    expect(screen.getByTestId("proof-popout").textContent).toBe("/api/certificat-payments/23/evidence");
    expect(screen.getByText("Doublon retiré")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("validates PDF type/size and monetary allocation cents", () => {
    expect(evidenceFileError(new File(["not pdf"], "note.txt", { type: "text/plain" }))).toBeTruthy();
    const oversized = new File(["%PDF"], "large.pdf", { type: "application/pdf" });
    Object.defineProperty(oversized, "size", { value: 10 * 1024 * 1024 + 1 });
    expect(evidenceFileError(oversized)).toBeTruthy();
    expect(allocationsMatch("0.30", [{ amount: "0.10" }, { amount: "0.20" }])).toBe(true);
    expect(allocationsMatch("0.30", [{ amount: "0.29" }])).toBe(false);
  });
});
