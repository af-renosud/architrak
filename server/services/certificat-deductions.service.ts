import { storage } from "../storage";
import { computeCertificatDeductions, computeEffectiveTvaRatePercent } from "@shared/financial-utils";
import { assertPvReceptionForSolde } from "./pv-reception.service";
import type { Contractor, Devis, Marche } from "@shared/schema";

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
  /** Task #464 — designate this certificat as the solde (final) for its marché. */
  isSolde?: boolean;
  /**
   * Task #464 — explicit architect release of the retenue de garantie.
   * Only valid on a solde certificat (throws otherwise). Default withheld.
   */
  releaseRetenue?: boolean;
  /**
   * Task #566 — the caller holds a recorded, audited override of the PV de
   * réception gate (legacy projects). Without it, a solde certificat is
   * refused unless the marché's PV is approved with a reception date.
   */
  pvOverride?: boolean;
  /**
   * Multi-facture certificats — explicit documentary TVA basis. When the
   * certificat certifies a SELECTED set of factures, its documentary rate
   * must be derived from those documents only, never from every invoice of
   * the contractor (which could carry other periods/rates). When omitted,
   * the resolver keeps the historical whole-contractor scan.
   */
  documentaryBasisInvoices?: ReadonlyArray<{ amountHt: string; amountTtc: string }>;
  /**
   * Manual quotation fallback — the signed quotation whose scraped HT/TTC
   * values establish the documentary effective rate.
   */
  documentaryBasisDevis?: Pick<Devis, "amountHt" | "amountTtc">;
  /**
   * A previously resolved decision can be supplied by a route that locked the
   * underlying quotation/configuration before computing the final write.
   */
  resolvedTvaDecision?: ResolvedCertificatTvaDecision;
  /**
   * Historical draft compatibility only. Older drafts may carry the removed
   * architect override source; sealing preserves that recorded decision rather
   * than silently rewriting history. Public create/PATCH routes never set it.
   */
  legacyTvaDecision?: {
    ratePercent: string;
    source: Exclude<TvaRateSource, "autoliquidation">;
  };
  /** Optional locked tax context supplied by a final creation transaction. */
  lockedTvaContext?: {
    marche: Marche | null;
    contractor: Contractor | null;
  };
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

export interface ResolvedCertificatTvaDecision {
  ratePercent: number;
  autoliquidation: boolean;
  source: TvaRateSource;
}

export class TvaEvidenceRequiredError extends Error {
  readonly code = "TVA_EVIDENCE_REQUIRED";

  constructor() {
    super(
      "Aucun traitement de TVA fiable n’a pu être établi. Vérifiez les montants HT/TTC du devis signé ou configurez le taux de TVA du marché ou de l’entreprise.",
    );
    this.name = "TvaEvidenceRequiredError";
  }
}

