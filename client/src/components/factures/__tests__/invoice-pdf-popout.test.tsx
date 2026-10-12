// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { FacturesTab } from "../FacturesTab";
import { projectScopedKey, queryClient } from "@/lib/queryClient";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Invoice } from "@shared/schema";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/advisories/AdvisoriesList", () => ({ AdvisoriesList: () => null, AdvisoryBadge: () => null }));

const makeInvoice = (id: number) => ({
  id, devisId: 35, projectId: 12, contractorId: 7,
  invoiceNumber: `INV-${id}`, amountHt: "1000", amountTtc: "1200",
  tvaRate: "20", status: "draft", notes: "", pdfPath: "private/source.pdf",
  dateIssued: "2026-10-01", validationWarnings: [],
}) as unknown as Invoice;

function renderTab() {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <FacturesTab projectId="12" contractors={[]} onGoToIntake={vi.fn()} initialExpandedInvoiceId={41} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("invoice source PDF popout", () => {
  beforeEach(() => {
    queryClient.clear();
    sessionStorage.clear();
    queryClient.setQueryData(projectScopedKey(12, "invoices"), [makeInvoice(40), makeInvoice(41)]);
    queryClient.setQueryData(projectScopedKey(12, "devis"), []);
    queryClient.setQueryData(projectScopedKey(12, "certificat-invoice-links"), []);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    vi.spyOn(window, "open").mockReturnValue(null);
  });
  afterEach(() => {
    cleanup();
    queryClient.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens a nonmodal authenticated viewer and leaves extracted fields editable", async () => {
    renderTab();
    const field = await screen.findByTestId("input-draft-ht-41");
    await act(async () => { fireEvent.click(screen.getByTestId("button-view-pdf-facture-41")); });
    const viewer = screen.getByRole("dialog", { name: "PDF viewer for Facture INV-41" });
    expect(viewer).toHaveAttribute("aria-modal", "false");
    expect(screen.getByTestId("pdf-popout-iframe-invoice-41")).toHaveAttribute("src", "/api/invoices/41/pdf");
    expect(fetch).toHaveBeenCalledWith("/api/invoices/41/pdf", { method: "HEAD", credentials: "same-origin" });
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute("href", "/api/invoices/41/pdf");
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute("download", "facture-INV-41.pdf");
    fireEvent.change(field, { target: { value: "1127" } });
    expect(field).toHaveValue(1127);
    expect(viewer).toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close PDF viewer" }));
    expect(screen.queryByTestId("dialog-pdf-popout-invoice-41")).toBeNull();
    expect(field).toHaveValue(1127);
  });

  it("closes with Escape, restores focus, and can switch invoice sources", async () => {
    renderTab();
    const opener = screen.getByTestId("button-view-pdf-facture-41");
    opener.focus();
    fireEvent.click(opener);
    const viewer = screen.getByTestId("dialog-pdf-popout-invoice-41");
    await waitFor(() => expect(viewer).toHaveFocus());
    fireEvent.keyDown(viewer, { key: "Escape" });
    expect(screen.queryByTestId("dialog-pdf-popout-invoice-41")).toBeNull();
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByTestId("button-view-pdf-facture-40"));
    expect(screen.queryByTestId("dialog-pdf-popout-invoice-41")).toBeNull();
    expect(screen.getByTestId("pdf-popout-iframe-invoice-40")).toHaveAttribute("src", "/api/invoices/40/pdf");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("offers retry on access/load errors without opening a tab", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    renderTab();
    fireEvent.click(screen.getByTestId("button-view-pdf-facture-41"));
    expect(await screen.findByTestId("pdf-popout-error-invoice-41")).toHaveTextContent("403");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("pdf-popout-error-invoice-41")).toBeNull());
    expect(screen.getByTestId("pdf-popout-iframe-invoice-41")).toHaveAttribute("src", "/api/invoices/41/pdf");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("keeps Client PDF generation and its existing tab behavior unchanged", async () => {
    const generatedTab = { closed: false, location: { href: "" }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(generatedTab as unknown as Window);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, blob: async () => new Blob(["invoice + overview"], { type: "application/pdf" }),
    } as Response);
    const createObjectURL = vi.fn().mockReturnValue("blob:client-package");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    renderTab();
    await act(async () => { fireEvent.click(screen.getByTestId("button-client-package-facture-41")); });
    expect(fetch).toHaveBeenCalledWith("/api/invoices/41/pdf-with-overview");
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(generatedTab.location.href).toBe("blob:client-package");
    expect(screen.queryByTestId("dialog-pdf-popout-invoice-41")).toBeNull();
  });
});
