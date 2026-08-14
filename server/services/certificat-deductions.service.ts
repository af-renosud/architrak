import { storage } from "../storage";
import { computeCertificatDeductions } from "@shared/financial-utils";

/**
 * Task #243 — Server-side authoritative resolver for a certificat's deductions.
 *
 * The frontend is no longer trusted as the source of truth for money. This
 * resolver gathers the contractual rates (project Compte Prorata rate, the
 * contractor's marché Retenue de Garantie rate + bypass/exemption flags) and
 * the prior certificats for the same (project, contractor) pair, then delegates
 * the pure cumulative math to `shared/financial-utils`.
 *
 * Cumulative-first: deductions are computed on the gross cumulative works and
 * the per-period movement is `cumulative − Σ(prior period deductions)`. Summing
 * prior PERIOD figures (rather than reading a single prior cumulative) keeps the
 * running total self-correcting if a rate changes mid-project.
 */
const DEFAULT_RETENUE_PERCENT = 5;

export interface ResolveCertificatDeductionsInput {
  projectId: number;
  contractorId: number;
  totalWorksHt: string;
  pvMvAdjustment?: string | null;
  previousPayments?: string | null;
  /** Explicit architect override of the cumulative Retenue de Garantie. */
  retenueOverride?: string | null;
  /** Explicit architect override of the cumulative Compte Prorata. */
  prorataOverride?: string | null;
  /**
   * Task #463 — explicit architect override of the applied TVA rate (%).
   * Draft-only (routes reject financial changes on sealed certificats).
   * Ignored when the resolved regime is autoliquidation: the 0% rate is a
   * legal consequence of art. 283 CGI, not an architect preference.
   */
  tvaRateOverride?: string | null;
  /** When recomputing an existing certificat, exclude it from the prior set. */
  excludeCertificatId?: number;
}

export interface ResolvedCertificatDeductions {
  retenueGarantie: string;
  cumulativeProrataDeduction: string;
  periodProrataDeduction: string;
  cumulativeAcompteRecoupment: string;
  periodAcompteRecoupment: string;
  /** Task #463 — the TVA rate (%) actually applied; audit trail. */
  tvaRatePercent: string;
  tvaAutoliquidation: boolean;
  netToPayHt: string;
  tvaAmount: string;
  netToPayTtc: string;
}

