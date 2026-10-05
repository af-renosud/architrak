import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), lines: vi.fn(), translation: vi.fn(), corrected: vi.fn(), financial: vi.fn(), query: vi.fn() }));
vi.mock("../storage", () => ({ storage: { getDevis: mocks.get,getDevisLineItems: mocks.lines,getDevisTranslation: mocks.translation } }));
vi.mock("../db", () => ({ pool: { query: mocks.query } }));
vi.mock("../services/architect-quotation-correction", () => ({ hasArchitectCorrection: mocks.corrected,architectFinancialBoundary: mocks.financial }));
import { quotationApprovalBlocker } from "../services/quotation-approval-guard";
import { translationCoverageBlocker } from "../services/quotation-translation-coverage";
beforeEach(() => {
  vi.clearAllMocks(); mocks.corrected.mockResolvedValue(false); mocks.financial.mockResolvedValue(null);
  mocks.get.mockResolvedValue({ aiExtractedData: { quotationVerification: { verified: false }, illustratedRecovery: { status: "unverified" } } });
});
describe("human approval authority, separate from automatic quality diagnostics", () => {
  it("allows legacy explicitly human-reviewed content despite stale OCR/model coverage, without machine queries", async () => {
    mocks.translation.mockResolvedValue({ status: "finalised",headerTranslated: { humanReviewed: true } });
    expect(await quotationApprovalBlocker(42)).toBeNull();
    expect(await translationCoverageBlocker(42)).toBeNull();
    expect(mocks.lines).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("routes corrected human content only through its exact financial/source boundary, never historical coverage", async () => {
    mocks.corrected.mockResolvedValue(true);
    expect(await quotationApprovalBlocker(42)).toBeNull();
    expect(mocks.financial).toHaveBeenCalledWith(42);
    mocks.financial.mockResolvedValue("Working TTC differs from locked source TTC.");
    expect(await quotationApprovalBlocker(42)).toContain("TTC differs");
    expect(mocks.lines).not.toHaveBeenCalled();
  });
  it("retains strict automatic coverage policy when no human correction or approval exists", async () => {
    mocks.translation.mockResolvedValue({ status: "draft",headerTranslated: {} }); mocks.lines.mockResolvedValue([]);
    expect(await quotationApprovalBlocker(42)).toContain("unverified");
  });
  it("does not reuse a former human approval receipt after a new content edit", async () => {
    mocks.translation.mockResolvedValue({ status: "edited",headerTranslated: { humanReviewed: true } });
    mocks.lines.mockResolvedValue([]);
    expect(await quotationApprovalBlocker(42)).toContain("unverified");
  });
});
