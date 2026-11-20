import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), pdf: vi.fn() }));
vi.mock("../quotation-decision-snapshot", async importOriginal => ({
  ...await importOriginal<typeof import("../quotation-decision-snapshot")>(), loadQuotationDecisionSnapshot: mocks.snapshot,
}));
vi.mock("../../storage/object-storage", () => ({ getDocumentBuffer: mocks.pdf }));
import { quotationReviewReadiness } from "../quotation-review-readiness";
import { quotationApprovalBlocker } from "../quotation-approval-guard";
import { evaluateQuotationDecision } from "../quotation-decision";
import { decisionFixture, confirmFixture } from "./fixtures/quotation-decision";
import { sourceBytes } from "./fixtures/quotation-workflow";
let snapshot = decisionFixture();
beforeEach(() => {
  vi.clearAllMocks(); snapshot = decisionFixture();
  mocks.snapshot.mockImplementation(async () => snapshot); mocks.pdf.mockResolvedValue(sourceBytes);
});
describe("quotation decision parity", () => {
  it("clean machine-backed import does not require manual TTC transcription", async () => {
    expect((await quotationReviewReadiness(901))?.blockers).toEqual([]);
    expect(mocks.pdf).toHaveBeenCalledWith("synthetic.pdf");
  });
  it("changed original blocks review and advancement consistently", async () => {
    mocks.pdf.mockResolvedValue(Buffer.from("changed"));
    for (const action of ["approve", "advance", "client_link", "sign"] as const)
      expect((await evaluateQuotationDecision(snapshot, action)).issues.map(i => i.code)).toContain("SOURCE_DIGEST_MISMATCH");
  });
  it("unavailable source is not clearance", async () => {
    mocks.pdf.mockRejectedValue(new Error("offline"));
    expect((await quotationReviewReadiness(901))?.blockers[0].code).toBe("SOURCE_UNAVAILABLE");
  });
  it("an existing confirmation is reusable after wording edits", async () => {
    confirmFixture(snapshot); snapshot.lines[0].description = "Architect reviewed wording";
    expect(await quotationApprovalBlocker(901, { reviewing: true })).toBeNull();
  });
  it("financial disagreement is not waived by confirmed source", async () => {
    confirmFixture(snapshot); snapshot.baseline!.ttc = "121.00";
    expect((await quotationReviewReadiness(901))?.blockers[0].code).toBe("SOURCE_TTC_MISMATCH");
  });
  it("missing VAT blocks approval but not content-only save", async () => {
    confirmFixture(snapshot); snapshot.draft.lines[0].vatRate = "";
    expect((await evaluateQuotationDecision(snapshot, "approve")).allowed).toBe(false);
    expect((await evaluateQuotationDecision(snapshot, "save_content")).allowed).toBe(true);
  });
  it("financial saves still require independent source confirmation", async () => {
    expect((await evaluateQuotationDecision(snapshot, "save_financial")).issues[0].code).toBe("SOURCE_CONFIRMATION_REQUIRED");
  });
  it.each(["approve", "advance", "client_link", "sign", "save_content"] as const)("replaced quotation blocks %s", async action => {
    snapshot.quotation.accountingState = "superseded";
    expect((await evaluateQuotationDecision(snapshot, action)).issues[0].code).toBe("QUOTATION_REPLACED");
  });
  it("archived projects fail closed", async () => {
    snapshot.archived = true;
    expect((await evaluateQuotationDecision(snapshot, "approve")).issues[0].code).toBe("PROJECT_ARCHIVED");
  });
  it("sharing requires approved translation, not merely accurate source", async () => {
    expect((await evaluateQuotationDecision(snapshot, "approve")).allowed).toBe(true);
    expect((await evaluateQuotationDecision(snapshot, "client_link")).issues[0].code).toBe("TRANSLATION_NOT_APPROVED");
  });
});
