import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Devis, OverlapCase } from "@shared/schema";

vi.mock("../../../storage", () => {
  class AccountingStateConflictError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AccountingStateConflictError";
    }
  }
  return {
    AccountingStateConflictError,
    storage: {
      getDevisByProject: vi.fn(),
      getDevis: vi.fn(),
      getAvenantsByDevis: vi.fn(),
      getOverlapCasesByProject: vi.fn(),
      getOverlapCase: vi.fn(),
      getDismissedOverlapCaseIds: vi.fn(),
      transitionDevisAccountingState: vi.fn(),
      applyAccountingStateTransitions: vi.fn(),
    },
  };
});

import { AccountingStateConflictError } from "../../../storage";
import {
  reconcileAccountingStates,
  applyHumanResolution,
  computeOverlapCaseImpact,
  getProjectAccountingStatus,
} from "../resolution.service";
import { storage } from "../../../storage";

const mockedStorage = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;

function devis(id: number, accountingState: string, amountHt = "100.00"): Devis {
  return {
    id,
    projectId: 1,
    amountHt,
    amountTtc: amountHt,
    status: "draft",
    accountingState,
  } as unknown as Devis;
}

function overlapCase(over: Partial<OverlapCase>): OverlapCase {
  return {
    id: 1,
    projectId: 1,
    primaryDevisId: 3,
    memberDevisIds: [1, 2],
    verdict: "proven",
    status: "active",
    ...over,
  } as unknown as OverlapCase;
}

describe("resolution.service — reconcileAccountingStates (Task #232)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStorage.getDismissedOverlapCaseIds.mockResolvedValue([]);
    mockedStorage.getAvenantsByDevis.mockResolvedValue([]);
    mockedStorage.transitionDevisAccountingState.mockResolvedValue(undefined);
  });

  it("auto-supersedes members of a proven case and promotes the surviving primary", async () => {
    mockedStorage.getDevisByProject.mockResolvedValue([
      devis(1, "active"),
      devis(2, "active"),
      devis(3, "provisional", "200.00"),
    ]);
    mockedStorage.getOverlapCasesByProject.mockResolvedValue([
      overlapCase({ verdict: "proven", primaryDevisId: 3, memberDevisIds: [1, 2] }),
    ]);

    await reconcileAccountingStates(1);

    const calls = mockedStorage.transitionDevisAccountingState.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual(expect.objectContaining({ devisId: 1, toState: "superseded", reason: "proven_supersede" }));
    expect(calls).toContainEqual(expect.objectContaining({ devisId: 2, toState: "superseded", reason: "proven_supersede" }));
    expect(calls).toContainEqual(expect.objectContaining({ devisId: 3, toState: "active", reason: "reconciliation_promote" }));
  });

  it("keeps provisional devis under a needs_review case provisional (no promotion)", async () => {
    mockedStorage.getDevisByProject.mockResolvedValue([
      devis(1, "provisional"),
      devis(2, "provisional"),
    ]);
    mockedStorage.getOverlapCasesByProject.mockResolvedValue([
      overlapCase({ verdict: "needs_review", primaryDevisId: 1, memberDevisIds: [2] }),
    ]);

    await reconcileAccountingStates(1);
    expect(mockedStorage.transitionDevisAccountingState).not.toHaveBeenCalled();
  });

  it("does NOT auto-supersede a proven case the architect dismissed", async () => {
    mockedStorage.getDevisByProject.mockResolvedValue([devis(1, "active"), devis(2, "active")]);
    mockedStorage.getOverlapCasesByProject.mockResolvedValue([
      overlapCase({ id: 9, verdict: "proven", primaryDevisId: 2, memberDevisIds: [1] }),
    ]);
    mockedStorage.getDismissedOverlapCaseIds.mockResolvedValue([9]);

    await reconcileAccountingStates(1);
    expect(mockedStorage.transitionDevisAccountingState).not.toHaveBeenCalled();
  });

  it("promotes a lone provisional devis with no overlap to active", async () => {
    mockedStorage.getDevisByProject.mockResolvedValue([devis(1, "provisional")]);
    mockedStorage.getOverlapCasesByProject.mockResolvedValue([]);

    await reconcileAccountingStates(1);
    expect(mockedStorage.transitionDevisAccountingState).toHaveBeenCalledWith(
      expect.objectContaining({ devisId: 1, toState: "active", reason: "reconciliation_promote" }),
    );
  });
});

