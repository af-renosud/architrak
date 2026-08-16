import { storage } from "../storage";
import { roundCurrency } from "../../shared/financial-utils";

/**
 * Task #546 — acompte (opening-deposit) certificats in the Certified figures.
 *
 * "Certified" was historically the sum of factures per devis. An acompte
 * certificat is issued straight from the devis with NO facture behind it, so
 * a client could receive a 1 488 € payment demand whose own project summary
 * table said 0,00 € certified. Fix: each devis's certified figure also
 * carries the OUTSTANDING part of its acompte certificat.
 *
 * Arithmetic (recoupment-aware, so progress work never double-counts):
 *   outstanding = acompte works HT − recouped-to-date
 * where recouped-to-date comes from the latest issued (ready/sent/paid),
 * non-superseded PROGRESS certificat of the same contractor — its
 * `cumulativeAcompteRecoupment` is a cumulative-to-date figure, mirroring the
 * deduction resolver's latest-prior convention (never max()/sum()). Once the
 * deposit is fully recouped the underlying works are certified through
 * factures, so certified degrades exactly to the invoice sum. A devis whose
 * `acompteState` is `applied` (deposit already recovered through the invoice
 * deduction path) contributes 0 outright.
 *
 * Status gate: acompte certificats count from issuance onward (ready/sent/
 * paid; superseded excluded per the reissue conventions). Drafts never count
 * on dashboards — but the issuance render happens while the row is still
 * `draft` (the seal flips status only after the PDF commits), so callers
 * generating a certificat's own PDF pass `treatAsIssuedCertificatIds` to let
 * that certificat appear in its own whole-project table.
 */
export interface AcompteCertificatLike {
  id: number;
  acompteDevisId: number | null;
  contractorId: number;
  status: string;
  totalWorksHt: string;
  tvaRatePercent: string | null;
  cumulativeAcompteRecoupment: string | null;
  dateIssued: string | null;
}

export interface AcompteDevisLike {
  id: number;
  acompteState: string | null;
}

/** Per-devis outstanding acompte amounts. Exported for unit tests. */
export function computeAcompteCertifiedByDevis(
  certificats: ReadonlyArray<AcompteCertificatLike>,
  devisList: ReadonlyArray<AcompteDevisLike>,
  treatAsIssuedCertificatIds: ReadonlyArray<number> = [],
): Map<number, { ht: number; ttc: number }> {
  const ISSUED = new Set(["ready", "sent", "paid"]);
  const treatAsIssued = new Set(treatAsIssuedCertificatIds);
  const acompteStateByDevis = new Map(devisList.map(d => [d.id, d.acompteState]));

  const acompteCerts = certificats.filter(
    c =>
      c.acompteDevisId != null &&
      c.status !== "superseded" &&
      (ISSUED.has(c.status) || treatAsIssued.has(c.id)),
  );

  // Recouped-to-date per contractor: cumulative figure on the LATEST issued,
  // non-superseded progress certificat (same latest-prior rule as the
  // deduction resolver — cumulatives can legitimately decrease on reissue,
  // so max()/sum() would over-count).
  const byIssueOrder = (a: AcompteCertificatLike, b: AcompteCertificatLike) => {
    const da = a.dateIssued ?? "";
    const db = b.dateIssued ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return a.id - b.id;
  };
  const recoupedByContractor = new Map<number, number>();
  // treatAsIssued applies here too: a progress certificat being sealed is
  // still `draft` while its own PDF renders, but its recoupment figure was
  // just authoritatively recomputed and its invoice already counts — so its
  // own whole-project table must apply it, or the acompte double-counts.
  const issuedProgress = certificats
    .filter(c => c.acompteDevisId == null && c.status !== "superseded" && (ISSUED.has(c.status) || treatAsIssued.has(c.id)))
    .sort(byIssueOrder);
  for (const c of issuedProgress) {
    // Sorted ascending, so each write leaves the LATEST certificat's figure.
    recoupedByContractor.set(c.contractorId, parseFloat(c.cumulativeAcompteRecoupment ?? "0") || 0);
  }

  // Allocate each contractor's recouped total across their acompte
  // certificats oldest-first (deterministic waterfall). With one acompte per
  // contractor — the common case — this is exact.
  const result = new Map<number, { ht: number; ttc: number }>();
  const byContractor = new Map<number, AcompteCertificatLike[]>();
  for (const c of acompteCerts) {
    const list = byContractor.get(c.contractorId) ?? [];
    list.push(c);
    byContractor.set(c.contractorId, list);
  }
  for (const [contractorId, certs] of Array.from(byContractor.entries())) {
    let remainingRecouped = recoupedByContractor.get(contractorId) ?? 0;
    for (const cert of certs.sort(byIssueOrder)) {
      const devisId = cert.acompteDevisId!;
      const worksHt = parseFloat(cert.totalWorksHt) || 0;
      let outstandingHt: number;
      if (acompteStateByDevis.get(devisId) === "applied") {
        // Deposit fully recovered through the invoice deduction path.
        outstandingHt = 0;
      } else {
        const recoupedHere = Math.min(Math.max(remainingRecouped, 0), worksHt);
        remainingRecouped -= recoupedHere;
        outstandingHt = roundCurrency(Math.max(0, worksHt - recoupedHere));
      }
      if (outstandingHt <= 0) continue;
      const tvaRate = parseFloat(cert.tvaRatePercent ?? "20");
      const outstandingTtc = roundCurrency(outstandingHt * (1 + (Number.isFinite(tvaRate) ? tvaRate : 20) / 100));
      const prev = result.get(devisId) ?? { ht: 0, ttc: 0 };
      result.set(devisId, {
        ht: roundCurrency(prev.ht + outstandingHt),
        ttc: roundCurrency(prev.ttc + outstandingTtc),
      });
    }
  }
  return result;
}

