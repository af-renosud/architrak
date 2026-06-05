/**
 * Task #232 — Accounting-state resolution & Contracted guard.
 *
 * The overlap-detection engine (Task #231) produces structured `overlap_cases`
 * but moves NO money. This service owns the *consequence*: turning a detected
 * overlap into a change of which devis count toward the project's Contracted /
 * Certified / Reste-à-Réaliser buckets.
 *
 * Two entry points move money-relevant state, and ONLY these two ever do:
 *   - reconcileAccountingStates(projectId) — automatic, runs after every
 *     detection pass. It (a) auto-supersedes the members of *arithmetically
 *     proven* cases (safe: the euros reconcile exactly), and (b) promotes
 *     freshly-ingested `provisional` devis to `active` once no unresolved
 *     overlap touches them. It NEVER auto-resolves a `needs_review` case and
 *     NEVER restores a superseded devis (no oscillation).
 *   - applyHumanResolution(...) — an architect's recorded decision on a
 *     `needs_review` case (confirm → supersede members, dismiss → keep active).
 *
 * Every transition is written through storage.transitionDevisAccountingState,
 * which appends an immutable audit row. No silent money movement: a devis
 * leaves Contracted only via arithmetic proof or a recorded human decision.
 */

import { storage, AccountingStateConflictError, type AccountingStateTransition } from "../../storage";
import { roundCurrency } from "../../../shared/financial-utils";
import type { Devis, OverlapCase } from "@shared/schema";

export type HumanResolutionDecision = "confirm" | "dismiss";

export interface ProjectAccountingStatus {
  projectId: number;
  status: "clean" | "pending_analysis" | "needs_review" | "resolved";
  provisionalCount: number;
  supersededCount: number;
  needsReviewCount: number;
  eurosAtRisk: number;
}

/**
 * Avenant-adjusted HT for a single devis (original + approved PV − approved
 * MV), rounded to 2 decimals. Mirrors the inline logic in
 * financial-summary.service.ts so the "euros removed from Contracted" figure
 * matches the bucket arithmetic exactly.
 */
async function devisAdjustedHt(d: Devis): Promise<number> {
  const avs = await storage.getAvenantsByDevis(d.id);
  const approved = avs.filter((a) => a.status === "approved");
  const pvTotal = approved
    .filter((a) => a.type === "pv")
    .reduce((sum, a) => sum + parseFloat(a.amountHt), 0);
  const mvTotal = approved
    .filter((a) => a.type === "mv")
    .reduce((sum, a) => sum + parseFloat(a.amountHt), 0);
  return roundCurrency(parseFloat(d.amountHt) + pvTotal - mvTotal);
}

/**
 * Euros that confirming/auto-applying this case would remove from Contracted:
 * the avenant-adjusted HT of the member devis that are CURRENTLY counted
 * (accountingState === "active"). Members that are still provisional or
 * already superseded contribute 0 — they are not in Contracted today.
 */
export async function computeOverlapCaseImpact(
  overlapCase: Pick<OverlapCase, "memberDevisIds">,
): Promise<number> {
  let removed = 0;
  for (const memberId of overlapCase.memberDevisIds) {
    const member = await storage.getDevis(memberId);
    if (member && member.accountingState === "active") {
      removed = roundCurrency(removed + (await devisAdjustedHt(member)));
    }
  }
  return removed;
}

/**
 * Automatic reconciliation of accounting state for a whole project. Idempotent:
 * re-running with no new cases is a no-op. Called after each detection pass
 * (from the reconciliation queue), never inside the detection transaction.
 */
export async function reconcileAccountingStates(projectId: number): Promise<void> {
  const allDevis = (await storage.getDevisByProject(projectId)).filter(
    (d) => d.status !== "void",
  );
  if (allDevis.length === 0) return;

  const activeCases = await storage.getOverlapCasesByProject(projectId, "active");
  const dismissedCaseIds = new Set(await storage.getDismissedOverlapCaseIds(projectId));

  // Members the arithmetic proves are folded into another devis → supersede.
  // Devis tied up in an unresolved needs_review case → leave provisional.
  const supersedeTargets = new Map<number, number>(); // devisId -> overlapCaseId
  const underReview = new Set<number>();
  for (const c of activeCases) {
    if (dismissedCaseIds.has(c.id)) continue; // architect already ruled on it
    if (c.verdict === "proven") {
      for (const memberId of c.memberDevisIds) {
        if (!supersedeTargets.has(memberId)) supersedeTargets.set(memberId, c.id);
      }
    } else {
      underReview.add(c.primaryDevisId);
      for (const memberId of c.memberDevisIds) underReview.add(memberId);
    }
  }

  for (const d of allDevis) {
    const supersedeCaseId = supersedeTargets.get(d.id);
    if (supersedeCaseId != null) {
      if (d.accountingState !== "superseded") {
        await storage.transitionDevisAccountingState({
          devisId: d.id,
          projectId,
          fromState: d.accountingState,
          toState: "superseded",
          reason: "proven_supersede",
          overlapCaseId: supersedeCaseId,
        });
      }
      continue;
    }
    // Promote a provisional devis to active once nothing unresolved touches it.
    // Never auto-demote `active` and never restore `superseded` (no oscillation).
    if (d.accountingState === "provisional" && !underReview.has(d.id)) {
      await storage.transitionDevisAccountingState({
        devisId: d.id,
        projectId,
        fromState: "provisional",
        toState: "active",
        reason: "reconciliation_promote",
      });
    }
  }
}

export interface ApplyHumanResolutionResult {
  ok: boolean;
  status: number;
  message?: string;
  caseId?: number;
  decision?: HumanResolutionDecision;
  superseded?: number[];
  keptActive?: number[];
}