function toNumberOrNull(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function resolveCertificatDeductions(
  input: ResolveCertificatDeductionsInput,
): Promise<ResolvedCertificatDeductions> {
  const project = await storage.getProject(input.projectId);
  if (!project) throw new Error(`Project ${input.projectId} not found`);

  const marches = await storage.getMarchesByProject(input.projectId);
  const marche = marches.find((m) => m.contractorId === input.contractorId) ?? null;

  // Task #457 — superseded certificats were replaced by a reissue; their
  // cumulative figures are corrected history and must never feed a later
  // certificat's math (the replacement carries the corrected cumulatives).
  const priorCerts = (
    await storage.getCertificatsByProjectAndContractor(input.projectId, input.contractorId)
  ).filter((c) => c.id !== input.excludeCertificatId && c.status !== "superseded");

  // Both `retenueGarantie` and `cumulativeProrataDeduction` store the
  // cumulative-to-date figure on each certificat, so the *latest* prior
  // certificat already carries the true prior cumulative state. We must read
  // that single latest row rather than reduce with max()/sum: a downward
  // architect override or a guarantee/exemption transition can make the
  // cumulative legitimately decrease, and max()/sum would then over-count and
  // break the `period = cumulative − prior` invariant. Order by issue date,
  // then by id as a stable tiebreaker (drafts may share / lack a dateIssued).
  const latestPrior = priorCerts
    .slice()
    .sort((a, b) => {
      const da = a.dateIssued ?? "";
      const db = b.dateIssued ?? "";
      if (da !== db) return da < db ? -1 : 1;
      return a.id - b.id;
    })
    .at(-1) ?? null;

  const priorCumulativeRetenue = latestPrior
    ? parseFloat(latestPrior.retenueGarantie ?? "0")
    : 0;
  const priorCumulativeProrata = latestPrior
    ? parseFloat(latestPrior.cumulativeProrataDeduction ?? "0")
    : 0;
  const priorCumulativeAcompteRecoupment = latestPrior
    ? parseFloat(latestPrior.cumulativeAcompteRecoupment ?? "0")
    : 0;

  // Task #462 — total deposit actually PAID on this contractor's devis and
  // NOT yet recovered elsewhere. Only 'paid' counts: 'applied' is terminal
  // and means the deposit was already fully deducted through the invoice
  // deduction path ("déduction acompte versé"), so counting it here would
  // recover the same deposit a second time. Void devis are excluded: their
  // deposits are handled through the credit-note path.
  const devisList = await storage.getDevisByProject(input.projectId);
  const paidAcompteAmount = devisList
    .filter((d) =>
      d.contractorId === input.contractorId &&
      d.status !== "void" &&
      d.signOffStage !== "void" &&
      d.acompteState === "paid",
    )
    .reduce((sum, d) => sum + (parseFloat(d.acompteAmountHt ?? "0") || 0), 0);

  // Task #463 — TVA regime resolution: marché-specific rate → contractor
  // default → standard 20%. Autoliquidation (art. 283 CGI — sous-traitance
  // BTP) forces 0%: the TVA is due by the client/main contractor, and no
  // architect override may reinstate a rate on an autoliquidation contract.
  // The marché flag is NOT NULL (default false), so a bare `??` chain would
  // never reach the contractor default. Rule: an explicit marché autoliq flag
  // or an explicit marché rate is a contract-level decision that wins; only a
  // marché with NO explicit regime (or no marché at all) falls back to the
  // contractor default.
  const contractor = await storage.getContractor(input.contractorId);
  const tvaAutoliquidation = marche?.tvaAutoliquidation
    ? true
    : marche?.tvaRatePercent != null
      ? false
      : contractor?.defaultTvaAutoliquidation ?? false;
  const resolvedTvaRatePercent = tvaAutoliquidation
    ? 0
    : toNumberOrNull(input.tvaRateOverride)
      ?? toNumberOrNull(marche?.tvaRatePercent)
      ?? toNumberOrNull(contractor?.defaultTvaRatePercent)
      ?? 20;

  const result = computeCertificatDeductions({
    tvaRate: resolvedTvaRatePercent / 100,
    totalWorksHt: parseFloat(input.totalWorksHt || "0"),
    pvMvAdjustment: parseFloat(input.pvMvAdjustment ?? "0") || 0,
    previousPayments: parseFloat(input.previousPayments ?? "0") || 0,
    retenuePercent: marche?.retenueGarantiePercent != null
      ? parseFloat(marche.retenueGarantiePercent)
      : DEFAULT_RETENUE_PERCENT,
    hasBankGuarantee: marche?.hasBankGuarantee ?? false,
    prorataPercent: parseFloat(project.prorataPercentage ?? "0") || 0,
    isProrataManager: marche?.isProrataManager ?? false,
    priorCumulativeRetenue,
    priorCumulativeProrata,
    retenueOverride: toNumberOrNull(input.retenueOverride),
    prorataOverride: toNumberOrNull(input.prorataOverride),
    paidAcompteAmount,
    priorCumulativeAcompteRecoupment,
    acompteRecoupmentRule: (marche?.acompteRecoupmentRule as "asap" | "percent" | "progress_threshold" | undefined) ?? "asap",
    acompteRecoupmentPercent: toNumberOrNull(marche?.acompteRecoupmentPercent),
    acompteRecoupmentThresholdPercent: toNumberOrNull(marche?.acompteRecoupmentThresholdPercent),
    contractTotalHt: toNumberOrNull(marche?.totalHt),
  });

  return {
    retenueGarantie: result.cumulativeRetenue.toFixed(2),
    cumulativeProrataDeduction: result.cumulativeProrata.toFixed(2),
    periodProrataDeduction: result.periodProrata.toFixed(2),
    cumulativeAcompteRecoupment: result.cumulativeAcompteRecoupment.toFixed(2),
    periodAcompteRecoupment: result.periodAcompteRecoupment.toFixed(2),
    tvaRatePercent: resolvedTvaRatePercent.toFixed(2),
    tvaAutoliquidation,
    netToPayHt: result.netToPayHt.toFixed(2),
    tvaAmount: result.tvaAmount.toFixed(2),
    netToPayTtc: result.netToPayTtc.toFixed(2),
  };
}