export async function getProjectFinancialSummary(
  projectId: number,
  opts?: { treatAsIssuedCertificatIds?: number[] },
) {
  const project = await storage.getProject(projectId);
  if (!project) {
    return { success: false, status: 404, data: { message: "Project not found" } };
  }

  const devisList = await storage.getDevisByProject(projectId);
  const projectInvoices = await storage.getInvoicesByProject(projectId);
  const projectCertificats = await storage.getCertificatsByProject(projectId);
  const acompteByDevis = computeAcompteCertifiedByDevis(
    projectCertificats,
    devisList,
    opts?.treatAsIssuedCertificatIds ?? [],
  );

  const devisSummaries = await Promise.all(
    devisList.map(async (d) => {
      const avs = await storage.getAvenantsByDevis(d.id);
      const devisInvoices = projectInvoices.filter((inv) => inv.devisId === d.id);

      const originalHt = parseFloat(d.amountHt);
      const originalTtc = parseFloat(d.amountTtc);
      const approvedAvenants = avs.filter((a) => a.status === "approved");
      const pvAvs = approvedAvenants.filter((a) => a.type === "pv");
      const mvAvs = approvedAvenants.filter((a) => a.type === "mv");
      const pvTotal = pvAvs.reduce((sum, a) => sum + parseFloat(a.amountHt), 0);
      const mvTotal = mvAvs.reduce((sum, a) => sum + parseFloat(a.amountHt), 0);
      const pvTotalTtc = pvAvs.reduce((sum, a) => sum + parseFloat(a.amountTtc), 0);
      const mvTotalTtc = mvAvs.reduce((sum, a) => sum + parseFloat(a.amountTtc), 0);
      const adjustedHt = roundCurrency(originalHt + pvTotal - mvTotal);
      const adjustedTtc = roundCurrency(originalTtc + pvTotalTtc - mvTotalTtc);

      // Task #546 — certified = factures + outstanding acompte (see
      // computeAcompteCertifiedByDevis above).
      const acompte = acompteByDevis.get(d.id) ?? { ht: 0, ttc: 0 };
      const certifiedHt = roundCurrency(
        devisInvoices.reduce((sum, inv) => sum + parseFloat(inv.amountHt), 0) + acompte.ht,
      );
      const certifiedTtc = roundCurrency(
        devisInvoices.reduce((sum, inv) => sum + parseFloat(inv.amountTtc), 0) + acompte.ttc,
      );

      const resteARealiser = roundCurrency(adjustedHt - certifiedHt);
      const resteARealiserTtc = roundCurrency(adjustedTtc - certifiedTtc);

      return {
        devisId: d.id,
        devisCode: d.devisCode,
        descriptionFr: d.descriptionFr,
        descriptionUk: d.descriptionUk,
        status: d.status,
        accountingState: d.accountingState,
        signOffStage: d.signOffStage,
        contractorId: d.contractorId,
        invoicingMode: d.invoicingMode,
        originalHt,
        originalTtc,
        pvTotal,
        mvTotal,
        adjustedHt,
        adjustedTtc,
        certifiedHt,
        certifiedTtc,
        acompteCertifiedHt: acompte.ht,
        acompteCertifiedTtc: acompte.ttc,
        resteARealiser,
        resteARealiserTtc,
        invoiceCount: devisInvoices.length,
        avenantCount: avs.length,
      };
    })
  );

  // Task #232 — Contracted guard. Only genuinely-active devis count toward the
  // buckets: `provisional` (freshly ingested, not yet reconciled) and
  // `superseded` (folded into another devis) are excluded, as are `void` ones.
  // Existing rows backfill to `active`, so historic behaviour is unchanged.
  const activeDevis = devisSummaries.filter(
    ds => ds.accountingState === "active" && ds.status !== "void",
  );
  const totals = activeDevis.reduce(
    (acc, ds) => ({
      totalContractedHt: acc.totalContractedHt + ds.adjustedHt,
      totalContractedTtc: acc.totalContractedTtc + ds.adjustedTtc,
      totalCertifiedHt: acc.totalCertifiedHt + ds.certifiedHt,
      totalCertifiedTtc: acc.totalCertifiedTtc + ds.certifiedTtc,
      totalResteARealiser: acc.totalResteARealiser + ds.resteARealiser,
      totalResteARealiserTtc: acc.totalResteARealiserTtc + ds.resteARealiserTtc,
      totalOriginalHt: acc.totalOriginalHt + ds.originalHt,
      totalOriginalTtc: acc.totalOriginalTtc + ds.originalTtc,
      totalPv: acc.totalPv + ds.pvTotal,
      totalMv: acc.totalMv + ds.mvTotal,
    }),
    {
      totalContractedHt: 0,
      totalContractedTtc: 0,
      totalCertifiedHt: 0,
      totalCertifiedTtc: 0,
      totalResteARealiser: 0,
      totalResteARealiserTtc: 0,
      totalOriginalHt: 0,
      totalOriginalTtc: 0,
      totalPv: 0,
      totalMv: 0,
    }
  );

  return {
    success: true,
    status: 200,
    data: {
      projectId,
      projectName: project.name,
      projectCode: project.code,
      devis: devisSummaries,
      ...totals,
    },
  };
}
