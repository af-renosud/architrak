import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  quotation: vi.fn(), lines: vi.fn(), translation: vi.fn(), baseline: vi.fn(),
  financial: vi.fn(), snapshot: vi.fn(), pdf: vi.fn(),
}));
vi.mock("../../storage", () => ({ storage: {
  getDevis: mocks.quotation, getDevisLineItems: mocks.lines, getDevisTranslation: mocks.translation,
} }));
vi.mock("../architect-quotation-correction", () => ({
  hasQuotationSourceBaseline: mocks.baseline, architectFinancialBoundary: mocks.financial,
  architectCorrectionService: { get: mocks.snapshot },
}));
vi.mock("../../storage/object-storage", () => ({ getDocumentBuffer: mocks.pdf }));
import { quotationReviewReadiness } from "../quotation-review-readiness";
import { quotationApprovalBlocker } from "../quotation-approval-guard";
import { deriveDevisReadiness, type DeriveReadinessInput } from "../devis-readiness";
import { cleanImport, roofDraft, sourceBytes, workingRow } from "./fixtures/quotation-workflow";

function sendInput(): DeriveReadinessInput {
  return { devis: { id: 901, status: "draft", signOffStage: "approved_for_signing", invoicingMode: "mode_b",
    lotId: 1, lotRefText: "ROOF", descriptionUk: "Roof repair", archisignEnvelopeId: null,
    archisignEnvelopeStatus: null, aiExtractedData: null },
    translationStatus: "finalised", openContractorChecks: 0, openClientChecks: 0,
    clientContactPresent: true, insurance: { ok: true, reason: "Verified mirror" }, insuranceOverridden: false };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.quotation.mockResolvedValue({ id: 901, amountHt: "100.00", amountTtc: "120.00", pdfStorageKey: "synthetic.pdf", aiExtractedData: cleanImport() });
  mocks.lines.mockResolvedValue([workingRow(1, "Roof repair")]);
  mocks.translation.mockResolvedValue({ status: "draft", contextsVersion: 0, headerTranslated: {} });
  mocks.baseline.mockResolvedValue(false);
  mocks.financial.mockResolvedValue(null);
  mocks.pdf.mockResolvedValue(sourceBytes);
  mocks.snapshot.mockResolvedValue({ baseline: { ttc: "120.00" }, blockedReason: null, draft: roofDraft() });
});

