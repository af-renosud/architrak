import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), pdf: vi.fn() }));
vi.mock("../quotation-decision-snapshot", async importOriginal => ({
  ...await importOriginal<typeof import("../quotation-decision-snapshot")>(), loadQuotationDecisionSnapshot: mocks.snapshot,
}));
vi.mock("../../storage/object-storage", () => ({ getDocumentBuffer: mocks.pdf }));
import { quotationReviewReadiness } from "../quotation-review-readiness";
import { decisionFixture, confirmFixture } from "./fixtures/quotation-decision";
import { sourceBytes } from "./fixtures/quotation-workflow";
let snapshot = decisionFixture();
beforeEach(() => {
  vi.clearAllMocks(); snapshot = decisionFixture();
  mocks.snapshot.mockImplementation(async () => snapshot); mocks.pdf.mockResolvedValue(sourceBytes);
});
describe("coherent quotation review preflight", () => {
  it("lists every missing line VAT with stable row and field targets", async () => {
    confirmFixture(snapshot); snapshot.draft.lines[0].vatRate = "";
    snapshot.draft.lines.push({ ...snapshot.draft.lines[0], id: 2, clientKey: "line-2" });
    const result = await quotationReviewReadiness(901);
    expect(result?.blockers.map(i => [i.code, i.key, i.target.field])).toEqual([
      ["VAT_MISSING", "line-1", "vatRate"], ["VAT_MISSING", "line-2", "vatRate"],
    ]);
  });
  it("retains source-byte failure alongside incomplete financial fields", async () => {
    confirmFixture(snapshot); snapshot.draft.lines[0].vatRate = ""; mocks.pdf.mockResolvedValue(Buffer.from("changed"));
    expect((await quotationReviewReadiness(901))?.blockers.map(i => i.code)).toEqual(["VAT_MISSING", "SOURCE_DIGEST_MISMATCH"]);
  });
  it("requires confirmation for a legacy quotation without source receipt", async () => {
    snapshot.quotation.aiExtractedData = { documentType: "quotation" };
    expect((await quotationReviewReadiness(901))?.blockers[0].code).toBe("SOURCE_CONFIRMATION_REQUIRED");
  });
  it("binds the reviewed version to context, source confirmation and figures", async () => {
    const first = await quotationReviewReadiness(901);
    snapshot.translation!.contextsVersion++;
    const context = await quotationReviewReadiness(901);
    expect(context?.version).not.toBe(first?.version);
    confirmFixture(snapshot);
    const confirmed = await quotationReviewReadiness(901);
    expect(confirmed?.version).not.toBe(context?.version);
    snapshot.lines[0].totalHt = "101.00";
    expect((await quotationReviewReadiness(901))?.version).not.toBe(confirmed?.version);
  });
  it("reports missing translation and a missing quotation", async () => {
    snapshot.translation = undefined;
    expect((await quotationReviewReadiness(901))?.blockers[0].key).toBe("translation");
    mocks.snapshot.mockResolvedValue(null);
    expect(await quotationReviewReadiness(901)).toBeNull();
  });
});
