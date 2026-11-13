// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiRequest, ApiError } from "@/lib/queryClient";
import type { CarryForwardPreview, CarryLine } from "@shared/quotation-carry-forward";
import { QuotationCarryForwardPanel } from "../QuotationCarryForwardPanel";
import { suggestedCarrySelection } from "../use-quotation-carry-forward";
import { ReplaceQuotationDialog } from "../ReplaceQuotationDialog";
import { QuotationReplacementHistory } from "../QuotationReplacementHistory";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", async original => ({ ...await original<typeof import("@/lib/queryClient")>(), apiRequest: vi.fn() }));
const request = vi.mocked(apiRequest);
const close = vi.fn();
const doc = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Keep brass finish", marks: [{ type: "bold" as const }, { type: "link" as const, attrs: { href: "https://example.com/spec" } }] }] }, { type: "image" as const, attrs: { assetId: 61, size: "large" as const, alt: "Finish sample" } }] };
function line(id: number, overrides: Partial<CarryLine> = {}): CarryLine {
  return { id, lineNumber: id, description: `Joinery ${id}`, quantity: "2.5", unit: "m²", unitPriceHt: "147.80", totalHt: "369.50", translation: null, context: null, imageCount: 0, suggestedTargetId: null, ...overrides };
}
let preview: CarryForwardPreview;
const source = { id: 12, devisCode: "LOT-04-A", devisNumber: null, descriptionFr: "Menuiserie", contractorId: 7, contractorName: "Atelier Martin", amountHt: "12480", amountTtc: "14976", signed: true, version: "source-token", blockedReason: null };
const target = { ...source, id: 19, devisCode: "LOT-04-B", signed: false, version: "target-token" };
const options = { source, candidates: [target], impact: { invoices: 2, situations: 1, marcheDocuments: 0, certificates: 1, payments: 2 }, impactVersion: "impact-token", blockedReason: null };

function wrap(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>);
}
function Panel() {
  const [selection, setSelection] = useState(suggestedCarrySelection(preview));
  return <QuotationCarryForwardPanel preview={preview} selection={selection} onChange={setSelection} />;
}
async function selectReplacement() {
  wrap(<ReplaceQuotationDialog devisId={12} projectId="4" localBlockedReason={null} onClose={close} />);
  fireEvent.click(await screen.findByTestId("replacement-select"));
  fireEvent.click(await screen.findByRole("option", { name: /LOT-04-B/ }));
  fireEvent.change(screen.getByLabelText("Internal context (required)"), { target: { value: "Revision after site inspection" } });
  fireEvent.click(screen.getByTestId("button-retain-previous-work"));
}

beforeEach(() => {
  vi.clearAllMocks();
  preview = {
    version: "work-token", sourceId: 12, targetId: 19, blockedReason: null,
    setup: [{ key: "devisCode", label: "Quotation code", from: "LOT-04-A", to: "LOT-04-C", available: true }],
    header: { source: "Original header", target: "", available: true },
    supportingPdfs: [{ id: 8, label: "Specification", fileName: "joinery.pdf", alreadyPresent: false }],
    sourceLines: [line(1, { description: "Original cabinet", translation: "Cabinet", context: doc, imageCount: 1, suggestedTargetId: 11 }), line(2, { translation: "Changed skirting", context: doc, imageCount: 1 })],
    targetLines: [line(11, { description: "Original cabinet" }), line(12, { description: "Revised skirting", quantity: "3.7", translation: "Existing target translation" }), line(13, { context: doc, imageCount: 1 })],
  };
  request.mockImplementation(async (_method, url) => ({ json: async () => url.includes("carry-forward") ? preview : options }) as Response);
});
afterEach(cleanup);