function toNumberOrNull(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function resolveCertificatTvaDecision(
  input: Pick<
    ResolveCertificatDeductionsInput,
    | "projectId"
    | "contractorId"
    | "documentaryBasisInvoices"
    | "documentaryBasisDevis"
    | "legacyTvaDecision"
    | "lockedTvaContext"
  >,
): Promise<ResolvedCertificatTvaDecision> {
  const marches = input.lockedTvaContext
    ? input.lockedTvaContext.marche
      ? [input.lockedTvaContext.marche]
      : []
    : await storage.getMarchesByProject(input.projectId);
  const marche =
    marches.find((candidate) => candidate.contractorId === input.contractorId) ??
    null;
  const contractor = input.lockedTvaContext
    ? input.lockedTvaContext.contractor
    : await storage.getContractor(input.contractorId);

  const tvaAutoliquidation = marche?.tvaAutoliquidation
    ? true
    : marche?.tvaRatePercent != null
      ? false
      : contractor?.defaultTvaAutoliquidation ?? false;
  if (tvaAutoliquidation) {
    return {
      ratePercent: 0,
      autoliquidation: true,
      source: "autoliquidation",
    };
  }

  // Historical/source-less decisions are not part of automatic creation.
  // Internal seal/reissue/PATCH callers use them only when no exact persisted
  // invoice source exists. Autoliquidation still wins above, but unrelated
  // invoices or later configuration must not rewrite the recorded decision.
  if (input.legacyTvaDecision) {
    const legacyRate = toNumberOrNull(input.legacyTvaDecision.ratePercent);
    if (legacyRate != null) {
      return {
        ratePercent: legacyRate,
        autoliquidation: false,
        source: input.legacyTvaDecision.source,
      };
    }
  }

  let documentaryTvaRatePercent: number | null = null;
  if (input.documentaryBasisInvoices !== undefined) {
    let sumHt = 0;
    let sumTtc = 0;
    for (const invoice of input.documentaryBasisInvoices) {
      sumHt += parseFloat(invoice.amountHt) || 0;
      sumTtc += parseFloat(invoice.amountTtc) || 0;
    }
    documentaryTvaRatePercent = computeEffectiveTvaRatePercent(sumHt, sumTtc);
  } else if (input.documentaryBasisDevis) {
    documentaryTvaRatePercent = computeEffectiveTvaRatePercent(
      parseFloat(input.documentaryBasisDevis.amountHt),
      parseFloat(input.documentaryBasisDevis.amountTtc),
    );
  } else {
    // Legacy/global manual path: documentary evidence may come from existing
    // contractor invoices. Source-backed creation always passes its exact set.
    const devisList = await storage.getDevisByProject(input.projectId);
    let sumHt = 0;
    let sumTtc = 0;
    for (const devis of devisList) {
      if (devis.contractorId !== input.contractorId) continue;
      if (devis.status === "void" || devis.signOffStage === "void") continue;
      const invoices = await storage.getInvoicesByDevis(devis.id);
      for (const invoice of invoices) {
        sumHt += parseFloat(invoice.amountHt) || 0;
        sumTtc += parseFloat(invoice.amountTtc) || 0;
      }
    }
    documentaryTvaRatePercent = computeEffectiveTvaRatePercent(sumHt, sumTtc);
  }

  if (documentaryTvaRatePercent != null) {
    return {
      ratePercent: documentaryTvaRatePercent,
      autoliquidation: false,
      source: "documentary",
    };
  }

  const marcheRate = toNumberOrNull(marche?.tvaRatePercent);
  if (marcheRate != null) {
    return {
      ratePercent: marcheRate,
      autoliquidation: false,
      source: "marche",
    };
  }

  const contractorRate = toNumberOrNull(contractor?.defaultTvaRatePercent);
  if (contractorRate != null) {
    return {
      ratePercent: contractorRate,
      autoliquidation: false,
      source: "contractor",
    };
  }

  throw new TvaEvidenceRequiredError();
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
  ).filter(
    (c) =>
      c.id !== input.excludeCertificatId &&
      c.status !== "superseded" &&
      // Task #491 — acompte certificats live outside the progress waterfall:
      // their zero retenue/prorata/recoupment cumulatives must never become
      // "the prior cumulative" for the next progress certificat. The deposit
      // they pay is recovered through the paid-acompte recoupment path, not
      // through previousPayments.
      c.acompteDevisId == null,
  );

  // Task #464 — solde preconditions. At most one non-superseded solde
  // certificat per (project, contractor) — friendly check here, race-free
  // enforcement by the partial unique index `certificats_solde_unique`.
  // A retenue release is only meaningful on the solde certificat.
  const isSolde = input.isSolde === true;
  const releaseRetenue = input.releaseRetenue === true;
  if (isSolde) {
    const existingSolde = priorCerts.find((c) => c.isSolde);
    if (existingSolde) throw new SoldeConflictError(existingSolde.certificateRef);
    // Task #566 — final payment is gated on the formalised réception des
    // travaux: the marché must carry an APPROVED PV de réception (with its
    // reception date) unless the caller recorded an audited override.
    assertPvReceptionForSolde(marche, input.pvOverride === true);
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

  const tvaDecision =
    input.resolvedTvaDecision ??
    (await resolveCertificatTvaDecision(input));

  const result = computeCertificatDeductions({
    tvaRate: tvaDecision.ratePercent / 100,
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
    tvaRatePercent: tvaDecision.ratePercent.toFixed(2),
    tvaAutoliquidation: tvaDecision.autoliquidation,
    tvaRateSource: tvaDecision.source,
    isSolde,
    retenueReleased: isSolde && releaseRetenue,
    retenueReleaseAmount: result.retenueReleaseAmount.toFixed(2),
    netToPayHt: result.netToPayHt.toFixed(2),
    tvaAmount: result.tvaAmount.toFixed(2),
    netToPayTtc: result.netToPayTtc.toFixed(2),
  };
}
