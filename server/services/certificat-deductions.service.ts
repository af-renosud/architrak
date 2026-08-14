import { storage } from "../storage";
import { computeCertificatDeductions, computeEffectiveTvaRatePercent } from "@shared/financial-utils";

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
  /** Task #464 — designate this certificat as the solde (final) for its marché. */
  isSolde?: boolean;
  /**
   * Task #464 — explicit architect release of the retenue de garantie.
   * Only valid on a solde certificat (throws otherwise). Default withheld.
   */
  releaseRetenue?: boolean;
}

/** Task #464 — a non-superseded solde certificat already exists for the pair. */
export class SoldeConflictError extends Error {
  constructor(public readonly existingCertificateRef: string) {
    super(
      `Un certificat de solde (${existingCertificateRef}) existe déjà pour cette entreprise — un seul certificat de solde par marché.`,
    );
    this.name = "SoldeConflictError";
  }
}

/** Task #464 — retenue release requested on a non-solde certificat. */
export class ReleaseRequiresSoldeError extends Error {
  constructor() {
    super("La libération de la retenue de garantie n'est possible que sur le certificat de solde.");
    this.name = "ReleaseRequiresSoldeError";
  }
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
  /** Task #479 — which source produced the applied rate. */
  tvaRateSource: TvaRateSource;
  /** Task #464 — solde designation + retenue release state, server-derived. */
  isSolde: boolean;
  retenueReleased: boolean;
  retenueReleaseAmount: string;
  netToPayHt: string;
  tvaAmount: string;
  netToPayTtc: string;
}

export type TvaRateSource =
  | "autoliquidation"
  | "override"
  | "documentary"
  | "marche"
  | "contractor"
  | "default";

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

  // Task #464 — solde preconditions. At most one non-superseded solde
  // certificat per (project, contractor) — friendly check here, race-free
  // enforcement by the partial unique index `certificats_solde_unique`.
  // A retenue release is only meaningful on the solde certificat.
  const isSolde = input.isSolde === true;
  const releaseRetenue = input.releaseRetenue === true;
  if (isSolde) {
    const existingSolde = priorCerts.find((c) => c.isSolde);
    if (existingSolde) throw new SoldeConflictError(existingSolde.certificateRef);
  }
  if (releaseRetenue && !isSolde) throw new ReleaseRequiresSoldeError();

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

  // Task #479 — documentary effective rate. Contractors routinely issue
  // mixed-rate invoices (10% rénovation + 20% supplies, sometimes 5.5%);
  // a single configured/statutory rate then misstates the tax the client
  // owes. The invoices' HT/TTC (source of truth since Task #78) encode the
  // real blended rate: (ΣTTC − ΣHT) / ΣHT over the same invoice set the
  // certificat annexe renders (all invoices of the contractor's non-void
  // devis). Null when there is no usable evidence — see the shared helper.
  // The rate is applied to the post-deduction net HT, so partial-progress
  // certificats automatically pro-rate the documentary rate to the
  // certified base.
  let documentaryTvaRatePercent: number | null = null;
  if (!tvaAutoliquidation) {
    let sumHt = 0;
    let sumTtc = 0;
    for (const d of devisList) {
      if (d.contractorId !== input.contractorId) continue;
      if (d.status === "void" || d.signOffStage === "void") continue;
      const invoices = await storage.getInvoicesByDevis(d.id);
      for (const inv of invoices) {
        sumHt += parseFloat(inv.amountHt) || 0;
        sumTtc += parseFloat(inv.amountTtc) || 0;
      }
    }
    documentaryTvaRatePercent = computeEffectiveTvaRatePercent(sumHt, sumTtc);
  }

  // Task #463/#479 — precedence: autoliquidation (art. 283 CGI, legal) →
  // architect draft override → documentary effective rate (real invoice
  // evidence beats configured expectations) → marché rate → contractor
  // default → statutory 20% as documented last resort.
  const overrideRate = toNumberOrNull(input.tvaRateOverride);
  const marcheRate = toNumberOrNull(marche?.tvaRatePercent);
  const contractorRate = toNumberOrNull(contractor?.defaultTvaRatePercent);
  let resolvedTvaRatePercent: number;
  let tvaRateSource: TvaRateSource;
  if (tvaAutoliquidation) {
    resolvedTvaRatePercent = 0;
    tvaRateSource = "autoliquidation";
  } else if (overrideRate != null) {
    resolvedTvaRatePercent = overrideRate;
    tvaRateSource = "override";
  } else if (documentaryTvaRatePercent != null) {
    resolvedTvaRatePercent = documentaryTvaRatePercent;
    tvaRateSource = "documentary";
  } else if (marcheRate != null) {
    resolvedTvaRatePercent = marcheRate;
    tvaRateSource = "marche";
  } else if (contractorRate != null) {
    resolvedTvaRatePercent = contractorRate;
    tvaRateSource = "contractor";
  } else {
    resolvedTvaRatePercent = 20;
    tvaRateSource = "default";
  }

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
    isSolde,
    releaseRetenue,
  });

  return {
    retenueGarantie: result.cumulativeRetenue.toFixed(2),
    cumulativeProrataDeduction: result.cumulativeProrata.toFixed(2),
    periodProrataDeduction: result.periodProrata.toFixed(2),
    cumulativeAcompteRecoupment: result.cumulativeAcompteRecoupment.toFixed(2),
    periodAcompteRecoupment: result.periodAcompteRecoupment.toFixed(2),
    tvaRatePercent: resolvedTvaRatePercent.toFixed(2),
    tvaAutoliquidation,
    tvaRateSource,
    isSolde,
    retenueReleased: isSolde && releaseRetenue,
    retenueReleaseAmount: result.retenueReleaseAmount.toFixed(2),
    netToPayHt: result.netToPayHt.toFixed(2),
    tvaAmount: result.tvaAmount.toFixed(2),
    netToPayTtc: result.netToPayTtc.toFixed(2),
  };
}