describe("quotation carry-forward", () => {
  it("defaults only server suggestions and protects context and translation independently", () => {
    preview.targetLines[0].context = doc;
    const selection = suggestedCarrySelection(preview);
    expect(selection.lines).toEqual([{ sourceLineId: 1, targetLineId: 11, context: false, translation: true }]);
    expect(selection.setup).toEqual([]);
    expect(selection.header).toBe(false);
    expect(selection.supportingPdfIds).toEqual([]);
  });

  it("renders full owned rich context and exact proposed setup, and requires explicit changed-row choices", () => {
    wrap(<Panel />);
    const row = within(screen.getByTestId("carry-source-line-2"));
    expect(row.getByRole("link", { name: "Keep brass finish" })).toHaveAttribute("href", "https://example.com/spec");
    expect(row.getByText("Keep brass finish").closest("strong")).not.toBeNull();
    expect(row.getByAltText("Finish sample")).toHaveAttribute("src", "/api/devis/12/context-assets/61");
    expect(row.getByAltText("Finish sample")).toHaveAttribute("width", "480");
    expect(screen.getByText("LOT-04-C")).toBeVisible();
    fireEvent.change(row.getByRole("combobox"), { target: { value: "12" } });
    expect(row.getByText("Revised skirting")).toBeVisible();
    expect(row.getByText(/Quantity 3.7/)).toBeVisible();
    expect(row.getByRole("checkbox", { name: /Copy context/ })).not.toBeChecked();
    expect(row.getByRole("checkbox", { name: /Copy translation/ })).toBeDisabled();
    fireEvent.click(row.getByRole("checkbox", { name: /Copy context/ }));
    expect(row.getByRole("checkbox", { name: /Copy context/ })).toBeChecked();
    expect(within(row.getByRole("combobox")).getByRole("option", { name: /Line 11/ })).toBeDisabled();
    fireEvent.change(row.getByRole("combobox"), { target: { value: "13" } });
    expect(row.getByRole("checkbox", { name: /Copy context/ })).toBeDisabled();
    expect(row.getByRole("checkbox", { name: /Copy context/ })).not.toBeChecked();
    expect(row.getByRole("checkbox", { name: /Copy translation/ })).toBeEnabled();
    expect(row.getByRole("checkbox", { name: /Copy translation/ })).not.toBeChecked();
  });

  it("submits version-bound work only after retain, review and confirmation", async () => {
    await selectReplacement();
    await screen.findByTestId("quotation-carry-forward-panel");
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText(/Quotation code/));
    fireEvent.click(screen.getByLabelText(/Copy source header/));
    fireEvent.click(screen.getByLabelText(/Specification/));
    fireEvent.click(screen.getByTestId("button-review-replacement"));
    expect(screen.getByText("Confirm quotation replacement")).toBeVisible();
    expect(screen.getByLabelText(/Copy source header/)).toBeDisabled();
    fireEvent.click(screen.getByTestId("button-confirm-mark-replaced"));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/devis/12/mark-replaced", expect.objectContaining({
      sourceVersion: "source-token", targetVersion: "target-token", impactVersion: "impact-token",
      carryForward: { version: "work-token", setup: ["devisCode"], header: true, supportingPdfIds: [8], lines: [{ sourceLineId: 1, targetLineId: 11, context: true, translation: true }] },
    })));
  });

  it("requires retry or explicit no-copy on fetch failure and never silently skips", async () => {
    request.mockImplementation(async (_method, url) => {
      if (url.includes("carry-forward")) throw new Error("Connection lost");
      return { json: async () => options } as Response;
    });
    await selectReplacement();
    await screen.findByText(/Previous work could not be loaded/);
    expect(screen.getByTestId("button-review-replacement")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading previous work" }));
    await waitFor(() => expect(request.mock.calls.filter(([, url]) => url.includes("carry-forward"))).toHaveLength(2));
    fireEvent.click(screen.getByLabelText(/Proceed without copying previous work/));
    fireEvent.click(screen.getByTestId("button-review-replacement"));
    fireEvent.click(screen.getByTestId("button-confirm-mark-replaced"));
    await waitFor(() => expect(close).toHaveBeenCalled());
    const body = request.mock.calls.find(([method]) => method === "POST")?.[2];
    expect(body).not.toHaveProperty("carryForward");
  });

  it("blocks copying but still permits explicitly replacing without it", async () => {
    preview.blockedReason = "Replacement is locked for editing.";
    await selectReplacement();
    await screen.findByText(/Copying is unavailable/);
    expect(screen.getByLabelText(/Copy source header/)).toBeDisabled();
    expect(screen.getByTestId("button-review-replacement")).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Proceed without copying previous work/));
    expect(screen.getByTestId("button-review-replacement")).toBeEnabled();
  });

  it.each([12, 19])("opens recovery from history on quotation %s and resets stale recovery selections", async devisId => {
    const entries = [{ id: 1, oldDevisId: 12, newDevisId: 19, oldLabel: "LOT-04-A", newLabel: "LOT-04-B", note: "Revised", actorName: "Camille", createdAt: "2026-06-12T10:12:00Z" }];
    request.mockImplementation(async (method, url) => {
      if (method === "POST") {
        preview = { ...preview, version: "updated-work-token" };
        throw new ApiError(409, "Stale work", {});
      }
      return { json: async () => url.includes("carry-forward") ? preview : options } as Response;
    });
    wrap(<QuotationReplacementHistory entries={entries} devisId={devisId} projectId="4" />);
    fireEvent.click(screen.getByRole("button", { name: "Review previous work" }));
    await screen.findByTestId("quotation-carry-forward-panel");
    fireEvent.click(screen.getByRole("button", { name: "Review selected work" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm carry-forward" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/devis/12/carry-forward", {
      targetId: 19, selection: expect.objectContaining({ version: "work-token" }),
    }));
    await screen.findByText(/Stale selections were cleared/);
    expect(screen.queryByRole("button", { name: "Confirm carry-forward" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Review selected work" })).toBeEnabled());
  });
});
