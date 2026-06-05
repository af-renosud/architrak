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
import type {
  ProjectReviewCasesResponse,
  ResolvedReviewCard,
  ReviewCard,
  ReviewDevisSummary,
} from "@shared/reconciliation-dto";

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
    if (c.verdict === "proven") {
      // Arithmetic proof ALWAYS applies — even if this case was dismissed earlier
      // while it was still `needs_review`. Case identity is stable by caseKey, so
      // later amount/avenant edits can flip a dismissed case to `proven`; the
      // stale dismissal must not keep a now-proven duplicate in Contracted.
      for (const memberId of c.memberDevisIds) {
        if (!supersedeTargets.has(memberId)) supersedeTargets.set(memberId, c.id);
      }
    } else if (!dismissedCaseIds.has(c.id)) {
      // needs_review and NOT yet ruled on by an architect → leave provisional.
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
  // A `proven` overlap reconciles to the exact euro and is auto-superseded by
  // reconcileAccountingStates. Accepting a human decision here — especially a
  // `dismiss` — would record dismissal metadata that suppresses the automatic
  // pass, leaving the duplicate counted in Contracted forever. Only genuinely
  // ambiguous (`needs_review`) cases require a human verdict.
  if (overlapCase.verdict !== "needs_review") {
    return {
      ok: false,
      status: 409,
      message: `Overlap case verdict is '${overlapCase.verdict}'; only needs_review cases accept a human decision (proven cases auto-resolve)`,
    };
  }
  const projectId = overlapCase.projectId;
  const note = args.note ?? null;
  const base = { projectId, overlapCaseId: overlapCase.id, actorUserId: args.actorUserId, note };

  // A devis can participate in more than one overlap case. Resolving THIS case
  // must never promote a provisional devis to `active` while another unresolved
  // (active, non-dismissed, needs_review) case still touches it — that other
  // case might yet supersede it, and the automatic pass never demotes `active`
  // back to `provisional`, so the premature promotion would skew Contracted
  // permanently. Build the set of devis still tied up elsewhere and gate every
  // promotion on it (mirrors reconcileAccountingStates' `underReview`).
  const otherActiveCases = await storage.getOverlapCasesByProject(projectId, "active");
  const dismissedCaseIds = new Set(await storage.getDismissedOverlapCaseIds(projectId));
  const stillUnderReview = new Set<number>();
  for (const c of otherActiveCases) {
    if (c.id === overlapCase.id) continue;
    if (dismissedCaseIds.has(c.id)) continue;
    if (c.verdict !== "needs_review") continue;
    stillUnderReview.add(c.primaryDevisId);
    for (const memberId of c.memberDevisIds) stillUnderReview.add(memberId);
  }

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
    if (primary && primary.accountingState === "provisional" && !stillUnderReview.has(primary.id)) {
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
      if (d && d.accountingState === "provisional" && !stillUnderReview.has(id)) {
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
  // Exclude EVERY humanly-resolved case (confirm or dismiss), not just dismissed
  // ones: a confirm supersedes members but leaves the case active/needs_review
  // (detection re-detects it), so a confirmed case would otherwise linger in the
  // rollup forever even though the architect has already decided it.
  const resolvedCaseIds = new Set(await storage.getResolvedOverlapCaseIds(projectId));
  const needsReviewCases = activeCases.filter(
    (c) => c.verdict === "needs_review" && !resolvedCaseIds.has(c.id),
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
  } else if (supersededCount > 0 || resolvedCaseIds.size > 0) {
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

/**
 * Task #233 — enriched review cards for the Needs Review UI. Returns the open
 * cases that genuinely need a human decision (active, `needs_review`, not yet
 * dismissed — proven cases auto-resolve and are intentionally excluded), plus
 * the cases an architect has already ruled on (for the audit history view).
 *
 * Each card carries lightweight devis/contractor summaries (NEVER banking or
 * sensitive fields) so the front end can render the side-by-side evidence and
 * the financial-impact line without N+1 fetches.
 */
export async function getProjectReviewCases(
  projectId: number,
): Promise<ProjectReviewCasesResponse> {
  const devisCache = new Map<number, Devis | undefined>();
  const getDevisCached = async (id: number): Promise<Devis | undefined> => {
    if (!devisCache.has(id)) devisCache.set(id, await storage.getDevis(id));
    return devisCache.get(id);
  };

  const contractorNameCache = new Map<number, string>();
  const contractorName = async (id: number): Promise<string> => {
    const cached = contractorNameCache.get(id);
    if (cached != null) return cached;
    const c = await storage.getContractor(id);
    const name = c?.name ?? `Contractor #${id}`;
    contractorNameCache.set(id, name);
    return name;
  };

  const summarise = async (id: number): Promise<ReviewDevisSummary | null> => {
    const d = await getDevisCached(id);
    if (!d) return null;
    return {
      id: d.id,
      devisCode: d.devisCode,
      contractorId: d.contractorId,
      contractorName: await contractorName(d.contractorId),
      descriptionFr: d.descriptionFr,
      amountHt: d.amountHt,
      amountTtc: d.amountTtc,
      accountingState: d.accountingState as ReviewDevisSummary["accountingState"],
    };
  };

  const activeCases = await storage.getOverlapCasesByProject(projectId, "active");
  // A case stays active/needs_review even after a human confirm (its superseded
  // members are still re-detected), so exclude every humanly-resolved case —
  // confirm AND dismiss — to keep the open queue to genuinely-undecided cases.
  const resolvedCaseIds = new Set(await storage.getResolvedOverlapCaseIds(projectId));

  const openCases: ReviewCard[] = [];
  for (const c of activeCases) {
    if (c.verdict !== "needs_review" || resolvedCaseIds.has(c.id)) continue;
    const members: ReviewDevisSummary[] = [];
    for (const memberId of c.memberDevisIds) {
      const s = await summarise(memberId);
      if (s) members.push(s);
    }
    openCases.push({
      id: c.id,
      relationshipType: c.relationshipType as ReviewCard["relationshipType"],
      detectionSource: c.detectionSource as ReviewCard["detectionSource"],
      confidence: c.confidence,
      verdict: c.verdict as ReviewCard["verdict"],
      reasoning: c.reasoning,
      arithmeticProof: c.arithmeticProof ?? null,
      citations: c.citations,
      impactEuros: await computeOverlapCaseImpact(c),
      primary: await summarise(c.primaryDevisId),
      members,
      lastSeenAt: c.lastSeenAt.toISOString(),
    });
  }

  // Resolved cards — latest human decision per overlap case. Newest-first rows,
  // so the first row seen for a case id is its current decision.
  const decisions = await storage.getHumanResolvedOverlapDecisions(projectId);
  const actorEmailCache = new Map<number, string | null>();
  const actorEmail = async (userId: number): Promise<string | null> => {
    if (actorEmailCache.has(userId)) return actorEmailCache.get(userId) ?? null;
    const u = await storage.getUser(userId);
    const email = u?.email ?? null;
    actorEmailCache.set(userId, email);
    return email;
  };

  const resolvedCases: ResolvedReviewCard[] = [];
  const seenCaseIds = new Set<number>();
  for (const change of decisions) {
    const caseId = change.overlapCaseId;
    if (caseId == null || seenCaseIds.has(caseId)) continue;
    seenCaseIds.add(caseId);
    const c = await storage.getOverlapCase(caseId);
    if (!c) continue;
    const members: ReviewDevisSummary[] = [];
    for (const memberId of c.memberDevisIds) {
      const s = await summarise(memberId);
      if (s) members.push(s);
    }
    resolvedCases.push({
      id: c.id,
      relationshipType: c.relationshipType as ResolvedReviewCard["relationshipType"],
      reasoning: c.reasoning,
      primary: await summarise(c.primaryDevisId),
      members,
      decision: change.reason === "human_confirm" ? "confirm" : "dismiss",
      decidedAt: change.createdAt.toISOString(),
      actorEmail: change.actorUserId != null ? await actorEmail(change.actorUserId) : null,
      note: change.note,
    });
  }

  return { projectId, openCases, resolvedCases };
}