describe("current quotation workflow contract — not a new permission policy", () => {
  it("clean machine-backed import can reach review without manually transcribing TTC", async () => {
    expect((await quotationReviewReadiness(901))?.blockers).toEqual([]);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.pdf).toHaveBeenCalledWith("synthetic.pdf");
  });
  it("a changed original is a blocker, not a warning", async () => {
    mocks.pdf.mockResolvedValue(Buffer.from("changed"));
    expect(await quotationApprovalBlocker(901)).toContain("no longer matches");
  });
  it("unavailable original evidence is not permission to proceed", async () => {
    mocks.pdf.mockRejectedValue(new Error("offline"));
    expect((await quotationReviewReadiness(901))?.blockers[0].message).toContain("cannot be verified");
  });
  it("legacy quotation without a receipt requests source review, not a fake correction", async () => {
    mocks.quotation.mockResolvedValue({ id: 901, aiExtractedData: { documentType: "quotation" } });
    expect(await quotationApprovalBlocker(901, { reviewing: true })).toContain("no source-verification receipt");
  });
  it("confirmed source without a correction allows review but still requires explicit approval before advancement", async () => {
    mocks.baseline.mockResolvedValue(true);
    expect((await quotationReviewReadiness(901))?.blockers).toEqual([]);
    expect(await quotationApprovalBlocker(901)).toContain("no correction or repeat entry");
    expect(mocks.pdf).not.toHaveBeenCalled(); // boundary service owns receipt checks on this branch
  });
  it("architect-corrected content uses its source/financial boundary rather than stale machine coverage", async () => {
    mocks.baseline.mockResolvedValue(true);
    mocks.translation.mockResolvedValue({ status: "edited", contextsVersion: 4, headerTranslated: { humanReviewed: true } });
    mocks.quotation.mockResolvedValue({ id: 901, aiExtractedData: { quotationVerification: { verified: false } } });
    expect((await quotationReviewReadiness(901))?.blockers).toEqual([]);
    expect(mocks.financial).toHaveBeenCalledWith(901);
  });
  it("confirmed source does not waive a real financial discrepancy", async () => {
    mocks.baseline.mockResolvedValue(true);
    mocks.financial.mockResolvedValue("Working TTC differs from the locked source TTC.");
    expect((await quotationReviewReadiness(901))?.blockers).toEqual([{ key: "header", message: "Working TTC differs from the locked source TTC." }]);
  });
  it("missing VAT is grouped by row instead of silently defaulting", async () => {
    mocks.baseline.mockResolvedValue(true);
    const draft = roofDraft(); draft.lines[0].vatRate = "";
    mocks.snapshot.mockResolvedValue({ baseline: { ttc: "120.00" }, draft });
    expect((await quotationReviewReadiness(901))?.blockers[0].key).toBe("line-1");
  });
  it("wording/context changes both invalidate the reviewed version", async () => {
    const before = await quotationReviewReadiness(901);
    mocks.translation.mockResolvedValue({ status: "edited", contextsVersion: 1, headerTranslated: {} });
    const context = await quotationReviewReadiness(901);
    expect(context?.version).not.toBe(before?.version);
    mocks.lines.mockResolvedValue([workingRow(1, "Reviewed roof wording")]);
    const wording = await quotationReviewReadiness(901);
    expect(wording?.version).not.toBe(context?.version);
    expect(wording?.blockers[0].message).toContain("Working rows changed");
  });
  it("legacy finalised human receipt bypasses historical coverage, but edited status cannot reuse it", async () => {
    mocks.quotation.mockResolvedValue({ id: 901, aiExtractedData: { illustratedRecovery: {}, quotationVerification: { verified: false } } });
    mocks.translation.mockResolvedValue({ status: "finalised", headerTranslated: { humanReviewed: true } });
    expect(await quotationApprovalBlocker(901)).toBeNull();
    mocks.translation.mockResolvedValue({ status: "edited", headerTranslated: { humanReviewed: true } });
    expect(await quotationApprovalBlocker(901)).toContain("unverified");
  });
  it("CURRENT GAP: historical coverage can block the card despite the explicit human-review path allowing progression", async () => {
    mocks.baseline.mockResolvedValue(true);
    mocks.translation.mockResolvedValue({ status: "finalised", approvedAt: new Date(), headerTranslated: { humanReviewed: true } });
    expect(await quotationApprovalBlocker(901)).toBeNull();
    const input = sendInput();
    input.devis.aiExtractedData = { illustratedRecovery: {}, quotationVerification: { verified: false } };
    expect(deriveDevisReadiness(input).blockers).toContain("Source specification coverage is unverified");
  });
  it("signed evidence prevents a new signature request in card readiness", () => {
    const input = sendInput(); input.devis.signedPdfStorageKey = "signed.pdf";
    expect(deriveDevisReadiness(input).readyToSend).toBe(false);
    expect(deriveDevisReadiness(input).signature).toBe("signed");
  });
  it("CURRENT GAP: superseded accounting state alone is absent from the pure card check", () => {
    const input = sendInput(); input.devis.accountingState = "superseded";
    // The send route separately refuses this. Do not interpret as desired permission.
    expect(deriveDevisReadiness(input).readyToSend).toBe(true);
  });
  it("CURRENT POLICY: mode A permits draft wording at send readiness, unlike mode B", () => {
    const input = sendInput(); input.translationStatus = "draft";
    expect(deriveDevisReadiness(input).readyToSend).toBe(false);
    input.devis.invoicingMode = "mode_a";
    expect(deriveDevisReadiness(input).readyToSend).toBe(true);
  });
});
