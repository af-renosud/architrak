// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { FacturesTab, CreateMultiCertificatDialog } from "../FacturesTab";
import { projectScopedKey, queryClient } from "@/lib/queryClient";
import { TooltipProvider } from "@/components/ui/tooltip";
import { invoiceRequestConflict } from "@shared/invoice-request-guard";
import type { Invoice } from "@shared/schema";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/advisories/AdvisoriesList", () => ({ AdvisoriesList: () => null, AdvisoryBadge: () => null }));

const evidence = {
  documentType: "invoice", amountHt: 18237.45, amountTtc: 20061.2,
  tvaRate: 10, netAPayer: 6018.36,
  rawText: "FACTURE D'ACOMPTE DE 30% DU TOTAL TTC\nTVA 10%",
};

function invoice(id: number, status = "draft", safe = false): Invoice {
  return {
    id, devisId: 35, projectId: 12, contractorId: 7, invoiceNumber: `INV-${id}`,
    amountHt: safe ? "5471.24" : "18237.45", amountTtc: safe ? "6018.36" : "20061.20",
    status, aiExtractedData: evidence, notes: "", validationWarnings: [],
  } as Invoice;
}

function seed(invoices: Invoice[]) {
  queryClient.setQueryData(projectScopedKey(12, "invoices"), invoices);
}

function renderTab(expanded: number | null = 41, isArchived = false) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <FacturesTab projectId="12" contractors={[]} isArchived={isArchived} onGoToIntake={vi.fn()} initialExpandedInvoiceId={expanded} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function expectOnlyHistoryReads() {
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  for (const [url, options] of calls) {
    expect(url).toBe("/api/invoices/41/request-resolution-history");
    expect(options).toEqual(expect.objectContaining({ method: "GET", credentials: "include" }));
  }
}

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryData(projectScopedKey(12, "devis"), []);
  queryClient.setQueryData(projectScopedKey(12, "certificat-invoice-links"), []);
  queryClient.setQueryData(projectScopedKey(12, "certificat-payments"), []);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, options) => {
    if (url === "/api/invoices/41/request-resolution-history" && options?.method === "GET") {
      return { ok: true, json: async () => [] } as Response;
    }
    throw new Error("Unexpected request");
  }));
});
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); });

