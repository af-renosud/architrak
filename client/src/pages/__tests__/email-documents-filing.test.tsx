// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { EmailDocumentWithFiling } from "@shared/email-document-filing";
import EmailDocuments from "../email-documents";
import { queryClient } from "@/lib/queryClient";

vi.mock("@/components/layout/AppLayout", () => ({ AppLayout: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/intake/ManualPromotionDialog", () => ({ ManualPromotionDialog: () => null }));

function document(filing: Partial<EmailDocumentWithFiling["filing"]> = {}): EmailDocumentWithFiling {
  return {
    id: 898,
    attachmentFileName: "Devis n260309.pdf",
    extractionStatus: "completed",
    documentType: "quotation",
    projectId: 12,
    emailFrom: "contractor@example.test",
    emailSubject: "Project quotation",
    filing: {
      state: "processing",
      label: "Processing",
      reason: "Project intake analysis has not finished.",
      intakeId: 80,
      projectId: 12,
      promotedKind: null,
      promotedId: null,
      destination: { href: "/projets/12?tab=intake", label: "Open project intake" },
      isActive: true,
      ...filing,
    },
  } as EmailDocumentWithFiling;
}

function seed(doc: EmailDocumentWithFiling) {
  queryClient.setQueryData(["/api/email-documents"], [doc]);
  queryClient.setQueryData(["/api/projects"], [{ id: 12, name: "MASSEY1339" }]);
  queryClient.setQueryData(["/api/gmail/status"], { configured: false });
  queryClient.setQueryData(["/api/email-documents/settings/purge"], { purgeDays: 30 });
  queryClient.setQueryData(["/api/admin/email-documents/queue-stats"], { pending: 0, processing: 0 });
}

function renderPage() {
  return render(<QueryClientProvider client={queryClient}><EmailDocuments /></QueryClientProvider>);
}

describe("Email Documents extraction and destination", () => {
  beforeEach(() => {
    queryClient.clear();
    window.history.replaceState(null, "", "/documents");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(queryClient.getQueryData(["/api/email-documents"])), { status: 200 })));
  });
  afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); });

  it("shows Extracted separately from still-processing intake on the same row and dialog", async () => {
    seed(document());
    renderPage();
    const row = screen.getByTestId("card-email-doc-898");
    expect(within(row).getByText("EXTRACTED")).toBeVisible();
    expect(within(row).queryByText("COMPLETED")).toBeNull();
    expect(within(row).getByTestId("filing-status-row-898")).toHaveTextContent("Processing");
    expect(within(row).getByTestId("filing-destination-row-898")).toHaveAttribute("href", "/projets/12?tab=intake");
    fireEvent.click(within(row).getByTestId("button-view-doc-898"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("EXTRACTED")).toBeVisible();
    expect(within(dialog).getByTestId("filing-status-detail-898")).toHaveTextContent("Processing");
    expect(within(dialog).getByTestId("filing-reason-detail-898")).toHaveTextContent("analysis has not finished");
    expect(within(dialog).getByTestId("filing-destination-detail-898")).toHaveAttribute("href", "/projets/12?tab=intake");
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await act(async () => {
      queryClient.setQueryData(["/api/email-documents"], [document({
        state: "filed", label: "Added to project", reason: null, isActive: false,
        promotedKind: "devis", promotedId: 35,
        destination: { href: "/projets/12?devis=35", label: "Open devis" },
      })]);
    });
    await waitFor(() => expect(within(dialog).getByTestId("filing-status-detail-898")).toHaveTextContent("Added to project"));
    expect(within(row).getByTestId("filing-destination-row-898")).toHaveAttribute("href", "/projets/12?devis=35");
    expect(within(dialog).getByTestId("filing-destination-detail-898")).toHaveAttribute("href", "/projets/12?devis=35");
  });

  it.each([
    ["devis", 35, "/projets/12?devis=35", "Open devis"],
    ["invoice", 41, "/projets/12?tab=factures&invoice=41", "Open invoice"],
  ] as const)("opens the verified %s destination from row and dialog", async (kind, id, href, label) => {
    seed(document({
      state: "filed", label: "Added to project", reason: null, isActive: false,
      promotedKind: kind, promotedId: id, destination: { href, label },
    }));
    renderPage();
    const row = screen.getByTestId("card-email-doc-898");
    expect(within(row).getByTestId("filing-destination-row-898")).toHaveAttribute("href", href);
    fireEvent.click(within(row).getByTestId("button-view-doc-898"));
    expect(within(screen.getByRole("dialog")).getByTestId("filing-destination-detail-898")).toHaveAttribute("href", href);
    expect(screen.getByTestId("button-download-doc")).toBeVisible();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  });

  it.each([
    ["needs_review", "Needs review", "/projets/12?tab=intake"],
    ["duplicate", "Duplicate", "/projets/12?tab=intake"],
    ["failed", "Failed", "/projets/12?tab=intake"],
    ["removed", "Removed", null],
    ["not_filed", "Not filed", null],
    ["mismatch", "Filing mismatch", "/projets/12?tab=intake"],
  ] as const)("keeps %s reason and only the server-authorized action on both surfaces", async (state, label, href) => {
    seed(document({ state, label, reason: `Review reason: ${state}`, isActive: false, destination: href ? { href, label: "Open project intake" } : null }));
    renderPage();
    const row = screen.getByTestId("card-email-doc-898");
    expect(within(row).getByTestId("filing-status-row-898")).toHaveTextContent(label);
    fireEvent.click(within(row).getByTestId("button-view-doc-898"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("filing-status-detail-898")).toHaveTextContent(label);
    expect(within(dialog).getByTestId("filing-reason-detail-898")).toHaveTextContent(`Review reason: ${state}`);
    if (href) {
      expect(within(row).getByTestId("filing-destination-row-898")).toHaveAttribute("href", href);
      expect(within(dialog).getByTestId("filing-destination-detail-898")).toHaveAttribute("href", href);
    } else {
      expect(within(row).queryByTestId("filing-destination-row-898")).toBeNull();
      expect(within(dialog).queryByTestId("filing-destination-detail-898")).toBeNull();
    }
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  });
});