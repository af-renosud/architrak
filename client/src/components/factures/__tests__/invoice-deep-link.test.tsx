// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { FacturesTab } from "../FacturesTab";
import { projectScopedKey, queryClient } from "@/lib/queryClient";
import type { Invoice } from "@shared/schema";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/advisories/AdvisoriesList", () => ({ AdvisoriesList: () => null, AdvisoryBadge: () => null }));

function invoice(id: number): Invoice {
  return {
    id, devisId: 35, projectId: 12, contractorId: 7,
    invoiceNumber: `INV-${id}`, amountHt: "1000", amountTtc: "1200",
    tvaRate: "20", status: "draft", notes: "",
    dateIssued: "2026-10-01", validationWarnings: [],
  } as unknown as Invoice;
}

function tab(initialExpandedInvoiceId: number | null) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <FacturesTab projectId="12" contractors={[]} onGoToIntake={vi.fn()} initialExpandedInvoiceId={initialExpandedInvoiceId} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

describe("invoice destination selects the actual invoice", () => {
  beforeEach(() => {
    queryClient.clear();
    queryClient.setQueryData(projectScopedKey(12, "invoices"), [invoice(40), invoice(41)]);
    queryClient.setQueryData(projectScopedKey(12, "devis"), []);
    queryClient.setQueryData(projectScopedKey(12, "certificat-invoice-links"), []);
  });
  afterEach(() => { cleanup(); queryClient.clear(); });

  it("expands only the deep-linked draft and keeps existing collapse actions", async () => {
    render(tab(41));
    await waitFor(() => expect(screen.getByTestId("input-draft-ht-41")).toBeVisible());
    expect(screen.queryByTestId("input-draft-ht-40")).toBeNull();
    fireEvent.click(screen.getByTestId("row-facture-toggle-41"));
    expect(screen.queryByTestId("input-draft-ht-41")).toBeNull();
    // Cache refreshes do not force a manually collapsed destination open.
    await act(async () => { queryClient.setQueryData(projectScopedKey(12, "invoices"), [invoice(40), invoice(41)]); });
    expect(screen.queryByTestId("input-draft-ht-41")).toBeNull();
  });

  it("opens a changed invoice search parameter without remounting the project", async () => {
    const { rerender } = render(tab(41));
    await waitFor(() => expect(screen.getByTestId("input-draft-ht-41")).toBeVisible());
    rerender(tab(40));
    await waitFor(() => expect(screen.getByTestId("input-draft-ht-40")).toBeVisible());
    expect(screen.queryByTestId("input-draft-ht-41")).toBeNull();
  });

  it("waits for the invoice cache to receive the promoted target", async () => {
    queryClient.setQueryData(projectScopedKey(12, "invoices"), [invoice(40)]);
    render(tab(41));
    expect(screen.queryByTestId("input-draft-ht-41")).toBeNull();
    await act(async () => { queryClient.setQueryData(projectScopedKey(12, "invoices"), [invoice(40), invoice(41)]); });
    await waitFor(() => expect(screen.getByTestId("input-draft-ht-41")).toBeVisible());
  });

  it("does not expand an unrelated invoice for a nonexistent target", async () => {
    render(tab(999));
    expect(screen.queryByTestId("input-draft-ht-40")).toBeNull();
    expect(screen.queryByTestId("input-draft-ht-41")).toBeNull();
  });
});