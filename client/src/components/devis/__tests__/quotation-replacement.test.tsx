// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReplacementOptions } from "@shared/quotation-replacement";
import type { Devis } from "@shared/schema";
import { ApiError, apiRequest, queryClient } from "@/lib/queryClient";
import { ReplaceQuotationDialog } from "../ReplaceQuotationDialog";
import { QuotationReplacementHistory } from "../QuotationReplacementHistory";
import { replacementBlockedReason } from "../use-quotation-replacement";
import { hasPreparedReplacement } from "../use-prepared-quotation-replacement";
import type { ExtractionReviewResponse } from "../use-quotation-extraction-review";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/queryClient")>(),
  apiRequest: vi.fn(),
}));

const source = {
  id: 12, devisCode: "LOT-04-A", devisNumber: "2026-18", descriptionFr: "Menuiseries intérieures",
  contractorId: 7, contractorName: "Atelier Martin", amountHt: "12480", amountTtc: "14976",
  signed: true, version: "opaque-old", blockedReason: null,
};
const candidate = { ...source, id: 19, devisCode: "LOT-04-B", signed: false, version: "opaque-new" };
let data: ReplacementOptions;
const request = vi.mocked(apiRequest);
const close = vi.fn();

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ReplaceQuotationDialog devisId={12} projectId="4" localBlockedReason={null} onClose={close} /></QueryClientProvider>);
}
async function choose() {
  await screen.findByTestId("replacement-select");
  fireEvent.click(screen.getByTestId("replacement-select"));
  fireEvent.click(await screen.findByRole("option", { name: /LOT-04-B/ }));
  await waitFor(() => expect(screen.queryByLabelText("Loading prepared extraction")).not.toBeInTheDocument());
}
async function review() {
  await choose();
  fireEvent.change(screen.getByLabelText("Internal context (required)"), { target: { value: "Revised scope agreed at site meeting." } });
  fireEvent.click(screen.getByTestId("button-retain-previous-work"));
  await waitFor(() => expect(screen.getByTestId("button-review-replacement")).toBeEnabled());
  fireEvent.click(screen.getByTestId("button-review-replacement"));
}

const emptyCarry = { version: "carry-v1", sourceId: 12, targetId: 19, blockedReason: null, setup: [], sourceLines: [], targetLines: [], header: { source: "", target: "", available: false }, supportingPdfs: [] };

beforeEach(() => {
  vi.clearAllMocks();
  data = { source, candidates: [candidate], impact: { invoices: 2, situations: 1, marcheDocuments: 1, certificates: 3, payments: 2 }, impactVersion: "opaque-impact", blockedReason: null };
  request.mockImplementation(async (_method, url) => ({ json: async () => url.includes("carry-forward") ? emptyCarry : data }) as Response);
});
afterEach(cleanup);

const prepared: ExtractionReviewResponse = {
  candidateAttemptId: 81, humanWorkingVersion: false, events: [],
  sourcePdfUrl: "/api/devis/19/pdf",
  evidence: {
    totalHt: 12480, totalTtc: 14976,
    quotationVerification: {
      proposedLineItems: [{ description: "Porte acoustique complète", quantity: 2, totalHt: 274.5 }],
      initialComparison: [{ initialText: "Porte", sourceText: "Porte acoustique complète" }],
      sourceFindings: { verified: true },
    },
  },
};

function mockPrepared(value = prepared, postError?: Error) {
  request.mockImplementation(async (method, url) => {
    if (method === "POST" && postError) throw postError;
    return { json: async () => url.endsWith("extraction-review") ? value
      : url.includes("carry-forward") ? emptyCarry : data } as Response;
  });
}

async function preparedReview() {
  await choose();
  fireEvent.change(screen.getByLabelText("Internal context (required)"), { target: { value: "Revised scope agreed at site meeting." } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Approve prepared extraction and replace together/ }));
  fireEvent.click(screen.getByTestId("button-retain-previous-work"));
  expect(screen.getByTestId("button-review-replacement")).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the original source PDF/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm the proposed re-extraction/ }));
  fireEvent.change(screen.getByLabelText(/Candidate approval reason/), { target: { value: "Original page two confirms each proposed row." } });
}

