// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPopoutViewer } from "../PdfPopoutViewer";
import { TooltipProvider } from "@/components/ui/tooltip";

const translation = vi.hoisted(() => ({ status: "finalised" }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: translation }),
}));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("original document option", () => {
  it("switches both quotation preview and download to the untouched original", async () => {
    render(<TooltipProvider><PdfPopoutViewer devisId={42} devisCode="TEST-42" onClose={() => {}} /></TooltipProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/devis/42/pdf?variant=combined", expect.anything(),
    ));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Document version" }), { key: "ArrowDown" });
    const original = await screen.findByRole("option", { name: "Original document" });
    expect(original.closest("[role='listbox']")?.className).toContain("z-[70]");
    fireEvent.click(original);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/devis/42/pdf?variant=original", expect.anything(),
    ));
    expect(screen.getByTestId("button-pdf-download-42").getAttribute("href")).toBe("/api/devis/42/pdf?variant=original");
    await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toBe("/api/devis/42/pdf?variant=original"));
  });

  it("labels an invoice's source PDF as Original document and retains the raw download", async () => {
    render(<TooltipProvider><PdfPopoutViewer originalDocument devisCode="Facture F1"
      viewerId="invoice-7" pdfUrl="/api/invoices/7/pdf" downloadUrl="/api/invoices/7/pdf"
      onClose={() => {}} /></TooltipProvider>);
    expect(screen.getByRole("combobox", { name: "Document version" }).textContent).toContain("Original document");
    expect(screen.getByTestId("button-pdf-download-invoice-7").getAttribute("href")).toBe("/api/invoices/7/pdf");
    await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toBe("/api/invoices/7/pdf"));
  });
});