describe("resolution.service — applyHumanResolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStorage.applyAccountingStateTransitions.mockResolvedValue(undefined);
    // By default no OTHER cases touch the devis under resolution.
    mockedStorage.getOverlapCasesByProject.mockResolvedValue([]);
    mockedStorage.getDismissedOverlapCaseIds.mockResolvedValue([]);
  });

  // The single human decision is applied as one atomic batch.
  function appliedTransitions(): Array<Record<string, unknown>> {
    expect(mockedStorage.applyAccountingStateTransitions).toHaveBeenCalledTimes(1);
    return mockedStorage.applyAccountingStateTransitions.mock.calls[0][0];
  }

  it("confirm supersedes members and activates a provisional primary in one batch", async () => {
    mockedStorage.getOverlapCase.mockResolvedValue(
      overlapCase({ id: 5, verdict: "needs_review", primaryDevisId: 3, memberDevisIds: [1, 2] }),
    );
    mockedStorage.getDevis.mockImplementation(async (id: number) =>
      id === 3 ? devis(3, "provisional") : devis(id, "active"),
    );

    const result = await applyHumanResolution({ caseId: 5, decision: "confirm", actorUserId: 7 });
    expect(result.ok).toBe(true);
    const calls = appliedTransitions();
    expect(calls).toContainEqual(expect.objectContaining({ devisId: 1, toState: "superseded", reason: "human_confirm", actorUserId: 7 }));
    expect(calls).toContainEqual(expect.objectContaining({ devisId: 3, toState: "active", reason: "human_confirm" }));
  });

  it("dismiss records a human_dismiss audit row even when nothing changes", async () => {
    mockedStorage.getOverlapCase.mockResolvedValue(
      overlapCase({ id: 6, verdict: "needs_review", primaryDevisId: 3, memberDevisIds: [1] }),
    );
    mockedStorage.getDevis.mockResolvedValue(devis(3, "active"));

    const result = await applyHumanResolution({ caseId: 6, decision: "dismiss", actorUserId: 7 });
    expect(result.ok).toBe(true);
    const calls = appliedTransitions();
    expect(calls.some((c) => c.reason === "human_dismiss" && c.overlapCaseId === 6)).toBe(true);
    // No money-in: the audit-only row keeps the devis in its current state.
    expect(calls).toContainEqual(expect.objectContaining({ devisId: 3, fromState: "active", toState: "active" }));
  });

  it("dismiss NEVER restores a superseded devis", async () => {
    mockedStorage.getOverlapCase.mockResolvedValue(
      overlapCase({ id: 8, verdict: "needs_review", primaryDevisId: 3, memberDevisIds: [1] }),
    );
    mockedStorage.getDevis.mockResolvedValue(devis(3, "superseded"));

    await applyHumanResolution({ caseId: 8, decision: "dismiss", actorUserId: 7 });
    const calls = appliedTransitions();
    // Audit-only row stays superseded → superseded; nothing is reactivated.
    expect(calls.every((c) => c.toState !== "active")).toBe(true);
  });

  it("dismiss does NOT promote a provisional devis still under review by another active case", async () => {
    // Case 6 (the one being dismissed) and case 7 (still open, needs_review)
    // both involve devis 3. Resolving case 6 must leave devis 3 provisional.
    mockedStorage.getOverlapCase.mockResolvedValue(
      overlapCase({ id: 6, verdict: "needs_review", primaryDevisId: 3, memberDevisIds: [1] }),
    );
    mockedStorage.getOverlapCasesByProject.mockResolvedValue([
      overlapCase({ id: 6, verdict: "needs_review", primaryDevisId: 3, memberDevisIds: [1] }),
      overlapCase({ id: 7, verdict: "needs_review", primaryDevisId: 3, memberDevisIds: [9] }),
    ]);
    // Devis 3 is the one shared with case 7; member 1 is already active.
    mockedStorage.getDevis.mockImplementation(async (id: number) =>
      id === 3 ? devis(3, "provisional") : devis(id, "active"),
    );

    const result = await applyHumanResolution({ caseId: 6, decision: "dismiss", actorUserId: 7 });
    expect(result.ok).toBe(true);
    const calls = appliedTransitions();
    // Devis 3 is NOT promoted to active (still tied up in case 7).
    expect(calls.some((c) => c.devisId === 3 && c.toState === "active")).toBe(false);
    // Still leaves an audit row for the dismissal.
    expect(calls.some((c) => c.reason === "human_dismiss" && c.overlapCaseId === 6)).toBe(true);
  });

  it("confirm does NOT promote the provisional primary while another active case still touches it", async () => {
    mockedStorage.getOverlapCase.mockResolvedValue(
      overlapCase({ id: 5, verdict: "needs_review", primaryDevisId: 3, memberDevisIds: [1] }),
    );
    mockedStorage.getOverlapCasesByProject.mockResolvedValue([
      overlapCase({ id: 5, verdict: "needs_review", primaryDevisId: 3, memberDevisIds: [1] }),
      overlapCase({ id: 8, verdict: "needs_review", primaryDevisId: 3, memberDevisIds: [4] }),
    ]);
    mockedStorage.getDevis.mockImplementation(async (id: number) =>
      id === 3 ? devis(3, "provisional") : devis(id, "active"),
    );

    const result = await applyHumanResolution({ caseId: 5, decision: "confirm", actorUserId: 7 });
    expect(result.ok).toBe(true);
    const calls = appliedTransitions();
    // Member 1 still superseded by the confirm…
    expect(calls).toContainEqual(expect.objectContaining({ devisId: 1, toState: "superseded" }));
    // …but primary 3 is NOT promoted to active (case 8 still open).
    expect(calls.some((c) => c.devisId === 3 && c.toState === "active")).toBe(false);
  });

  it("returns 404 for an unknown case", async () => {
    mockedStorage.getOverlapCase.mockResolvedValue(undefined);
    const result = await applyHumanResolution({ caseId: 999, decision: "confirm", actorUserId: 7 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(mockedStorage.applyAccountingStateTransitions).not.toHaveBeenCalled();
  });

  it("returns 409 for a withdrawn (non-active) case and moves nothing", async () => {
    mockedStorage.getOverlapCase.mockResolvedValue(
      overlapCase({ id: 10, status: "withdrawn", verdict: "proven", primaryDevisId: 3, memberDevisIds: [1] }),
    );

    const result = await applyHumanResolution({ caseId: 10, decision: "confirm", actorUserId: 7 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(mockedStorage.applyAccountingStateTransitions).not.toHaveBeenCalled();
  });

  it("returns 409 for a proven case (only needs_review accepts a human decision) and moves nothing", async () => {
    mockedStorage.getOverlapCase.mockResolvedValue(
      overlapCase({ id: 12, verdict: "proven", status: "active", primaryDevisId: 3, memberDevisIds: [1, 2] }),
    );

    const result = await applyHumanResolution({ caseId: 12, decision: "dismiss", actorUserId: 7 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(mockedStorage.applyAccountingStateTransitions).not.toHaveBeenCalled();
  });

  it("translates a stale-write conflict into a 409", async () => {
    mockedStorage.getOverlapCase.mockResolvedValue(
      overlapCase({ id: 11, verdict: "needs_review", primaryDevisId: 3, memberDevisIds: [1] }),
    );
    mockedStorage.getDevis.mockResolvedValue(devis(1, "active"));
    mockedStorage.applyAccountingStateTransitions.mockRejectedValue(
      new AccountingStateConflictError("Devis 1 is no longer in expected state 'active'"),
    );

    const result = await applyHumanResolution({ caseId: 11, decision: "confirm", actorUserId: 7 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  });
});

describe("resolution.service — computeOverlapCaseImpact & status rollup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStorage.getAvenantsByDevis.mockResolvedValue([]);
    mockedStorage.getDismissedOverlapCaseIds.mockResolvedValue([]);
  });

  it("impact sums only currently-active members' adjusted HT", async () => {
    mockedStorage.getDevis.mockImplementation(async (id: number) =>
      id === 1 ? devis(1, "active", "100.00") : devis(2, "provisional", "200.00"),
    );
    const impact = await computeOverlapCaseImpact({ memberDevisIds: [1, 2] });
    expect(impact).toBe(100); // provisional member contributes 0
  });

  it("rollup reports needs_review with euros at risk", async () => {
    mockedStorage.getDevisByProject.mockResolvedValue([devis(1, "active", "100.00"), devis(2, "provisional", "200.00")]);
    mockedStorage.getOverlapCasesByProject.mockResolvedValue([
      overlapCase({ id: 1, verdict: "needs_review", primaryDevisId: 2, memberDevisIds: [1] }),
    ]);
    mockedStorage.getDevis.mockResolvedValue(devis(1, "active", "100.00"));

    const status = await getProjectAccountingStatus(1);
    expect(status.status).toBe("needs_review");
    expect(status.needsReviewCount).toBe(1);
    expect(status.eurosAtRisk).toBe(100);
  });

  it("rollup is clean when all active and no cases", async () => {
    mockedStorage.getDevisByProject.mockResolvedValue([devis(1, "active")]);
    mockedStorage.getOverlapCasesByProject.mockResolvedValue([]);

    const status = await getProjectAccountingStatus(1);
    expect(status.status).toBe("clean");
  });
});
