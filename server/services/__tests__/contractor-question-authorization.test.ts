import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevisCheck } from "@shared/schema";
import { contractorQuestionSnapshot } from "../contractor-question-authorization";
import { getProjectDevisReadiness } from "../devis-readiness";
import { storage } from "../../storage";

vi.mock("../../storage", () => ({
  storage: {
    getDevisByProject: vi.fn(), getProject: vi.fn(),
    getDevisTranslationStatusesByProject: vi.fn(),
    listDevisChecksForProject: vi.fn(), countOpenClientChecksForProject: vi.fn(),
    getLotsByProject: vi.fn(), listDevisIdsWithInsuranceOverride: vi.fn(),
    getContractorsByIds: vi.fn(),
  },
}));
vi.mock("../insurance-verdict", () => ({
  evaluateInsuranceMirrorPreloaded: vi.fn(() => ({ ok: true, reason: "valid" })),
}));
const q = (id: number, status = "open", devisId = 100) => ({
  id, status, devisId, query: `Question ${id}`, updatedAt: new Date("2026-06-01T08:00:00Z"),
  createdAt: new Date("2026-06-01T08:00:00Z"), origin: "general",
  lineItemId: null, resolutionNote: null, createdByUserId: 1, resolvedAt: null, resolvedByUserId: null,
}) as DevisCheck;

describe("quotation-bound question receipts", () => {
  it("is stable across ordering and excludes resolved/dropped questions", () => {
    expect(contractorQuestionSnapshot(100, [q(2), q(1)]))
      .toEqual(contractorQuestionSnapshot(100, [q(1), q(3, "resolved"), q(2), q(4, "dropped")]));
  });
  it("includes all three unresolved statuses and binds the quotation ID", () => {
    const checks = [q(1), q(2, "awaiting_architect"), q(3, "awaiting_contractor")];
    expect(contractorQuestionSnapshot(100, checks).openCount).toBe(3);
    expect(contractorQuestionSnapshot(100, checks).snapshot)
      .not.toBe(contractorQuestionSnapshot(101, checks).snapshot);
  });
  it("changes when questions are added, removed, edited, re-statused or updated", () => {
    const original = contractorQuestionSnapshot(100, [q(1)]).snapshot;
    for (const checks of [
      [], [q(1), q(2)], [q(2)], [{ ...q(1), query: "New wording" }],
      [q(1, "awaiting_architect")], [{ ...q(1), updatedAt: new Date("2026-06-01T08:00:01Z") }],
    ]) expect(contractorQuestionSnapshot(100, checks).snapshot).not.toBe(original);
  });
});

describe("batch readiness exposes the exact send receipt without clearing the blocker", () => {
  beforeEach(() => {
    vi.mocked(storage.getDevisByProject).mockResolvedValue([{
      id: 100, projectId: 9, contractorId: 5, signOffStage: "approved_for_signing",
      invoicingMode: "mode_b", lotId: 1, descriptionUk: "Joinery", status: "pending",
    }] as Awaited<ReturnType<typeof storage.getDevisByProject>>);
    vi.mocked(storage.getProject).mockResolvedValue({
      id: 9, clientContactName: "Claire Martin", clientContactEmail: "claire@example.test",
    } as Awaited<ReturnType<typeof storage.getProject>>);
    vi.mocked(storage.getDevisTranslationStatusesByProject).mockResolvedValue({ 100: "finalised" });
    vi.mocked(storage.countOpenClientChecksForProject).mockResolvedValue({});
    vi.mocked(storage.getLotsByProject).mockResolvedValue([]);
    vi.mocked(storage.listDevisIdsWithInsuranceOverride).mockResolvedValue(new Set());
    vi.mocked(storage.getContractorsByIds).mockResolvedValue([]);
  });
  it("uses one project-wide check query and returns a quotation-specific snapshot", async () => {
    const checks = [q(1), q(2, "awaiting_architect"), q(3, "awaiting_contractor"), q(4, "resolved"), q(5, "open", 101)];
    vi.mocked(storage.listDevisChecksForProject).mockResolvedValue(checks);
    const readiness = (await getProjectDevisReadiness(9))[100];
    expect(readiness.openContractorChecks).toBe(3);
    expect(readiness.readyToSend).toBe(false);
    expect(readiness.blockers).toEqual(["3 contractor checks are still open"]);
    expect(readiness.contractorQuestionAuthorizationSnapshot)
      .toBe(contractorQuestionSnapshot(100, checks.filter(c => c.devisId === 100)).snapshot);
    expect(storage.listDevisChecksForProject).toHaveBeenCalledWith(9);
  });
  it("also binds zero-question packages so newly opened questions invalidate retries", async () => {
    vi.mocked(storage.listDevisChecksForProject).mockResolvedValue([]);
    const readiness = (await getProjectDevisReadiness(9))[100];
    expect(readiness.readyToSend).toBe(true);
    expect(readiness.contractorQuestionAuthorizationSnapshot).toBe(contractorQuestionSnapshot(100, []).snapshot);
  });
});
