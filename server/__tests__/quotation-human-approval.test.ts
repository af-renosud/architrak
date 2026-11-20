import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), pdf: vi.fn() }));
vi.mock("../services/quotation-decision-snapshot", async importOriginal => ({
  ...await importOriginal<typeof import("../services/quotation-decision-snapshot")>(), loadQuotationDecisionSnapshot: mocks.snapshot,
}));
vi.mock("../storage/object-storage", () => ({ getDocumentBuffer: mocks.pdf }));
import { quotationApprovalBlocker } from "../services/quotation-approval-guard";
import { decisionFixture, confirmFixture } from "../services/__tests__/fixtures/quotation-decision";
import { sourceBytes } from "../services/__tests__/fixtures/quotation-workflow";
let snapshot = decisionFixture();
beforeEach(() => {
  vi.clearAllMocks(); snapshot = decisionFixture();
  snapshot.quotation.aiExtractedData = { quotationVerification: { verified: false }, illustratedRecovery: { status: "unverified" } };
  mocks.snapshot.mockImplementation(async () => snapshot); mocks.pdf.mockResolvedValue(sourceBytes);
});
describe("human approval authority, separate from automatic quality diagnostics", () => {
  it("allows explicit review without correction but requires approval before stage advancement", async () => {
    confirmFixture(snapshot);
    expect(await quotationApprovalBlocker(901, { reviewing: true })).toBeNull();
    expect(await quotationApprovalBlocker(901)).toContain("no correction or repeat entry");
    snapshot.translation!.status = "finalised"; snapshot.translation!.approvedAt = new Date();
    snapshot.translation!.headerTranslated = { humanReviewed: true };
    expect(await quotationApprovalBlocker(901)).toBeNull();
  });
  it("allows a legacy finalised human receipt despite stale OCR coverage", async () => {
    snapshot.translation!.status = "finalised"; snapshot.translation!.headerTranslated = { humanReviewed: true };
    expect(await quotationApprovalBlocker(901)).toBeNull();
  });
  it("checks corrected figures against the source, not historical machine coverage", async () => {
    confirmFixture(snapshot); snapshot.hasCorrection = true;
    expect(await quotationApprovalBlocker(901, { reviewing: true })).toBeNull();
    snapshot.baseline!.ttc = "121.00";
    expect(await quotationApprovalBlocker(901)).toContain("don't match the original total");
  });
  it("retains strict automatic coverage for an unreviewed import", async () => {
    expect(await quotationApprovalBlocker(901)).toContain("unverified");
  });
  it("does not reuse human approval after a content edit", async () => {
    snapshot.translation!.status = "edited"; snapshot.translation!.headerTranslated = { humanReviewed: true };
    expect(await quotationApprovalBlocker(901)).toContain("unverified");
  });
  it("does not let legacy approval waive unsupported priced charges", async () => {
    snapshot = decisionFixture();
    (snapshot.quotation.aiExtractedData as any).pricedItemVerification.issues.push({ line: 1, page: 1, reason: "unsupported" });
    snapshot.translation!.status = "finalised"; snapshot.translation!.headerTranslated = { humanReviewed: true };
    expect(await quotationApprovalBlocker(901)).toContain("Source review required");
  });
  it("requests scoped review of historical extraction without a receipt", async () => {
    snapshot.quotation.aiExtractedData = { documentType: "quotation" };
    expect(await quotationApprovalBlocker(901)).toContain("does not mean the amount is wrong");
  });
});
