import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(), lines: vi.fn(), translation: vi.fn(), corrected: vi.fn(), snapshot: vi.fn(), financial: vi.fn(), source: vi.fn(),
}));
vi.mock("../../storage", () => ({ storage: { getDevis: mocks.get, getDevisLineItems: mocks.lines, getDevisTranslation: mocks.translation } }));
vi.mock("../architect-quotation-correction", () => ({
  hasQuotationSourceBaseline: mocks.corrected, hasArchitectCorrection: vi.fn(async () => false), architectCorrectionService: { get: mocks.snapshot }, architectFinancialBoundary: mocks.financial,
}));
vi.mock("../quotation-approval-guard", () => ({ quotationApprovalBlocker: mocks.source }));
import { quotationReviewReadiness } from "../quotation-review-readiness";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ id: 42 });
  mocks.lines.mockResolvedValue([{ id: 1, totalHt: "100.00" }]);
  mocks.translation.mockResolvedValue({ status: "edited", contextsVersion: 1 });
  mocks.corrected.mockResolvedValue(false); mocks.source.mockResolvedValue(null); mocks.financial.mockResolvedValue(null);
  mocks.snapshot.mockResolvedValue({ baseline: null, blockedReason: null, draft: { discountHt: "0.00", lines: [
    { kind: "priced", included: true, clientKey: "line-1", vatRate: "", totalHt: "100.00" },
    { kind: "priced", included: true, clientKey: "line-2", vatRate: "", totalHt: "200.00" },
  ] } });
});
describe("quotation review preflight", () => {
  it("lists source confirmation and every missing line VAT together", async () => {
    mocks.corrected.mockResolvedValue(true);
    const result = await quotationReviewReadiness(42);
    expect(result?.blockers.map(item => item.key)).toEqual(["source", "line-1", "line-2"]);
  });
  it("retains source-byte failure alongside incomplete financial fields", async () => {
    mocks.corrected.mockResolvedValue(true);
    mocks.financial.mockResolvedValue("Original PDF bytes no longer match the locked source receipt.");
    expect((await quotationReviewReadiness(42))?.blockers.some(item => item.message.includes("bytes"))).toBe(true);
  });
  it("retains ordinary quotation source guards", async () => {
    mocks.source.mockResolvedValue("Source review required");
    expect((await quotationReviewReadiness(42))?.blockers).toEqual([{ key: "source", message: "Source review required" }]);
  });
  it("changes the reviewed revision when contexts, wording or figures change", async () => {
    const first = await quotationReviewReadiness(42);
    mocks.translation.mockResolvedValue({ status: "edited", contextsVersion: 2 });
    const context = await quotationReviewReadiness(42);
    expect(context?.version).not.toBe(first?.version);
    mocks.lines.mockResolvedValue([{ id: 1, totalHt: "101.00" }]);
    expect((await quotationReviewReadiness(42))?.version).not.toBe(context?.version);
  });
  it("reports missing translation and a missing quotation", async () => {
    mocks.translation.mockResolvedValue(undefined);
    expect((await quotationReviewReadiness(42))?.blockers[0].key).toBe("translation");
    mocks.get.mockResolvedValue(undefined);
    expect(await quotationReviewReadiness(42)).toBeNull();
  });
});