/**
 * Apply an architect's recorded decision on an overlap case.
 *   confirm — the overlap is real: supersede the member devis (remove from
 *             Contracted) and make sure the surviving primary is active.
 *   dismiss — a false positive: keep genuinely-active money where it is
 *             (promote any still-provisional member/primary to active) and
 *             record the dismissal so the automatic pass never re-raises it as
 *             a supersession. Dismiss NEVER restores a superseded devis —
 *             adding euros back into Contracted requires its own proof or
 *             confirm, never a dismissal (no silent money-in).
 *
 * Both branches build the full set of transitions first, then apply them in a
 * single atomic, compare-and-set batch: one human decision either lands
 * completely or not at all, and a concurrent change aborts it with a 409
 * rather than partially moving money.
 */
export async function applyHumanResolution(args: {
  caseId: number;
  decision: HumanResolutionDecision;
  actorUserId: number;
  note?: string | null;
}): Promise<ApplyHumanResolutionResult> {
  const overlapCase = await storage.getOverlapCase(args.caseId);
  if (!overlapCase) {
    return { ok: false, status: 404, message: "Overlap case not found" };
  }
  // A withdrawn/stale case no longer reflects the latest detection pass —
  // resolving it could move money for an overlap that is no longer valid.
  if (overlapCase.status !== "active") {
    return {
      ok: false,
      status: 409,
      message: `Overlap case is ${overlapCase.status}; only active cases can be resolved`,
    };
  }
  const projectId = overlapCase.projectId;
  const note = args.note ?? null;
  const base = { projectId, overlapCaseId: overlapCase.id, actorUserId: args.actorUserId, note };

  const transitions: AccountingStateTransition[] = [];
  const superseded: number[] = [];
  const keptActive: number[] = [];

  if (args.decision === "confirm") {
    for (const memberId of overlapCase.memberDevisIds) {
      const member = await storage.getDevis(memberId);
      if (member && member.accountingState !== "superseded") {
        transitions.push({
          ...base,
          devisId: memberId,
          fromState: member.accountingState,
          toState: "superseded",
          reason: "human_confirm",
        });
        superseded.push(memberId);
      }
    }
    const primary = await storage.getDevis(overlapCase.primaryDevisId);
    if (primary && primary.accountingState === "provisional") {
      transitions.push({
        ...base,
        devisId: primary.id,
        fromState: "provisional",
        toState: "active",
        reason: "human_confirm",
      });
    }
  } else {
    // dismiss — promote any still-provisional devis to active; leave active /
    // superseded devis untouched.
    const ids = [overlapCase.primaryDevisId, ...overlapCase.memberDevisIds];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const d = await storage.getDevis(id);
      if (d && d.accountingState === "provisional") {
        transitions.push({
          ...base,
          devisId: id,
          fromState: "provisional",
          toState: "active",
          reason: "human_dismiss",
        });
        keptActive.push(id);
      }
    }
    // Always leave at least one `human_dismiss` audit row so the automatic pass
    // can detect the dismissal even when nothing changed state. This records
    // the decision on the primary WITHOUT moving it (fromState === toState).
    if (transitions.length === 0) {
      const primary = await storage.getDevis(overlapCase.primaryDevisId);
      const currentState = (primary?.accountingState ?? "active") as
        | "provisional"
        | "active"
        | "superseded";
      transitions.push({
        ...base,
        devisId: overlapCase.primaryDevisId,
        fromState: currentState,
        toState: currentState,
        reason: "human_dismiss",
      });
    }
  }

  try {
    await storage.applyAccountingStateTransitions(transitions);
  } catch (err: unknown) {
    if (err instanceof AccountingStateConflictError) {
      return { ok: false, status: 409, message: err.message };
    }
    throw err;
  }

  return args.decision === "confirm"
    ? { ok: true, status: 200, caseId: overlapCase.id, decision: "confirm", superseded }
    : { ok: true, status: 200, caseId: overlapCase.id, decision: "dismiss", keptActive };
}

/**
 * Project-level rollup powering the review UI's status badge. Deterministic
 * precedence: an unresolved needs_review case dominates; otherwise still-
 * provisional devis mean analysis is pending; otherwise any history of
 * supersession/dismissal means resolved; otherwise clean.
 */
export async function getProjectAccountingStatus(
  projectId: number,
): Promise<ProjectAccountingStatus> {
  const allDevis = (await storage.getDevisByProject(projectId)).filter(
    (d) => d.status !== "void",
  );
  const provisionalCount = allDevis.filter((d) => d.accountingState === "provisional").length;
  const supersededCount = allDevis.filter((d) => d.accountingState === "superseded").length;

  const activeCases = await storage.getOverlapCasesByProject(projectId, "active");
  const dismissedCaseIds = new Set(await storage.getDismissedOverlapCaseIds(projectId));
  const needsReviewCases = activeCases.filter(
    (c) => c.verdict === "needs_review" && !dismissedCaseIds.has(c.id),
  );

  let eurosAtRisk = 0;
  for (const c of needsReviewCases) {
    eurosAtRisk = roundCurrency(eurosAtRisk + (await computeOverlapCaseImpact(c)));
  }

  let status: ProjectAccountingStatus["status"];
  if (needsReviewCases.length > 0) {
    status = "needs_review";
  } else if (provisionalCount > 0) {
    status = "pending_analysis";
  } else if (supersededCount > 0 || dismissedCaseIds.size > 0) {
    status = "resolved";
  } else {
    status = "clean";
  }

  return {
    projectId,
    status,
    provisionalCount,
    supersededCount,
    needsReviewCount: needsReviewCases.length,
    eurosAtRisk,
  };
}