describe("invoice request safety", () => {
  it("offers existing-certificate linking alongside creation only on approved unlinked invoices", () => {
    seed([invoice(41, "approved", true), invoice(42, "pending", true), invoice(43, "approved", true)]);
    queryClient.setQueryData(projectScopedKey(12, "certificat-invoice-links"), [{ invoiceId: 43, certificatId: 72, certificateRef: "CP-072", certStatus: "issued" }]);
    renderTab(null);
    expect(screen.getByTestId("button-create-certificat-facture-41")).toBeEnabled();
    expect(screen.getByTestId("button-link-existing-certificate-41")).toBeEnabled();
    expect(screen.queryByTestId("button-link-existing-certificate-42")).toBeNull();
    expect(screen.queryByTestId("button-link-existing-certificate-43")).toBeNull();
    expect(screen.getByTestId("badge-certified-facture-43")).toHaveTextContent("Certifié");
  });

  it("blocks existing-certificate linking for archived projects using the existing guard", () => {
    seed([invoice(41, "approved", true)]);
    renderTab(null, true);
    const action = screen.getByTestId("button-link-existing-certificate-41");
    expect(action).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(action);
    expect(screen.queryByTestId("dialog-link-existing-certificate")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks existing-certificate linking when linked-certificate status is unavailable", () => {
    seed([invoice(41, "approved", true)]);
    queryClient.setQueryData(projectScopedKey(12, "certificat-invoice-links"), null);
    renderTab(null);
    const action = screen.getByTestId("button-link-existing-certificate-41");
    expect(action).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(action);
    expect(screen.queryByTestId("dialog-link-existing-certificate")).toBeNull();
  });

  it("blocks draft confirmation on candidate amounts, not a general review acknowledgement", async () => {
    const draft = { ...invoice(41), manualIntakeReviewRequired: true };
    seed([draft]);
    renderTab();
    const confirm = await screen.findByTestId("button-confirm-draft-41");
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(confirm);
    expect(screen.getByText("Before confirming this invoice")).toBeVisible();
    expectOnlyHistoryReads();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.getByTestId("conflict-draft-invoice-41")).toHaveTextContent(invoiceRequestConflict(draft)!);
    fireEvent.click(screen.getByTestId("checkbox-manual-invoice-review-41"));
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByTestId("button-apply-requested-deposit-41"));
    expect(screen.getByTestId("input-draft-ht-41")).toHaveValue(5471.24);
    expect(screen.getByTestId("input-draft-ttc-41")).toHaveValue(6018.36);
    expect(confirm).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByTestId("conflict-draft-invoice-41")).toBeNull();
    fireEvent.change(screen.getByTestId("input-draft-ht-41"), { target: { value: "18237.45" } });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expectOnlyHistoryReads();
  });

  it("keeps unresolved evidence blocked even after acknowledging review", async () => {
    seed([{ ...invoice(41), aiExtractedData: { ...evidence, netAPayer: 7018.36 }, manualIntakeReviewRequired: true }]);
    renderTab();
    const confirm = await screen.findByTestId("button-confirm-draft-41");
    fireEvent.click(screen.getByTestId("checkbox-manual-invoice-review-41"));
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(confirm);
    expectOnlyHistoryReads();
    expect(screen.getByTestId("conflict-draft-invoice-41")).toHaveTextContent("A general review acknowledgement does not resolve this conflict.");
    expect(screen.queryByTestId("button-apply-requested-deposit-41")).toBeNull();
  });

  it("shows the complete conflict on collapsed pending rows and blocks approval without blocking reopen", async () => {
    const pending = invoice(41, "pending");
    seed([invoice(40, "pending"), pending]);
    renderTab(null);
    expect(screen.getByTestId("conflict-invoice-41")).toHaveTextContent(invoiceRequestConflict(pending)!);
    expect(screen.queryByTestId("request-resolution-history-41")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("row-facture-toggle-41"));
    expect(await screen.findByTestId("button-approve-invoice-41")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByTestId("button-approve-invoice-41"));
    expect(screen.getByText("Before approving this invoice")).toBeVisible();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.getByTestId("button-reopen-review-invoice-41")).toBeEnabled();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expectOnlyHistoryReads();
    expect(screen.queryByTestId("request-resolution-history-40")).toBeNull();
    fireEvent.click(screen.getByTestId("row-facture-toggle-41"));
    expect(screen.queryByTestId("request-resolution-history-41")).toBeNull();
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/invoices", 41, "request-resolution-history"] });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expectOnlyHistoryReads();
  });

  it("blocks single creation and selection, including a selection that becomes conflicting after refresh", async () => {
    seed([invoice(40, "approved", true), invoice(41, "approved", true)]);
    renderTab(null);
    fireEvent.click(screen.getByTestId("checkbox-select-facture-40"));
    fireEvent.click(screen.getByTestId("checkbox-select-facture-41"));
    expect(screen.getByTestId("button-create-certificat-multi")).toBeEnabled();
    await act(async () => { seed([invoice(40, "approved", true), invoice(41, "approved")]); });
    await waitFor(() => expect(screen.getByTestId("button-create-certificat-multi")).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByTestId("button-create-certificat-facture-41")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("checkbox-select-facture-41")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByTestId("button-create-certificat-multi"));
    expect(screen.queryByTestId("dialog-create-certificat-multi")).toBeNull();
    expect(screen.getByTestId("conflict-invoice-41")).toHaveTextContent("Full quotation totals are reference information");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("guards the exported grouped dialog independently of selection controls", () => {
    const conflicting = invoice(41, "approved");
    render(
      <QueryClientProvider client={queryClient}>
        <CreateMultiCertificatDialog invoices={[invoice(40, "approved", true), conflicting]} contractorName="Atelier Pierre" contractorIban="FR761234" projectId="12" onClose={vi.fn()} onCreated={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("button-confirm-create-certificat-multi")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByTestId("button-confirm-create-certificat-multi"));
    expect(screen.getByText("Before creating this grouped certificate")).toBeVisible();
    expect(screen.getByTestId("conflict-create-certificat-multi-41")).toHaveTextContent(invoiceRequestConflict(conflicting)!);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not introduce a block for ordinary invoices or already-paid deductions", async () => {
    seed([{ ...invoice(41, "pending"), aiExtractedData: { ...evidence, acomptePaidAmountTtc: 6018.36 } }]);
    renderTab();
    expect(await screen.findByTestId("button-approve-invoice-41")).toBeEnabled();
    expect(screen.queryByTestId("conflict-invoice-41")).toBeNull();
    expect(invoiceRequestConflict({ ...invoice(42), aiExtractedData: { documentType: "invoice", amountHt: 100, amountTtc: 120 } })).toBeNull();
  });
});