describe("prepared extraction and atomic replacement", () => {
  it("requires both declarations and a trimmed reason, then sends only the atomic request", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mockPrepared();
    mount();
    await preparedReview();
    expect(screen.getByText(/1 proposed rows/)).toBeInTheDocument();
    expect(screen.getByText("12480")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open original contractor PDF" })).toHaveAttribute("href", "/api/devis/19/pdf?variant=original");
    fireEvent.change(screen.getByLabelText(/Candidate approval reason/), { target: { value: "            " } });
    expect(screen.getByTestId("button-review-replacement")).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Candidate approval reason/), { target: { value: "Original page two confirms each proposed row." } });
    fireEvent.click(screen.getByTestId("button-review-replacement"));
    expect(screen.getByText("Confirm quotation replacement")).toBeInTheDocument();
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("button-confirm-mark-replaced"));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("POST", "/api/devis/12/mark-replaced", {
      replacementDevisId: 19, note: "Revised scope agreed at site meeting.",
      sourceVersion: "opaque-old", targetVersion: "opaque-new", impactVersion: "opaque-impact",
      differentContractorAcknowledged: false,
      preparedExtraction: { attemptId: 81, reason: "Original page two confirms each proposed row.", reviewedOriginal: true, initialDifferencesAreOcrErrors: true },
    });
    expect(request.mock.calls.some(([, url]) => url.includes("carry-forward"))).toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/devis/12/extraction-review"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/devis/19/extraction-review"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/extraction-review/summary"] });
    expect(invalidate.mock.calls.some(([filter]) => filter?.predicate != null)).toBe(true);
    invalidate.mockRestore();
  });

  it.each([409, 422, 500])("keeps selection, note, declarations and reason after a %s rejection", async status => {
    mockPrepared(prepared, new ApiError(status, "Atomic replacement rejected", {}));
    mount();
    await preparedReview();
    fireEvent.click(screen.getByTestId("button-review-replacement"));
    fireEvent.click(screen.getByTestId("button-confirm-mark-replaced"));
    await screen.findByText(/Neither quotation was changed/);
    expect(close).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("button-review-replacement")).toBeEnabled());
    expect(screen.getByLabelText(/Candidate approval reason/)).toHaveValue("Original page two confirms each proposed row.");
    expect(screen.getByRole("checkbox", { name: /I have reviewed the original source PDF/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /I confirm the proposed re-extraction/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Back to selection" }));
    expect(screen.getByTestId("replacement-select")).toHaveTextContent("LOT-04-B");
    expect(screen.getByLabelText("Internal context (required)")).toHaveValue("Revised scope agreed at site meeting.");
  });

  it("never offers candidate approval over a human working version", async () => {
    mockPrepared({ ...prepared, humanWorkingVersion: true });
    mount();
    await choose();
    expect(screen.queryByRole("checkbox", { name: /Approve prepared extraction/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("button-retain-previous-work")).toHaveTextContent("Continue to previous work");
  });

  it("does not allow approval when proposed rows are missing", async () => {
    mockPrepared({ ...prepared, evidence: {} });
    mount();
    await choose();
    fireEvent.change(screen.getByLabelText("Internal context (required)"), { target: { value: "Scope revision." } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve prepared extraction and replace together/ }));
    fireEvent.click(screen.getByTestId("button-retain-previous-work"));
    expect(screen.getByText(/Proposed rows are unavailable/)).toBeInTheDocument();
    expect(screen.getByTestId("button-review-replacement")).toBeDisabled();
  });

  it.each(["", "javascript:alert(1)", "https://foreign.example/pdf"])("blocks approval without a safe source PDF: %s", async sourcePdfUrl => {
    mockPrepared({ ...prepared, sourcePdfUrl });
    mount();
    await choose();
    fireEvent.change(screen.getByLabelText("Internal context (required)"), { target: { value: "Scope revision." } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve prepared extraction and replace together/ }));
    fireEvent.click(screen.getByTestId("button-retain-previous-work"));
    expect(screen.getByText(/Source PDF link unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /I have reviewed/ })).toBeDisabled();
    expect(screen.getByTestId("button-review-replacement")).toBeDisabled();
  });

  it("requires a positive safe integer candidate attempt and no human working version", () => {
    for (const candidateAttemptId of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(hasPreparedReplacement({ ...prepared, candidateAttemptId })).toBe(false);
    }
    expect(hasPreparedReplacement(prepared)).toBe(true);
    expect(hasPreparedReplacement(undefined)).toBe(false);
  });
});

