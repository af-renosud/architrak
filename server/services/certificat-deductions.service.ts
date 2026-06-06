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
  /** When recomputing an existing certificat, exclude it from the prior set. */
  excludeCertificatId?: number;
}

export interface ResolvedCertificatDeductions {
  retenueGarantie: string;
  cumulativeProrataDeduction: string;
  periodProrataDeduction: string;
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

  const priorCerts = (
    await storage.getCertificatsByProjectAndContractor(input.projectId, input.contractorId)
  ).filter((c) => c.id !== input.excludeCertificatId);

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

  const result = computeCertificatDeductions({
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
  });

  return {
    retenueGarantie: result.cumulativeRetenue.toFixed(2),
    cumulativeProrataDeduction: result.cumulativeProrata.toFixed(2),
    periodProrataDeduction: result.periodProrata.toFixed(2),
    netToPayHt: result.netToPayHt.toFixed(2),
    tvaAmount: result.tvaAmount.toFixed(2),
    netToPayTtc: result.netToPayTtc.toFixed(2),
  };
}