describe("quotation replacement", () => {
  it.each(["created", "draft", "pending", "sent", "viewed", "queried", "partially_signed"])("blocks an in-flight %s signature locally", status => {
    const devis = { status: "pending", accountingState: "active", signOffStage: "received", archisignEnvelopeStatus: status } as Devis;
    expect(replacementBlockedReason(devis, false)).toMatch(/signature request is in flight/);
  });

  it("never preselects a quotation and requires a nonblank internal note", async () => {
    mount();
    await screen.findByTestId("replacement-select");
    expect(screen.getByTestId("replacement-select")).toHaveTextContent("Search processed quotations");
    expect(screen.getByTestId("button-retain-previous-work")).toBeDisabled();
    await choose();
    expect(screen.getByTestId("button-retain-previous-work")).toBeDisabled();
    const note = screen.getByLabelText("Internal context (required)");
    expect(note).toHaveAttribute("maxlength", "2000");
    fireEvent.change(note, { target: { value: "   " } });
    expect(screen.getByTestId("button-retain-previous-work")).toBeDisabled();
    fireEvent.change(note, { target: { value: "Revised scope." } });
    expect(screen.getByTestId("button-retain-previous-work")).toBeEnabled();
  });

  it("searches by contractor and shows a composed no-match state", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("replacement-select"));
    fireEvent.change(screen.getByLabelText("Search processed quotations"), { target: { value: "unknown supplier" } });
    expect(screen.getByText("No quotations match your search.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search processed quotations"), { target: { value: "Atelier Martin" } });
    expect(screen.getByRole("option", { name: /LOT-04-B/ })).toBeInTheDocument();
  });

  it("reviews old → new and cancels without saving", async () => {
    mount();
    await review();
    expect(screen.getByText("Confirm quotation replacement")).toBeInTheDocument();
    expect(screen.getByText(/Prior signatures, documents and payments remain/)).toHaveTextContent("a new unsigned quotation is not committed");
    expect(screen.getByText("Marché documents")).toBeInTheDocument();
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(0);
  });

  it("explains how to obtain a replacement when candidates are empty", async () => {
    data.candidates = [];
    mount();
    expect(await screen.findByTestId("replacement-empty")).toHaveTextContent("Upload and process the revised PDF");
    expect(screen.getByTestId("button-retain-previous-work")).toBeDisabled();
  });

  it("requires acknowledgement for a different contractor", async () => {
    data.candidates = [{ ...candidate, contractorId: 11, contractorName: "Maison Roussel" }];
    mount();
    await choose();
    fireEvent.change(screen.getByLabelText("Internal context (required)"), { target: { value: "New contractor." } });
    expect(screen.getByTestId("button-retain-previous-work")).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByTestId("button-retain-previous-work")).toBeEnabled();
  });

  it("disables signature-blocked candidates with the reason visible", async () => {
    data.candidates = [{ ...candidate, blockedReason: "Signature request in progress." }];
    mount();
    fireEvent.click(await screen.findByTestId("replacement-select"));
    expect(screen.getByRole("option", { name: /LOT-04-B/ })).toBeDisabled();
    expect(screen.getByText("Signature request in progress.")).toBeInTheDocument();
  });

  it("submits opaque source, target and impact tokens only after confirmation", async () => {
    mount();
    await review();
    fireEvent.click(screen.getByTestId("button-confirm-mark-replaced"));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/devis/12/mark-replaced", {
      replacementDevisId: 19, note: "Revised scope agreed at site meeting.",
      sourceVersion: "opaque-old", targetVersion: "opaque-new", impactVersion: "opaque-impact",
      differentContractorAcknowledged: false,
    }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("refreshes after 409, keeps the note and requires a fresh selection and review", async () => {
    request.mockImplementation(async (method, url) => {
      if (method === "POST") throw new ApiError(409, "Stale quotation", {});
      return { json: async () => url.includes("carry-forward") ? emptyCarry : ({ ...data }) } as Response;
    });
    mount();
    await review();
    fireEvent.click(screen.getByTestId("button-confirm-mark-replaced"));
    await screen.findByText(/The quotation or previous work changed/);
    expect(screen.getByLabelText("Internal context (required)")).toHaveValue("Revised scope agreed at site meeting.");
    expect(screen.getByTestId("replacement-select")).toHaveTextContent("Search processed quotations");
    expect(screen.getByTestId("button-retain-previous-work")).toBeDisabled();
    expect(screen.queryByTestId("button-confirm-mark-replaced")).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    await waitFor(() => expect(request.mock.calls.filter(([method, url]) => method === "GET" && url.endsWith("replacement-options"))).toHaveLength(2));
  });

  it("prevents double submit and dismissal while the save is pending", async () => {
    let resolveSave!: (response: Response) => void;
    request.mockImplementation(async (method, url) => {
      if (method === "POST") return new Promise<Response>(resolve => { resolveSave = resolve; });
      return { json: async () => url.includes("carry-forward") ? emptyCarry : data } as Response;
    });
    mount();
    await review();
    const confirm = screen.getByTestId("button-confirm-mark-replaced");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled());
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    resolveSave({ json: async () => ({ ok: true }) } as Response);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("renders reciprocal links using the project's actual ?devis= convention", () => {
    const entries = [{ id: 1, oldDevisId: 12, newDevisId: 19, oldLabel: "LOT-04-A", newLabel: "LOT-04-B", note: "Scope revision", actorName: "Camille Moreau", createdAt: "2026-06-12T10:12:00Z" }];
    const view = render(<QuotationReplacementHistory entries={entries} devisId={12} projectId="4" />);
    expect(screen.getByRole("link")).not.toBeVisible();
    fireEvent.click(screen.getByText("Replacement history (1)"));
    expect(screen.getByRole("link")).toBeVisible();
    expect(screen.getByText("Replaced by")).toBeVisible();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/projets/4?tab=devis&devis=19");
    view.rerender(<QuotationReplacementHistory entries={entries} devisId={19} projectId="4" />);
    expect(screen.getByRole("link")).toBeVisible();
    expect(screen.getByText("Replaces")).toBeVisible();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/projets/4?tab=devis&devis=12");
    expect(screen.getByText(/Camille Moreau/)).toBeInTheDocument();
    expect(screen.getByText(/Scope revision/)).toBeInTheDocument();
  });
});
