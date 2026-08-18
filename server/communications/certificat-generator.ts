import { storage } from "../storage";
import { uploadDocument, getDocumentBuffer } from "../storage/object-storage";
import { convertHtmlToPdf } from "../services/docraptor";
import { getProjectFinancialSummary } from "../services/financial-summary.service";
import { roundCurrency } from "@shared/financial-utils";
import type { Certificat, Project, Contractor, Devis, Lot, Invoice, Avenant } from "@shared/schema";
import { formatLotDescription } from "@shared/lot-label";
import { ibansMatch, normaliseIban } from "@shared/iban";
import { deriveTransferRef } from "../services/certificat-transfer-ref.service";

interface DevisWithDetails {
  devis: Devis;
  lot: Lot | null;
  invoices: Invoice[];
  invoicedTtc: number;
}

/**
 * Task #225 — Typed blocker thrown when a certificat is being materialised
 * for a contractor whose banking details are missing from ArchiDoc. The
 * API route handler unwraps this and returns 422 with the French message
 * so the architect knows to complete the contractor record in ArchiDoc
 * (banking fields are read-only here — they only flow inbound).
 */
export class BankingDetailsMissingError extends Error {
  readonly code = "BANKING_DETAILS_MISSING" as const;
  readonly userMessageFr = "Coordonnées bancaires manquantes — à compléter dans Archi Doc";
  constructor(readonly contractorId: number, readonly contractorName: string) {
    super(`Contractor ${contractorId} (${contractorName}) has no IBAN on file`);
    this.name = "BankingDetailsMissingError";
  }
}

/**
 * Task #225 — Anti-fraud gate. Raised when at least one related devis or
 * invoice was extracted with an IBAN that disagrees with the
 * ArchiDoc-verified value AND no architect-recorded override exists for
 * that specific (doc_kind, doc_id, doc_iban, archidoc_iban) tuple. The
 * architect must either correct ArchiDoc or record an override before
 * the certificat can be issued.
 */
export interface BankingMismatchDocRef {
  docKind: "devis" | "invoice";
  docId: number;
  docCode: string;
  docIban: string;
}

export class BankingMismatchError extends Error {
  readonly code = "BANKING_MISMATCH" as const;
  readonly userMessageFr =
    "Coordonnées bancaires différentes de celles enregistrées dans Archi Doc — vérifier avant paiement";
  constructor(
    readonly contractorId: number,
    readonly contractorName: string,
    readonly archidocIban: string,
    readonly mismatches: BankingMismatchDocRef[],
  ) {
    super(`Contractor ${contractorId} (${contractorName}) has ${mismatches.length} doc(s) with a mismatched IBAN`);
    this.name = "BankingMismatchError";
  }
}

interface AvenantRow {
  avenantNumber: string;
  type: string;
  descriptionFr: string;
  descriptionUk: string | null;
  amountHt: number;
  amountTtc: number;
}

interface DevisAnnexeRow {
  devisCode: string;
  descriptionFr: string;
  descriptionUk: string | null;
  lotNumber: string;
  lotDescriptionFr: string | null;
  lotDescriptionUk: string | null;
  originalHt: number;
  originalTtc: number;
  avenants: AvenantRow[];
  pvTotalHt: number;
  mvTotalHt: number;
  adjustedHt: number;
  adjustedTtc: number;
}

interface PreviousCertificatRow {
  certificateRef: string;
  dateIssued: string;
  amountHt: number;
  amountTtc: number;
}

interface ProjectSummaryRow {
  devisCode: string;
  description: string;
  adjustedHt: number;
  certifiedHt: number;
  resteARealiser: number;
}

/** Task #485 — whole-project financial position (all live works, every
 * contractor), sourced verbatim from the financial-summary service so the
 * certificat can never disagree with the dashboard or the project overview
 * PDF (which use the same service). */
interface ProjectSummarySection {
  rows: ProjectSummaryRow[];
  totalContractedHt: number;
  totalContractedTtc: number;
  totalCertifiedHt: number;
  totalCertifiedTtc: number;
  totalResteARealiser: number;
  totalResteARealiserTtc: number;
}

interface AnnexeData {
  projectName: string;
  projectCode: string;
  contractorName: string;
  projectSummary: ProjectSummarySection;
  devisRows: DevisAnnexeRow[];
  previousCertificats: PreviousCertificatRow[];
  previousCumulativeHt: number;
  previousCumulativeTtc: number;
  currentCertificatHt: number;
  currentCertificatTtc: number;
  cumulativeTotalHt: number;
  cumulativeTotalTtc: number;
  grandTotalOriginalHt: number;
  grandTotalPvHt: number;
  grandTotalMvHt: number;
  grandTotalAdjustedHt: number;
  grandTotalAdjustedTtc: number;
  resteARealiserHt: number;
  resteARealiserTtc: number;
}

interface CertificatPdfData {
  certificat: Certificat;
  project: Project;
  contractor: Contractor;
  devisDetails: DevisWithDetails[];
  companyLogoBase64: string | null;
  architectsLogoBase64: string | null;
  annexeData: AnnexeData | null;
  /** Task #485 — the marché's configured retention rate (bank guarantee ⇒ 0),
   * mirroring the deduction resolver. The explanation text only states this
   * rate when the certificat's persisted retention amount actually matches
   * it (architect amount-overrides take precedence in the resolver, so the
   * rate is otherwise unprovable) — see buildRetenueExplainText. */
  retenuePercent: number;
  hasBankGuarantee: boolean;
  /** Task #491 — acompte (opening/deposit) certificat: no supplier invoice,
   * no waterfall deductions; labelled distinctly and explained as a deposit
   * recovered in full on the next certificat. */
  isAcompte: boolean;
  /** Task #627 — bank-transfer reference rendered in the PDF banking block.
   * Derived from certified invoice numbers / devis codes. Null for the
   * static design preview (replaced with a sample string there). */
  transferRef: string | null;
}

/**
 * Task #485 — plain-language client explanation of the Retenue de Garantie.
 *
 * Provenance-aware: the deduction resolver lets an architect override the
 * cumulative retention amount, and that override wins over the marché rate.
 * The certificat row persists only amounts (no rate/override provenance), so
 * a percentage is stated ONLY when the persisted cumulative retention equals
 * the marché rate applied to the gross cumulative works (within 1 cent).
 * Otherwise the wording stays amount-based and rate-neutral, so the
 * explanation can never contradict the figures printed above it.
 * Exported for unit tests.
 */
export function buildRetenueExplainText(args: {
  retenuePercent: number;
  hasBankGuarantee: boolean;
  grossCumulativeHt: number;
  cumulativeRetenue: number;
  isSolde: boolean;
  retenueReleased: boolean;
}): string {
  const { retenuePercent, hasBankGuarantee, grossCumulativeHt, cumulativeRetenue, isSolde, retenueReleased } = args;

  if (isSolde && retenueReleased) {
    // Release amounts stem from prior certificats (possibly overridden);
    // never claim a rate here.
    return "The retenue de garantie (the cumulative retention held back on previous certificats) is released on this final (solde) certificat, the works having been accepted. The released amount is added back on the \u201CLib\u00E9ration Retenue de Garantie\u201D line above.";
  }

  if (cumulativeRetenue === 0) {
    if (hasBankGuarantee) {
      return "No cash retention (retenue de garantie) is withheld on this contract: the contractor has provided a bank guarantee, which replaces the usual cumulative holdback on the works.";
    }
    return "No retenue de garantie is withheld on this certificat.";
  }

  const expected = roundCurrency((grossCumulativeHt * retenuePercent) / 100);
  const rateProven = retenuePercent > 0 && Math.abs(expected - cumulativeRetenue) <= 0.01;
  const rateLabel = `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(retenuePercent)}%`;

  if (rateProven) {
    return `The retenue de garantie is a retention of ${rateLabel} of the cumulative value of the works, required under French construction practice. It is held during the parfait ach\u00E8vement (making-good) guarantee period and released in accordance with the contract, in particular once any reserves are lifted. It is not a permanent deduction: it will be paid to the contractor in due course.`;
  }
  return "The retenue de garantie is a cumulative retention on the value of the works, shown on the \u201CRetenue de Garantie\u201D line above. It is held during the parfait ach\u00E8vement (making-good) guarantee period and released in accordance with the contract, in particular once any reserves are lifted. It is not a permanent deduction: it will be paid to the contractor in due course.";
}

function formatCurrency(value: string | number): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(num);
}

function formatCurrencyNoSymbol(value: string | number): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num) + " \u20AC";
}

function formatDateFr(date: string | Date | null): string {
  if (!date) return new Date().toLocaleDateString("fr-FR");
  return new Date(date).toLocaleDateString("fr-FR");
}

// Task #244 — the redesigned certificat is in English, so the legal
// amount-in-words line is rendered in English (uppercase, short-scale).
function numberToEnglishWords(n: number): string {
  if (n === 0) return "ZERO EUROS";

  const ones = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
    "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
  const tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];

  function below1000(num: number): string {
    let s = "";
    if (num >= 100) {
      s += `${ones[Math.floor(num / 100)]} HUNDRED`;
      num %= 100;
      if (num > 0) s += " ";
    }
    if (num >= 20) {
      s += tens[Math.floor(num / 10)];
      if (num % 10 > 0) s += `-${ones[num % 10]}`;
    } else if (num > 0) {
      s += ones[num];
    }
    return s;
  }

  const totalCents = Math.round(n * 100);
  const euros = Math.floor(totalCents / 100);
  const cents = totalCents % 100;

  const scales: { value: number; name: string }[] = [
    { value: 1_000_000_000, name: "BILLION" },
    { value: 1_000_000, name: "MILLION" },
    { value: 1_000, name: "THOUSAND" },
  ];

  let remaining = euros;
  let words = "";
  for (const sc of scales) {
    if (remaining >= sc.value) {
      const count = Math.floor(remaining / sc.value);
      words += `${words ? " " : ""}${below1000(count)} ${sc.name}`;
      remaining %= sc.value;
    }
  }
  if (remaining > 0) words += `${words ? " " : ""}${below1000(remaining)}`;
  if (!words) words = "ZERO";

  let result = `${words} EURO${euros === 1 ? "" : "S"}`;
  if (cents > 0) {
    result += ` AND ${below1000(cents)} CENT${cents === 1 ? "" : "S"}`;
  }

  return result.trim();
}

async function loadLogoAsBase64(assetType: string): Promise<string | null> {
  try {
    const asset = await storage.getTemplateAssetByType(assetType);
    if (!asset) return null;
    const buffer = await getDocumentBuffer(asset.storageKey);
    const mime = asset.mimeType || "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

async function buildAnnexeData(
  certificat: Certificat,
  project: Project,
  contractor: Contractor,
  activeDevis: Devis[],
): Promise<AnnexeData> {
  // TVA-neutral: every monetary value (devis HT/TTC, avenant HT/TTC) is read
  // from storage as the user/document set it. The TVA "rate" no longer
  // exists as a stored column; per-row TVA is implicit in TTC − HT.
  const devisRows: DevisAnnexeRow[] = await Promise.all(
    activeDevis.map(async (d) => {
      const lot = d.lotId ? await storage.getLot(d.lotId) : null;
      const allAvenants = await storage.getAvenantsByDevis(d.id);
      const approvedAvenants = allAvenants.filter((a) => a.status === "approved");

      const originalHt = roundCurrency(parseFloat(d.amountHt));
      const originalTtc = roundCurrency(parseFloat(d.amountTtc));

      const avenantRows: AvenantRow[] = approvedAvenants.map((a) => ({
        avenantNumber: a.avenantNumber || "—",
        type: a.type,
        descriptionFr: a.descriptionFr,
        descriptionUk: a.descriptionUk ?? null,
        amountHt: roundCurrency(parseFloat(a.amountHt)),
        amountTtc: roundCurrency(parseFloat(a.amountTtc)),
      }));

      const pvTotalHt = roundCurrency(
        avenantRows.filter((a) => a.type === "pv").reduce((s, a) => s + a.amountHt, 0)
      );
      const mvTotalHt = roundCurrency(
        avenantRows.filter((a) => a.type === "mv").reduce((s, a) => s + a.amountHt, 0)
      );
      const pvTotalTtc = roundCurrency(
        avenantRows.filter((a) => a.type === "pv").reduce((s, a) => s + a.amountTtc, 0)
      );
      const mvTotalTtc = roundCurrency(
        avenantRows.filter((a) => a.type === "mv").reduce((s, a) => s + a.amountTtc, 0)
      );
      const adjustedHt = roundCurrency(originalHt + pvTotalHt - mvTotalHt);
      const adjustedTtc = roundCurrency(originalTtc + pvTotalTtc - mvTotalTtc);

      return {
        devisCode: d.devisCode,
        descriptionFr: d.descriptionFr || d.descriptionUk || "—",
        descriptionUk: d.descriptionUk ?? null,
        lotNumber: lot ? lot.lotNumber : "—",
        lotDescriptionFr: lot?.descriptionFr ?? null,
        lotDescriptionUk: lot?.descriptionUk ?? null,
        originalHt,
        originalTtc,
        avenants: avenantRows,
        pvTotalHt,
        mvTotalHt,
        adjustedHt,
        adjustedTtc,
      };
    })
  );

  const allCertificats = await storage.getCertificatsByProjectAndContractor(
    certificat.projectId,
    certificat.contractorId
  );
  // Task #457 — superseded certificats were corrected by a reissue: keeping
  // them in the previous-certificat rows would double-count the replaced
  // payment in the annexe history and cumulative totals.
  const previousCerts = allCertificats.filter((c) => c.id !== certificat.id && c.status !== "superseded");

  const previousCertificats: PreviousCertificatRow[] = previousCerts.map((c) => ({
    certificateRef: c.certificateRef,
    dateIssued: formatDateFr(c.dateIssued),
    amountHt: roundCurrency(parseFloat(c.netToPayHt)),
    amountTtc: roundCurrency(parseFloat(c.netToPayTtc)),
  }));

  const previousCumulativeHt = roundCurrency(
    previousCertificats.reduce((s, c) => s + c.amountHt, 0)
  );
  const previousCumulativeTtc = roundCurrency(
    previousCertificats.reduce((s, c) => s + c.amountTtc, 0)
  );

  const currentCertificatHt = roundCurrency(parseFloat(certificat.netToPayHt));
  const currentCertificatTtc = roundCurrency(parseFloat(certificat.netToPayTtc));

  const cumulativeTotalHt = roundCurrency(previousCumulativeHt + currentCertificatHt);
  const cumulativeTotalTtc = roundCurrency(previousCumulativeTtc + currentCertificatTtc);

  const grandTotalOriginalHt = roundCurrency(devisRows.reduce((s, d) => s + d.originalHt, 0));
  const grandTotalPvHt = roundCurrency(devisRows.reduce((s, d) => s + d.pvTotalHt, 0));
  const grandTotalMvHt = roundCurrency(devisRows.reduce((s, d) => s + d.mvTotalHt, 0));
  const grandTotalAdjustedHt = roundCurrency(devisRows.reduce((s, d) => s + d.adjustedHt, 0));
  const grandTotalAdjustedTtc = roundCurrency(devisRows.reduce((s, d) => s + d.adjustedTtc, 0));

  const resteARealiserHt = roundCurrency(grandTotalAdjustedHt - cumulativeTotalHt);
  const resteARealiserTtc = roundCurrency(grandTotalAdjustedTtc - cumulativeTotalTtc);

  // Task #485 — whole-project section: every live devis across ALL
  // contractors, from the same service that powers the in-app dashboard
  // and the project overview PDF. Never recomputed locally.
  //
  // INTENTIONAL DESIGN: this section is deliberately NOT scoped to the
  // selected invoice set (activeDevis). The financial-summary annexe is
  // labelled "position of the whole project" and is meant to give the
  // recipient a full project view regardless of which factures are grouped
  // in this certificat. The contractor-specific devis table above (devisRows)
  // IS scoped to activeDevis — only selected devis codes appear there.
  // The project summary table will therefore show devis codes that are absent
  // from the works table; this is the correct behaviour.
  //
  // Task #546 — the issuance render runs while this certificat is still
  // `draft` (the seal flips status after the PDF commits), so an acompte
  // certificat must be treated as issued here or its own whole-project
  // table would show it as uncertified.
  const summaryResult = await getProjectFinancialSummary(certificat.projectId, {
    treatAsIssuedCertificatIds: [certificat.id],
  });
  if (!summaryResult.success) {
    throw new Error(`Project financial summary unavailable for project ${certificat.projectId}`);
  }
  const summary = summaryResult.data as {
    devis: Array<{
      devisCode: string;
      descriptionFr: string | null;
      descriptionUk: string | null;
      status: string;
      accountingState: string | null;
      adjustedHt: number;
      certifiedHt: number;
      resteARealiser: number;
    }>;
    totalContractedHt: number;
    totalContractedTtc: number;
    totalCertifiedHt: number;
    totalCertifiedTtc: number;
    totalResteARealiser: number;
    totalResteARealiserTtc: number;
  };
  const projectSummary: ProjectSummarySection = {
    rows: summary.devis
      .filter((d) => d.accountingState === "active" && d.status !== "void")
      .map((d) => ({
        devisCode: d.devisCode,
        description: d.descriptionUk || d.descriptionFr || "\u2014",
        adjustedHt: d.adjustedHt,
        certifiedHt: d.certifiedHt,
        resteARealiser: d.resteARealiser,
      })),
    totalContractedHt: summary.totalContractedHt,
    totalContractedTtc: summary.totalContractedTtc,
    totalCertifiedHt: summary.totalCertifiedHt,
    totalCertifiedTtc: summary.totalCertifiedTtc,
    totalResteARealiser: summary.totalResteARealiser,
    totalResteARealiserTtc: summary.totalResteARealiserTtc,
  };

  return {
    projectName: project.name,
    projectCode: project.code,
    contractorName: contractor.name,
    projectSummary,
    devisRows,
    previousCertificats,
    previousCumulativeHt,
    previousCumulativeTtc,
    currentCertificatHt,
    currentCertificatTtc,
    cumulativeTotalHt,
    cumulativeTotalTtc,
    grandTotalOriginalHt,
    grandTotalPvHt,
    grandTotalMvHt,
    grandTotalAdjustedHt,
    grandTotalAdjustedTtc,
    resteARealiserHt,
    resteARealiserTtc,
  };
}

function buildAnnexeHtml(data: AnnexeData): string {
  const fmtNum = (v: number) => formatCurrencyNoSymbol(v);

  let marcheRows = "";
  let rowIdx = 0;
  for (const dr of data.devisRows) {
    const zebraClass = rowIdx % 2 === 1 ? ' style="background:#F8F9FA;"' : "";
    const lotLabelHtml = dr.lotDescriptionFr || dr.lotDescriptionUk
      ? `LOT ${escapeHtml(dr.lotNumber)}<div style="font-weight:400;font-size:6.5pt;color:#7E7F83;">${escapeHtml(formatLotDescription({ descriptionFr: dr.lotDescriptionFr, descriptionUk: dr.lotDescriptionUk }))}</div>`
      : `LOT ${escapeHtml(dr.lotNumber)}`;
    const devisDescHtml = dr.descriptionUk && dr.descriptionUk !== dr.descriptionFr
      ? `${escapeHtml(dr.descriptionFr)}<div style="font-weight:400;font-size:6.5pt;color:#7E7F83;font-style:italic;">${escapeHtml(dr.descriptionUk)}</div>`
      : escapeHtml(dr.descriptionFr);
    marcheRows += `<tr${zebraClass}>
      <td style="font-weight:700;color:#0B2545;">${lotLabelHtml}</td>
      <td style="font-weight:700;color:#0B2545;">${escapeHtml(dr.devisCode)}</td>
      <td style="font-weight:600;">${devisDescHtml}</td>
      <td style="text-align:right;font-weight:600;">${fmtNum(dr.originalHt)}</td>
      <td style="text-align:right;">—</td>
      <td style="text-align:right;">—</td>
      <td style="text-align:right;font-weight:700;color:#0B2545;">${fmtNum(dr.adjustedHt)}</td>
    </tr>`;
    for (const av of dr.avenants) {
      const typeLabel = av.type === "pv" ? "PV" : "MV";
      const typeColor = av.type === "pv" ? "#2a7d2e" : "#c0392b";
      const avDescHtml = av.descriptionUk && av.descriptionUk !== av.descriptionFr
        ? `${escapeHtml(av.descriptionFr)} <span style="color:#7E7F83;font-style:italic;">(${escapeHtml(av.descriptionUk)})</span>`
        : escapeHtml(av.descriptionFr);
      marcheRows += `<tr style="background:#FAFAFA;">
        <td></td>
        <td style="padding-left:16px;border-left:3px solid #C1A27B;font-size:6.5pt;color:#7E7F83;">${escapeHtml(av.avenantNumber)}</td>
        <td style="font-size:6.5pt;color:#34312D;">${avDescHtml}</td>
        <td style="text-align:right;font-size:6.5pt;">—</td>
        <td style="text-align:right;font-size:6.5pt;color:${typeColor};font-weight:600;">${av.type === "pv" ? fmtNum(av.amountHt) : "—"}</td>
        <td style="text-align:right;font-size:6.5pt;color:${typeColor};font-weight:600;">${av.type === "mv" ? fmtNum(av.amountHt) : "—"}</td>
        <td style="text-align:right;font-size:6.5pt;">—</td>
      </tr>`;
    }
    if (dr.avenants.length > 0) {
      marcheRows += `<tr style="background:#F0F2F5;">
        <td colspan="3" style="text-align:right;font-weight:700;font-size:6.5pt;color:#7E7F83;text-transform:uppercase;">Subtotal ${escapeHtml(dr.devisCode)}</td>
        <td style="text-align:right;font-size:6.5pt;font-weight:600;">${fmtNum(dr.originalHt)}</td>
        <td style="text-align:right;font-size:6.5pt;font-weight:600;color:#2a7d2e;">${fmtNum(dr.pvTotalHt)}</td>
        <td style="text-align:right;font-size:6.5pt;font-weight:600;color:#c0392b;">${fmtNum(dr.mvTotalHt)}</td>
        <td style="text-align:right;font-size:6.5pt;font-weight:700;color:#0B2545;">${fmtNum(dr.adjustedHt)}</td>
      </tr>`;
    }
    rowIdx++;
  }

  let situationRows = "";
  for (let i = 0; i < data.previousCertificats.length; i++) {
    const pc = data.previousCertificats[i];
    const zClass = i % 2 === 1 ? ' style="background:#F8F9FA;"' : "";
    situationRows += `<tr${zClass}>
      <td>${escapeHtml(pc.certificateRef)}</td>
      <td style="text-align:center;">${escapeHtml(pc.dateIssued)}</td>
      <td style="text-align:right;">${fmtNum(pc.amountHt)}</td>
      <td style="text-align:right;">${fmtNum(pc.amountTtc)}</td>
    </tr>`;
  }

  return `
  <div class="annexe-section" style="page-break-before:always;">
    <div style="text-align:center;margin-bottom:4mm;">
      <div style="font-size:13pt;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;color:#0B2545;">Financial Summary</div>
      <div style="font-size:8pt;color:#7E7F83;margin-top:2px;">${escapeHtml(data.projectName)} (${escapeHtml(data.projectCode)}) — ${escapeHtml(data.contractorName)}</div>
    </div>
    <div class="accent-bar"></div>

    <div style="font-size:10pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#0B2545;margin-bottom:2.5mm;padding-bottom:1.5mm;border-bottom:1px solid #E6E6E6;">
      1. This Contract — Devis &amp; Avenants
    </div>
    <table class="annexe-table" style="width:100%;border-collapse:collapse;margin-bottom:4mm;font-size:7pt;">
      <thead>
        <tr>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:left;">Lot</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:left;">Devis</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:left;">Description</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">Original HT</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">PV (+)</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">MV (\u2212)</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">Adjusted HT</th>
        </tr>
      </thead>
      <tbody>
        ${marcheRows}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid #0B2545;background:#E8ECF1;">
          <td colspan="3" style="font-weight:800;font-size:7pt;color:#0B2545;text-transform:uppercase;padding:6px;">GRAND TOTAL</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.grandTotalOriginalHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#2a7d2e;padding:6px;">${fmtNum(data.grandTotalPvHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#c0392b;padding:6px;">${fmtNum(data.grandTotalMvHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.grandTotalAdjustedHt)}</td>
        </tr>
        <tr style="background:#E8ECF1;">
          <td colspan="6" style="text-align:right;font-size:6.5pt;color:#7E7F83;padding:3px 6px;">March\u00E9 Adjusted TTC</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#0B2545;padding:3px 6px;">${fmtNum(data.grandTotalAdjustedTtc)}</td>
        </tr>
      </tfoot>
    </table>
    <div style="font-size:6.5pt;color:#7E7F83;margin:-2mm 0 4mm 0;">
      PV (plus-value) = agreed additional works added to the contract. MV (moins-value) = agreed reductions or omitted works deducted from the contract. The Adjusted column is the contract value after these approved variations.
    </div>

    <div style="font-size:10pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#0B2545;margin-bottom:3mm;padding-bottom:1.5mm;border-bottom:1px solid #E6E6E6;">
      2. This Contract — Payment History
    </div>
    <table class="annexe-table" style="width:100%;border-collapse:collapse;margin-bottom:4mm;font-size:7pt;">
      <thead>
        <tr>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:left;">Reference</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:center;">Date</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">Amount HT</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">Amount TTC</th>
        </tr>
      </thead>
      <tbody>
        ${situationRows || `<tr><td colspan="4" style="color:#7E7F83;font-style:italic;padding:6px;">No previous certificat</td></tr>`}
        ${data.previousCertificats.length > 0 ? `
        <tr style="border-top:1px solid #C1A27B;background:#FDF8F3;">
          <td colspan="2" style="font-weight:700;font-size:6.5pt;color:#7E7F83;text-transform:uppercase;padding:4px 6px;">Previous Cumulative</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#34312D;padding:4px 6px;">${fmtNum(data.previousCumulativeHt)}</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#34312D;padding:4px 6px;">${fmtNum(data.previousCumulativeTtc)}</td>
        </tr>` : ""}
        <tr style="background:#FFF9F0;border-left:3px solid #C1A27B;">
          <td style="font-weight:800;color:#0B2545;padding:6px;">CURRENT CERTIFICAT</td>
          <td style="text-align:center;font-weight:600;color:#0B2545;padding:6px;">${formatDateFr(null)}</td>
          <td style="text-align:right;font-weight:800;color:#0B2545;padding:6px;">${fmtNum(data.currentCertificatHt)}</td>
          <td style="text-align:right;font-weight:800;color:#0B2545;padding:6px;">${fmtNum(data.currentCertificatTtc)}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid #0B2545;background:#E8ECF1;">
          <td colspan="2" style="font-weight:800;font-size:7pt;color:#0B2545;text-transform:uppercase;padding:6px;">TOTAL CERTIFIED</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.cumulativeTotalHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.cumulativeTotalTtc)}</td>
        </tr>
        <tr style="background:#F8F9FA;">
          <td colspan="2" style="font-weight:700;font-size:7pt;color:#0B2545;padding:6px;">March\u00E9 Adjusted</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.grandTotalAdjustedHt)}</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.grandTotalAdjustedTtc)}</td>
        </tr>
        <tr style="background:#FDF8F3;border-top:1px solid #C1A27B;">
          <td colspan="2" style="font-weight:800;font-size:7pt;color:#C1A27B;text-transform:uppercase;padding:6px;">RESTE \u00C0 R\u00C9ALISER (WORKS REMAINING)</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#C1A27B;padding:6px;">${fmtNum(data.resteARealiserHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#C1A27B;padding:6px;">${fmtNum(data.resteARealiserTtc)}</td>
        </tr>
      </tfoot>
    </table>

    ${buildProjectSummaryHtml(data.projectSummary)}
  </div>`;
}

/**
 * Task #485 — Section 3: the whole project. Every live devis across ALL
 * contractors, so the client always sees their total liability and the
 * overall financial position, not just the contract this certificat covers.
 */
function buildProjectSummaryHtml(ps: ProjectSummarySection): string {
  const fmtNum = (v: number) => formatCurrencyNoSymbol(v);
  const th = (label: string, align: string) =>
    `<th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:${align};">${label}</th>`;

  let rows = "";
  ps.rows.forEach((r, i) => {
    const zebra = i % 2 === 1 ? ' style="background:#F8F9FA;"' : "";
    rows += `<tr${zebra}>
      <td style="font-weight:700;color:#0B2545;white-space:nowrap;">${escapeHtml(r.devisCode)}</td>
      <td>${escapeHtml(r.description)}</td>
      <td style="text-align:right;font-weight:600;">${fmtNum(r.adjustedHt)}</td>
      <td style="text-align:right;">${fmtNum(r.certifiedHt)}</td>
      <td style="text-align:right;font-weight:600;color:#C1A27B;">${fmtNum(r.resteARealiser)}</td>
    </tr>`;
  });
  if (!rows) {
    rows = `<tr><td colspan="5" style="color:#7E7F83;font-style:italic;padding:6px;">No live works on this project</td></tr>`;
  }

  return `
    <div style="font-size:10pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#0B2545;margin-bottom:3mm;padding-bottom:1.5mm;border-bottom:1px solid #E6E6E6;">
      3. Whole Project — All Live Works
    </div>
    <div style="font-size:6.5pt;color:#7E7F83;margin-bottom:2mm;">
      All contracted works currently live on the project, across every contractor \u2014 your total commitment, what has been certified to date (contractor invoices plus any deposit certificats not yet recovered, including this one), and what remains to be invoiced.
    </div>
    <table class="annexe-table" style="width:100%;border-collapse:collapse;margin-bottom:4mm;font-size:7pt;">
      <thead>
        <tr>
          ${th("Devis", "left")}
          ${th("Description", "left")}
          ${th("Contract Value HT", "right")}
          ${th("Certified HT", "right")}
          ${th("Remaining HT", "right")}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr style="border-top:2px solid #0B2545;background:#E8ECF1;">
          <td colspan="2" style="font-weight:800;font-size:7pt;color:#0B2545;text-transform:uppercase;padding:6px;">TOTAL PROJECT COMMITMENT</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(ps.totalContractedHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(ps.totalCertifiedHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#C1A27B;padding:6px;">${fmtNum(ps.totalResteARealiser)}</td>
        </tr>
        <tr style="background:#E8ECF1;">
          <td colspan="2" style="text-align:right;font-size:6.5pt;color:#7E7F83;padding:3px 6px;">Totals TTC (incl. TVA)</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#0B2545;padding:3px 6px;">${fmtNum(ps.totalContractedTtc)}</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#0B2545;padding:3px 6px;">${fmtNum(ps.totalCertifiedTtc)}</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#C1A27B;padding:3px 6px;">${fmtNum(ps.totalResteARealiserTtc)}</td>
        </tr>
      </tfoot>
    </table>`;
}

/**
 * Task #451 — render the certificat PDF.
 *
 * `mode: "preview"` (default) is EPHEMERAL: the buffer is returned to the
 * caller and nothing is persisted — no object-storage upload, no Drive
 * enqueue. `mode: "issue"` is the single persistence path used by the seal
 * service at explicit issue/send time: it uploads the bytes and enqueues the
 * Drive mirror. Previews of a draft therefore never leave stray artefacts.
 */
export async function generateCertificatPdf(
  certificatId: number,
  opts: { mode: "preview" | "issue" } = { mode: "preview" },
): Promise<{
  storageKey: string | null;
  pdfBuffer: Buffer;
  fileName: string;
  sourceInvoiceIds: number[];
  /** Task #627 — bank-transfer reference derived from the certified invoices. */
  transferRef: string;
  /** Present only in issue mode — inputs for the winner-only Drive enqueue. */
  driveSeed?: {
    projectId: number;
    lotId: number | null;
    displayName: string;
    seedDevisCode: string;
  };
}> {
  const certificat = await storage.getCertificat(certificatId);
  if (!certificat) throw new Error(`Certificat ${certificatId} not found`);

  const project = await storage.getProject(certificat.projectId);
  if (!project) throw new Error(`Project ${certificat.projectId} not found`);

  const contractor = await storage.getContractor(certificat.contractorId);
  if (!contractor) throw new Error(`Contractor ${certificat.contractorId} not found`);

  // Task #225 — Banking gate. A certificat de paiement IS a payment
  // instruction; we refuse to materialise one without a verified IBAN.
  // The mirror writer (sync-service.upsertContractor) only stores
  // checksum-valid IBANs, so a null here means ArchiDoc has nothing
  // usable for this contractor.
  if (!contractor.iban) {
    throw new BankingDetailsMissingError(contractor.id, contractor.name);
  }

  const allDevis = await storage.getDevisByProjectAndContractor(certificat.projectId, certificat.contractorId);
  const allActiveDevis = allDevis.filter(d => d.status !== "void");

  // Multi-facture certificats — explicit `certificat_sources` invoice rows
  // scope the document: the PDF must present ONLY the selected factures and
  // their parent devis, or a grouped certificat would visually claim every
  // invoice of the contractor. No invoice sources (manual, acompte, legacy)
  // ⇒ historical whole-contractor behavior.
  const sourceRows = await storage.getCertificatSources(certificatId);
  const selectedInvoiceIds = new Set(
    sourceRows.map((s) => s.invoiceId).filter((id): id is number => id != null),
  );
  const scoped = selectedInvoiceIds.size > 0;

  const devisWithInvoices = await Promise.all(
    allActiveDevis.map(async (d) => {
      const invoicesAll = await storage.getInvoicesByDevis(d.id);
      const invoices = scoped ? invoicesAll.filter((inv) => selectedInvoiceIds.has(inv.id)) : invoicesAll;
      return { devis: d, invoices };
    }),
  );
  const scopedEntries = scoped ? devisWithInvoices.filter((e) => e.invoices.length > 0) : devisWithInvoices;
  const activeDevis = scopedEntries.map((e) => e.devis);

  // Task #225 — Mismatch gate. Walk every in-scope devis + its in-scope invoices,
  // collect rows whose extracted_iban disagrees with the ArchiDoc value,
  // and demand an architect override for each unique disagreeing IBAN.
  // Null/empty extracted_iban is treated as "AI couldn't see one" and is
  // skipped — only an actually-extracted, validated IBAN can fire the
  // gate. Comparison is whitespace/case insensitive via ibansMatch.
  const archidocIbanCanonical = normaliseIban(contractor.iban);
  const mismatches: BankingMismatchDocRef[] = [];
  for (const { devis: d, invoices: invoicesForDevis } of scopedEntries) {
    if (d.extractedIban && !ibansMatch(d.extractedIban, contractor.iban)) {
      const override = await storage.findBankingMismatchOverride({
        docKind: "devis",
        docId: d.id,
        docIban: d.extractedIban,
        archidocIban: archidocIbanCanonical,
      });
      if (!override) {
        mismatches.push({
          docKind: "devis", docId: d.id, docCode: d.devisCode, docIban: d.extractedIban,
        });
      }
    }
    for (const inv of invoicesForDevis) {
      if (inv.extractedIban && !ibansMatch(inv.extractedIban, contractor.iban)) {
        const override = await storage.findBankingMismatchOverride({
          docKind: "invoice",
          docId: inv.id,
          docIban: inv.extractedIban,
          archidocIban: archidocIbanCanonical,
        });
        if (!override) {
          mismatches.push({
            docKind: "invoice", docId: inv.id, docCode: inv.invoiceNumber, docIban: inv.extractedIban,
          });
        }
      }
    }
  }
  if (mismatches.length > 0) {
    throw new BankingMismatchError(contractor.id, contractor.name, archidocIbanCanonical, mismatches);
  }

  // Task #627 — derive the bank-transfer reference from the certified
  // documents. Acompte certificats carry no supplier invoice; the devis code
  // is the only meaningful matching key for the contractor's bank statement.
  // Legacy certificats (no source rows) fall back to all active devis codes.
  let acompteDevisCode: string | null = null;
  if (certificat.acompteDevisId != null) {
    const acompteDevis = await storage.getDevis(certificat.acompteDevisId);
    acompteDevisCode = acompteDevis?.devisCode ?? null;
  }
  const invoiceNumbers = scoped
    ? scopedEntries.flatMap((e) => e.invoices.map((inv) => inv.invoiceNumber))
    : [];
  const fallbackDevisCodes = acompteDevisCode
    ? [acompteDevisCode]
    : !scoped
      ? scopedEntries.map((e) => e.devis.devisCode).filter(Boolean)
      : [];
  const transferRef = deriveTransferRef({
    projectCode: project.code,
    projectName: project.name,
    certificateRef: certificat.certificateRef,
    invoiceNumbers,
    devisCodes: fallbackDevisCodes,
  });

  const devisDetails: DevisWithDetails[] = await Promise.all(
    scopedEntries.map(async ({ devis: d, invoices }) => {
      const lot = d.lotId ? (await storage.getLot(d.lotId)) ?? null : null;
      const invoicedTtc = invoices.reduce((sum, inv) => sum + parseFloat(inv.amountTtc), 0);
      return { devis: d, lot, invoices, invoicedTtc };
    })
  );

  const [companyLogoBase64, architectsLogoBase64] = await Promise.all([
    loadLogoAsBase64("company_logo"),
    loadLogoAsBase64("architects_order_logo"),
  ]);

  const annexeData = await buildAnnexeData(certificat, project, contractor, activeDevis);

  // Task #485 — resolve the actual retention rate the same way the
  // deduction resolver does (marché rate, 5% default, bank guarantee ⇒ 0),
  // so the explanation text matches the applied deduction.
  const marche = (await storage.getMarchesByProject(project.id)).find(
    (m) => m.contractorId === certificat.contractorId,
  );
  const hasBankGuarantee = marche?.hasBankGuarantee ?? false;
  const retenuePercent = hasBankGuarantee
    ? 0
    : marche?.retenueGarantiePercent != null
      ? parseFloat(marche.retenueGarantiePercent)
      : 5;

  const html = buildCertificatHtml({ certificat, project, contractor, devisDetails, companyLogoBase64, architectsLogoBase64, annexeData, retenuePercent, hasBankGuarantee, isAcompte: certificat.acompteDevisId != null, transferRef });

  const dateStr = new Date().toISOString().split("T")[0].replace(/-/g, "");
  const projectCode = (project.code || "PROJ").replace(/[^a-zA-Z0-9]/g, "");
  const docName = `CERT-${projectCode}-${certificat.certificateRef}-${dateStr}`;
  const fileName = `${docName}.pdf`;

  const pdfBuffer = await convertHtmlToPdf(html, docName);
  const sourceInvoiceIds = devisDetails.flatMap((dd) => dd.invoices.map((inv) => inv.id));

  // Task #451 — previews are ephemeral: return the bytes and persist nothing.
  if (opts.mode !== "issue") {
    return { storageKey: null, pdfBuffer, fileName, sourceInvoiceIds, transferRef };
  }

  const storageKey = await uploadDocument(project.id, fileName, pdfBuffer, "application/pdf");

  // Task #451 (round 3) — the Drive mirror is NOT enqueued here. The Drive
  // queue dedupes on (doc_kind, doc_id) and keeps the first submitted key,
  // so a losing concurrent renderer could otherwise supply the Drive copy
  // while a different winner's bytes get pinned and emailed. The seal
  // service enqueues the mirror only after the seal winner is established,
  // using the winner's pinned key (see `driveSeed` below).
  const seedDevis = activeDevis.find((d) => d.lotId != null) ?? activeDevis[0];
  const driveSeed = {
    projectId: project.id,
    lotId: seedDevis?.lotId ?? null,
    displayName: `${docName}.pdf`,
    seedDevisCode: seedDevis?.devisCode ?? `cert-${certificat.certificateRef}`,
  };

  return { storageKey, pdfBuffer, fileName, sourceInvoiceIds, transferRef, driveSeed };
}

/**
 * Task #225 — Render the Coordonnées bancaires block printed on every
 * certificat de paiement. The contractor row is guaranteed to have an
 * IBAN by the time we reach the HTML builder (the gate in
 * generateCertificatPdf throws BankingDetailsMissingError otherwise),
 * so iban/bic are non-null here — but we still defensively check.
 * IBAN is grouped 4-by-4 for printed legibility per French banking norm.
 */
function formatIbanForPrint(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Escape a string for safe interpolation into a CSS `content: "..."` value.
 * A literal `"` would break out of the quoted string; a literal `\` must
 * also be escaped so it cannot start a CSS escape sequence.
 */
function escapeCssString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderBankingBlock(contractor: Contractor, proposeHtml: string = "", transferRef: string | null = null): string {
  if (!contractor.iban) return "";
  const holder = contractor.accountHolderName || contractor.name;
  // Task #485 — the payment keys (IBAN + SWIFT/BIC) are what clients
  // transcribe into their bank; both are rendered LARGE and first-class.
  // A missing BIC is shown explicitly, never silently omitted.
  const bicValue = contractor.bic
    ? `<div class="banking-key-value">${escapeHtml(contractor.bic)}</div>`
    : `<div class="banking-key-missing">NON COMMUNIQU\u00C9 PAR L'\u00C9TABLISSEMENT</div>`;
  const holderLine = `${escapeHtml(holder)}${contractor.bankName ? ` \u2014 ${escapeHtml(contractor.bankName)}` : ""}`;
  // Task #627 — transfer reference box, rendered only when a reference was derived.
  const transferRefHtml = transferRef
    ? `
    <div class="transfer-ref-box">
      <div class="transfer-ref-label">use this reference for your payment.</div>
      <div class="transfer-ref-value">${escapeHtml(transferRef)}</div>
    </div>`
    : "";
  return `
  <div class="banking-card">
    ${proposeHtml}
    <div class="banking-card-title">Bank details for your payment</div>
    <div class="banking-holder">${holderLine}</div>
    <div class="banking-keys">
      <div class="banking-key banking-key-iban">
        <div class="banking-key-label">IBAN</div>
        <div class="banking-key-value">${escapeHtml(formatIbanForPrint(contractor.iban))}</div>
      </div>
      <div class="banking-key banking-key-bic">
        <div class="banking-key-label">SWIFT / BIC</div>
        ${bicValue}
      </div>
    </div>${transferRefHtml}
  </div>`;
}

function buildCertificatHtml(data: CertificatPdfData): string {
  const { certificat, project, contractor, devisDetails, companyLogoBase64, architectsLogoBase64, annexeData, retenuePercent, hasBankGuarantee, isAcompte, transferRef } = data;

  const netTtc = parseFloat(certificat.netToPayTtc);
  const netHt = parseFloat(certificat.netToPayHt);
  const tvaAmount = parseFloat(certificat.tvaAmount);
  // Task #463 — show the rate actually applied (audit column), and print the
  // mandatory legal mention on autoliquidation certificats (art. 283 CGI).
  const tvaRatePercent = parseFloat(certificat.tvaRatePercent ?? "20");
  const tvaAutoliquidation = certificat.tvaAutoliquidation === true;
  // Task #479 — label honesty: a documentary blended rate (derived from the
  // invoices' HT/TTC, e.g. mixed 10%/20% lines) is presented as "taux
  // effectif", not as if it were a statutory rate.
  const tvaRateLabel = tvaAutoliquidation
    ? "0&nbsp;%"
    : certificat.tvaRateSource === "documentary"
      ? `(taux effectif ${escapeHtml(String(tvaRatePercent))}&nbsp;%)`
      : `${escapeHtml(String(tvaRatePercent))}&nbsp;%`;
  const amountInWords = numberToEnglishWords(netTtc);

  // Task #243 — authoritative cumulative deduction figures persisted on the
  // certificat (computed server-side). Rendered as an explicit waterfall.
  const grossCumulativeHt = roundCurrency(
    parseFloat(certificat.totalWorksHt) + parseFloat(certificat.pvMvAdjustment ?? "0"),
  );
  const cumulativeRetenue = roundCurrency(parseFloat(certificat.retenueGarantie ?? "0"));
  const cumulativeProrata = roundCurrency(parseFloat(certificat.cumulativeProrataDeduction ?? "0"));
  const previousPaymentsHt = roundCurrency(parseFloat(certificat.previousPayments ?? "0"));
  // Task #462 — deposit recovery: only THIS period's movement is subtracted
  // from this period's net (prior recoupments already reduced prior nets).
  const periodAcompteRecoupment = roundCurrency(parseFloat(certificat.periodAcompteRecoupment ?? "0"));
  const cumulativeAcompteRecoupment = roundCurrency(parseFloat(certificat.cumulativeAcompteRecoupment ?? "0"));
  // Task #464 — solde certificat: the retenue release is a distinct POSITIVE
  // line (never a rate change); a still-withheld solde shows the balance.
  const isSolde = certificat.isSolde === true;
  const retenueReleased = certificat.retenueReleased === true;
  const retenueReleaseAmount = roundCurrency(parseFloat(certificat.retenueReleaseAmount ?? "0"));

  const primaryLot = devisDetails.find(d => d.lot)?.lot;
  const lotLabel = primaryLot ? `LOT ${primaryLot.lotNumber}` : "LOT";
  const compositeRef = `${lotLabel} ${certificat.certificateRef}`;

  // Task #485 — plain-language retenue explainer; provenance-aware (see
  // buildRetenueExplainText): only states a rate it can prove was applied.
  const retenueExplainText = buildRetenueExplainText({
    retenuePercent,
    hasBankGuarantee,
    grossCumulativeHt,
    cumulativeRetenue,
    isSolde,
    retenueReleased,
  });
  const dateIssued = formatDateFr(certificat.dateIssued);

  const worksRows = devisDetails.map((dd, i) => {
    const lotDesc = dd.lot ? escapeHtml(formatLotDescription(dd.lot)) : "";
    const lotNum = dd.lot
      ? `LOT ${escapeHtml(dd.lot.lotNumber)}${lotDesc ? `<div style="font-weight:400;font-size:7pt;color:#7E7F83;">${lotDesc}</div>` : ""}`
      : "\u2014";
    const worksDesc = escapeHtml(formatLotDescription(dd.devis)) || "\u2014";
    const invoiceNums = dd.invoices.length > 0
      ? dd.invoices.map(inv => `#${escapeHtml(inv.invoiceNumber)}`).join(", ")
      : "\u2014";
    const rowClass = i % 2 === 1 ? ' class="zebra"' : "";
    return `<tr${rowClass}>
      <td>${worksDesc}</td>
      <td>${escapeHtml(contractor.name)}</td>
      <td style="text-align:center;">${lotNum}</td>
      <td style="text-align:center;">${escapeHtml(dd.devis.devisCode)}</td>
      <td style="text-align:center;">${invoiceNums}</td>
    </tr>`;
  }).join("");

  const devisSummaryRows = devisDetails.map(dd => {
    const worksTtc = parseFloat(dd.devis.amountTtc);
    const invoicedTtc = dd.invoicedTtc;
    const remaining = worksTtc - invoicedTtc;
    return `<div class="info-box" style="margin-bottom:6px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="font-weight:700;font-size:10pt;color:#0B2545;padding-bottom:4px;" colspan="2">
            ${escapeHtml(dd.devis.descriptionFr || dd.devis.descriptionUk || "\u2014")}
            <span style="float:right;font-size:9pt;color:#7E7F83;font-weight:400;">${escapeHtml(dd.devis.devisCode)}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:3px 0;font-size:9pt;color:#34312D;">Works Value TTC</td>
          <td class="num">${formatCurrencyNoSymbol(worksTtc)}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;font-size:9pt;color:#34312D;">Invoiced to Date</td>
          <td class="num">${formatCurrencyNoSymbol(invoicedTtc)}</td>
        </tr>
        <tr style="border-top:1px solid #E6E6E6;">
          <td style="padding:5px 0 3px;font-size:9pt;font-weight:700;color:#0B2545;">Remaining</td>
          <td class="num" style="font-weight:700;color:#0B2545;">${formatCurrencyNoSymbol(remaining)}</td>
        </tr>
      </table>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(compositeRef)} \u2014 Certificat de Paiement</title>
<style>
  /* Task #485 — page-box frame: Prince repeats @page border on every
     physical page (including table-overflow pages). @page annexe does NOT
     inherit, so both rules declare the same frame. */
  @page {
    size: A4;
    margin: 7mm 10mm 12mm 10mm;
    border: 0.65pt solid #0B2545;
    padding: 3mm 4mm 3mm 4mm;
    @bottom-left {
      content: "${escapeCssString(project.name)} \u2014 ${escapeCssString(project.clientName)}";
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 7pt;
      color: #7E7F83;
    }
    @bottom-center {
      content: "${dateIssued}";
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 7pt;
      color: #7E7F83;
    }
    @bottom-right {
      content: "Page " counter(page) " / " counter(pages);
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 7pt;
      color: #7E7F83;
    }
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 9.5pt;
    color: #34312D;
    line-height: 1.28;
  }

  .cover-header {
    background: #FFFFFF;
    color: #0B2545;
    padding: 0 0 3px 0;
    margin: 0;
  }
  .cover-header-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 4px;
  }
  .cover-header-top img {
    height: 46px;
    width: auto;
  }
  .cover-header-top .firm-name {
    font-size: 8pt;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #7E7F83;
  }
  .cover-header-bottom {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }
  .cover-header .doc-title {
    font-size: 18pt;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: #0B2545;
  }
  .cover-header .doc-ref {
    font-size: 10pt;
    font-weight: 400;
    color: #7E7F83;
    text-align: right;
  }
  .cover-header .doc-ref strong {
    font-size: 14pt;
    font-weight: 800;
    display: block;
    color: #0B2545;
  }

  .accent-bar {
    height: 4px;
    background: linear-gradient(90deg, #c1a27b 0%, #FFC482 50%, #c1a27b 100%);
    margin-bottom: 2.5mm;
  }

  .section-title {
    font-size: 10pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #0B2545;
    margin-bottom: 1.5mm;
    padding-bottom: 1mm;
    border-bottom: 1px solid #E6E6E6;
  }

  .parties-grid {
    display: flex;
    gap: 12px;
    margin-bottom: 2mm;
  }
  .party-card {
    flex: 1;
    background: #F8F9FA;
    border-left: 3pt solid #C1A27B;
    padding: 4px 10px;
  }
  .party-label {
    font-size: 8pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #7E7F83;
    margin-bottom: 4px;
  }
  .party-name {
    font-size: 10pt;
    font-weight: 700;
    color: #0B2545;
    margin-bottom: 2px;
  }
  .party-detail {
    font-size: 8pt;
    color: #34312D;
    line-height: 1.5;
  }

  /* Task #225/#485 — Coordonnées bancaires: the payment keys clients
     transcribe. Large, distinctive, dignified. */
  .banking-card {
    background: #F3F6F9;
    border: 1pt solid #0B2545;
    border-left: 3pt solid #C1A27B;
    padding: 2mm 4mm 2.5mm;
    margin-bottom: 2mm;
    page-break-inside: avoid;
  }
  .banking-card-title {
    font-size: 9pt;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #0B2545;
    margin-bottom: 1mm;
  }
  .banking-holder {
    font-size: 8pt;
    color: #34312D;
    margin-bottom: 2mm;
  }
  .banking-keys {
    display: flex;
    gap: 3mm;
  }
  .banking-key {
    background: #FFFFFF;
    border: 0.5pt solid #C9D3DD;
    padding: 2mm 3mm;
  }
  .banking-key-iban { flex: 0 0 68%; }
  .banking-key-bic { flex: 1; }
  .banking-key-label {
    font-size: 7pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #7E7F83;
    margin-bottom: 1mm;
  }
  .banking-key-iban .banking-key-value {
    font-family: "Courier New", monospace;
    font-size: 14pt;
    font-weight: 700;
    letter-spacing: 0.055em;
    color: #B23A48;
    white-space: nowrap;
  }
  .banking-key-bic .banking-key-value {
    font-family: "Courier New", monospace;
    font-size: 12pt;
    font-weight: 700;
    letter-spacing: 0.055em;
    color: #B23A48;
    white-space: nowrap;
  }
  .banking-key-missing {
    font-size: 8pt;
    color: #7E7F83;
    font-style: italic;
  }
  /* Task #627 — bank-transfer reference box (Prince-safe: block layout only). */
  .transfer-ref-box {
    margin-top: 2.5mm;
    padding: 2mm 3mm;
    background: #EDF4FF;
    border: 1.5pt solid #2563EB;
    border-left: 3pt solid #1D4ED8;
  }
  .transfer-ref-label {
    font-size: 7pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #1E40AF;
    margin-bottom: 1mm;
  }
  .transfer-ref-value {
    font-family: "Courier New", monospace;
    font-size: 11pt;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: #1E3A8A;
    word-break: break-all;
  }

  table.works-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 2mm;
  }
  table.works-table th {
    background: #0B2545;
    color: #FFFFFF;
    font-size: 7pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 4px 8px;
    text-align: left;
  }
  table.works-table td {
    padding: 4px 8px;
    font-size: 8pt;
    border-bottom: 0.5pt solid #E6E6E6;
  }
  table.works-table tr.zebra td {
    background: #F8F9FA;
  }

  .kpi-row {
    display: flex;
    gap: 10px;
    margin-bottom: 3mm;
  }
  .kpi-card {
    flex: 1;
    background: linear-gradient(135deg, #f7f9fc 0%, #f0f4f8 100%);
    border-top: 3px solid #0B2545;
    border-radius: 8px;
    padding: 10px;
    text-align: center;
  }
  .kpi-label {
    font-size: 7pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #7E7F83;
    margin-bottom: 2px;
  }
  .kpi-value {
    font-size: 14pt;
    font-weight: 800;
    color: #0B2545;
    font-variant-numeric: tabular-nums;
  }
  .kpi-sub {
    font-size: 6pt;
    color: #7E7F83;
    margin-top: 1px;
  }

  .info-box {
    background: #F8F9FA;
    border-left: 3pt solid #C1A27B;
    padding: 5px 10px;
  }

  /* Task #244 — single-A4 two-column body */
  .cert-grid {
    display: flex;
    gap: 10px;
    margin-bottom: 2mm;
    align-items: flex-start;
  }
  .cert-col {
    flex: 1;
    min-width: 0;
  }
  .cert-col .section-title {
    margin-bottom: 2mm;
  }
  table.works-table.waterfall td {
    font-size: 7.5pt;
    padding: 4px 8px;
  }
  table.works-table.waterfall tr.net-row td {
    border-top: 1.5pt solid #0B2545;
    border-bottom: none;
    background: #F8F9FA;
  }

  .totals-table {
    width: 100%;
    border-collapse: collapse;
  }
  .totals-table td {
    padding: 5px 10px;
    font-size: 9pt;
    border-bottom: 0.5pt solid #E6E6E6;
    color: #34312D;
  }
  .totals-table td.num {
    text-align: right;
    font-weight: 700;
    color: #0B2545;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .totals-table .totals-sub {
    display: block;
    font-size: 6.5pt;
    font-weight: 400;
    color: #7E7F83;
    text-transform: none;
    letter-spacing: 0;
  }
  .totals-table tr.grand td {
    background: linear-gradient(135deg, #f7f9fc 0%, #f0f4f8 100%);
    border-top: 2px solid #C1A27B;
    border-bottom: none;
    font-weight: 800;
    color: #0B2545;
  }
  .totals-table tr.grand td.num {
    font-size: 13pt;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 8pt;
    padding: 2px 0;
  }

  .payment-section {
    margin: 1.5mm 0;
    padding: 5px 12px;
    page-break-inside: avoid;
    background: linear-gradient(135deg, #f7f9fc 0%, #f0f4f8 100%);
    border-top: 3px solid #C1A27B;
    border-radius: 0 0 8px 8px;
  }
  .payment-propose {
    font-size: 9pt;
    margin-bottom: 4px;
    line-height: 1.4;
  }
  .payment-propose strong {
    color: #0B2545;
  }
  .payment-amount-words {
    text-align: center;
    font-size: 10pt;
    font-weight: 800;
    text-transform: uppercase;
    color: #0B2545;
    margin: 4px 0;
    padding: 4px;
    background: #FFFFFF;
    border: 1px solid #E6E6E6;
    border-left: 3pt solid #C1A27B;
    letter-spacing: 0.04em;
  }
  .payment-attention {
    text-align: center;
    font-size: 9pt;
    font-weight: 800;
    text-transform: uppercase;
    color: #0B2545;
    margin: 4px 0;
    letter-spacing: 0.06em;
  }
  .payment-instructions {
    font-size: 6.8pt;
    color: #7E7F83;
    line-height: 1.35;
    margin-top: 3px;
    text-align: justify;
  }

  /* Task #485 — plain-language client explainer (before the annexe) */
  .explain-section {
    margin: 2mm 0 0 0;
    page-break-inside: avoid;
  }
  .explain-title {
    font-size: 8.5pt;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #0B2545;
    margin-bottom: 1mm;
  }
  .explain-cards {
    display: flex;
    gap: 3mm;
  }
  .explain-card {
    flex: 1;
    background: #F8F9FA;
    border-left: 2pt solid #C1A27B;
    padding: 2mm 2.5mm;
  }
  .explain-card-title {
    font-size: 8pt;
    font-weight: 700;
    color: #0B2545;
    margin-bottom: 1mm;
  }
  .explain-card-text {
    font-size: 7.2pt;
    color: #34312D;
    line-height: 1.3;
  }
  .explain-annexe-pointer {
    font-size: 7pt;
    color: #7E7F83;
    font-style: italic;
    margin-top: 1mm;
  }

  .warning-note {
    font-size: 6pt;
    color: #7E7F83;
    margin-top: 4px;
    font-style: italic;
    padding-left: 6px;
    border-left: 2px solid #E6E6E6;
  }

  .doc-footer {
    page-break-inside: avoid;
    margin-top: 1mm;
    padding-top: 1mm;
    border-top: 0.5pt solid #E6E6E6;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .doc-footer-left {
    font-size: 6.5pt;
    color: #7E7F83;
    line-height: 1.3;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .doc-footer-left img {
    height: 12px;
    width: auto;
    display: block;
  }
  .doc-footer-right {
    font-size: 11pt;
    font-weight: 800;
    color: #0B2545;
    text-align: right;
    letter-spacing: 0.05em;
  }

  .annexe-section {
    page: annexe;
  }
  @page annexe {
    size: A4;
    margin: 7mm 10mm 12mm 10mm;
    border: 0.65pt solid #0B2545;
    padding: 3mm 4mm 3mm 4mm;
    @bottom-left {
      content: "${escapeCssString(project.name)} \u2014 ${escapeCssString(contractor.name)}";
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 7pt;
      color: #7E7F83;
    }
    @bottom-center {
      content: "Financial Summary";
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 7pt;
      color: #7E7F83;
    }
    @bottom-right {
      content: "Summary \u2014 Page " counter(page) " / " counter(pages);
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 7pt;
      color: #7E7F83;
    }
  }

  .annexe-table td {
    padding: 3px 6px;
    font-size: 7pt;
    border-bottom: 0.5pt solid #E6E6E6;
    font-variant-numeric: tabular-nums;
  }
</style>
</head>
<body>

  <div class="cover-header">
    <div class="cover-header-top">
      ${companyLogoBase64 ? `<img src="${companyLogoBase64}" alt="Company Logo" />` : `<span class="firm-name">SAS Architects-France</span>`}
      <span class="firm-name">${dateIssued}</span>
    </div>
    <div class="cover-header-bottom">
      <div class="doc-title">Certificat de Paiement${isAcompte ? " — Acompte" : ""}</div>
      <div class="doc-ref">
        ${isAcompte ? "Opening / Deposit Payment" : "Payment Authorisation"}
        <strong>${escapeHtml(certificat.certificateRef)}</strong>
      </div>
    </div>
  </div>
  <div class="accent-bar"></div>

  <div class="parties-grid">
    <div class="party-card">
      <div class="party-label">Ma\u00EEtre d'\u0152uvre \u2014 Architect</div>
      <div class="party-name">SAS ARCHITECTS-FRANCE</div>
      <div class="party-detail">
        2 Route d'Aigues-Vives, 34480 Cabrerolles<br/>
        SIRET : 953 443 918 00016
      </div>
    </div>
    <div class="party-card">
      <div class="party-label">Ma\u00EEtre d'Ouvrage \u2014 Client</div>
      <div class="party-name">${escapeHtml(project.clientName)}</div>
      <div class="party-detail">
        ${project.siteAddress ? escapeHtml(project.siteAddress) : ""}
      </div>
    </div>
    <div class="party-card">
      <div class="party-label">Contractor</div>
      <div class="party-name">${escapeHtml(contractor.name)}</div>
      <div class="party-detail">
        ${contractor.address ? escapeHtml(contractor.address) : ""}${contractor.siret ? `<br/>SIRET : ${escapeHtml(contractor.siret)}` : ""}
      </div>
    </div>
  </div>

  <div class="section-title">Works Description</div>
  <table class="works-table">
    <thead>
      <tr>
        <th>Description</th>
        <th>Contractor</th>
        <th style="text-align:center;">Lot</th>
        <th style="text-align:center;">Devis No</th>
        <th style="text-align:center;">Invoice No</th>
      </tr>
    </thead>
    <tbody>
      ${worksRows || `<tr><td colspan="5" style="color:#7E7F83;font-style:italic;">No devis linked</td></tr>`}
    </tbody>
  </table>

  <div class="cert-grid">
    <div class="cert-col">
      <div class="section-title">Deductions &amp; Net Calculation</div>
      <table class="works-table waterfall">
        <tbody>
          <tr>
            <td>Gross Cumulative Works HT (incl. PV/MV)</td>
            <td style="text-align:right;font-weight:600;">${formatCurrencyNoSymbol(grossCumulativeHt)}</td>
          </tr>
          <tr>
            <td>Retenue de Garantie (cumulative holdback)</td>
            <td style="text-align:right;color:#B23A48;">- ${formatCurrencyNoSymbol(cumulativeRetenue)}</td>
          </tr>
          <tr>
            <td>Compte Prorata (cumulative levy)</td>
            <td style="text-align:right;color:#B23A48;">- ${formatCurrencyNoSymbol(cumulativeProrata)}</td>
          </tr>
          ${periodAcompteRecoupment > 0 || cumulativeAcompteRecoupment > 0 ? `<tr>
            <td>Remboursement d'Acompte (this period${cumulativeAcompteRecoupment > 0 ? `, cumulative ${formatCurrencyNoSymbol(cumulativeAcompteRecoupment)}` : ""})</td>
            <td style="text-align:right;color:#B23A48;">- ${formatCurrencyNoSymbol(periodAcompteRecoupment)}</td>
          </tr>` : ""}
          <tr>
            <td>Previous Payments (cumulative)</td>
            <td style="text-align:right;color:#B23A48;">- ${formatCurrencyNoSymbol(previousPaymentsHt)}</td>
          </tr>
          ${isSolde && retenueReleased ? `<tr>
            <td>Lib\u00E9ration Retenue de Garantie (solde)</td>
            <td style="text-align:right;color:#1B7A3D;">+ ${formatCurrencyNoSymbol(retenueReleaseAmount)}</td>
          </tr>` : ""}
          <tr class="net-row">
            <td style="font-weight:700;color:#0B2545;">Net to Pay HT (this period)</td>
            <td style="text-align:right;font-weight:700;color:#0B2545;">${formatCurrencyNoSymbol(netHt)}</td>
          </tr>
        </tbody>
      </table>
      ${cumulativeProrata > 0 ? `<div class="warning-note">The Compte Prorata (${formatCurrencyNoSymbol(cumulativeProrata)}) is levied on this certificat and paid to the site Compte Prorata manager.</div>` : ""}
      ${isSolde && !retenueReleased && cumulativeRetenue > 0 ? `<div class="warning-note">Certificat de SOLDE \u2014 Retenue de Garantie de ${formatCurrencyNoSymbol(cumulativeRetenue)} CONSERV\u00C9E (\u00E0 lib\u00E9rer apr\u00E8s parfait ach\u00E8vement).</div>` : ""}
      ${isSolde && retenueReleased ? `<div class="warning-note">Certificat de SOLDE \u2014 Retenue de Garantie lib\u00E9r\u00E9e${certificat.retenueReleaseDate ? ` le ${formatDateFr(certificat.retenueReleaseDate)}` : ""}${certificat.retenueReleaseReason ? ` \u2014 ${escapeHtml(certificat.retenueReleaseReason)}` : ""}.</div>` : ""}
    </div>

    <div class="cert-col">
      <div class="section-title">Certificate Totals</div>
      <table class="totals-table">
        <tbody>
          <tr>
            <td>Net HT <span class="totals-sub">Hors Taxes</span></td>
            <td class="num">${formatCurrencyNoSymbol(netHt)}</td>
          </tr>
          <tr>
            <td>TVA ${tvaRateLabel} <span class="totals-sub">Taxe sur la Valeur Ajout\u00E9e</span></td>
            <td class="num">${formatCurrencyNoSymbol(tvaAmount)}</td>
          </tr>
          <tr class="grand">
            <td>Net TTC <span class="totals-sub">Toutes Taxes Comprises</span></td>
            <td class="num">${formatCurrencyNoSymbol(netTtc)}</td>
          </tr>
        </tbody>
      </table>
      ${tvaAutoliquidation ? `<div class="warning-note">Autoliquidation \u2014 TVA due par le preneur (art. 283 CGI)</div>` : ""}

      ${devisDetails.length > 0 ? `
      <div class="section-title" style="margin-top:4mm;">Summary by Devis Code</div>
      ${devisSummaryRows}
      <div class="warning-note">ATTENTION : Includes all invoices to date. May not reflect actual monies received.</div>
      ` : ""}
    </div>
  </div>

  <div class="payment-amount-words" style="margin-bottom:2mm;">
    In words : ${amountInWords}
  </div>

  ${renderBankingBlock(contractor, `<div class="payment-propose" style="margin-bottom:1.5mm;">
      In view of the progress of the work, <strong>SAS ARCHITECTS-FRANCE</strong> proposes that the client pay the sum of :
      <strong>${formatCurrencyNoSymbol(netTtc)}</strong>
    </div>`, transferRef)}

  <div class="payment-section">
    <div class="payment-attention">
      This Requires Your Payment and Attention.
    </div>
    <div class="payment-instructions">
      Please pay this now using the bank details provided in this certificate. If you need to pay from different accounts ensure that the total is the exact
      amount as shown. Please make sure that your bank does not deduct a transfer fee from the recipient. All transaction fees remain yours. The
      contractor must receive the equivalent euros in full, exactly as indicated.
    </div>
  </div>

  <div class="explain-section">
    <div class="explain-title">Please read before payment</div>
    <div class="explain-cards">
      ${isAcompte ? `<div class="explain-card">
        <div class="explain-card-title">Acompte (opening / deposit payment)</div>
        <div class="explain-card-text">This certificat authorises the contractor's opening deposit on the signed devis, requested before works are invoiced — standard French construction practice. No retention or shared-site deduction applies to the deposit itself. It is not an extra cost: the full deposit will be deducted from the next certificat de paiement for this contractor, so the total you pay over the project is unchanged.</div>
      </div>` : `<div class="explain-card">
        <div class="explain-card-title">Retenue de Garantie (retention)</div>
        <div class="explain-card-text">${retenueExplainText}</div>
      </div>
      <div class="explain-card">
        <div class="explain-card-title">Compte Prorata (shared site costs)</div>
        <div class="explain-card-text">The compte prorata is each contractor's contribution to the shared costs of the site (water, electricity, cleaning, common facilities). This deduction is paid to the site's prorata account manager, who settles those shared expenses on behalf of all the contractors.</div>
      </div>`}
    </div>
    <div class="explain-annexe-pointer">The Financial Summary on the following page shows the position of the whole project: total value of the works, amounts certified to date and works remaining.</div>
  </div>

  <div class="doc-footer">
    <div class="doc-footer-left">
      ${architectsLogoBase64 ? `<img src="${architectsLogoBase64}" alt="Order of Architects" />` : ""}
      Architects-France : Registration with the Order of Architects Occitanie S24348
    </div>
    <div class="doc-footer-right">
      ${escapeHtml(compositeRef)}
    </div>
  </div>

  ${annexeData ? buildAnnexeHtml(annexeData) : ""}

</body>
</html>`;
}

export async function buildCertificatPreviewHtml(opts?: { isAcompte?: boolean }): Promise<string> {
  const isAcompte = opts?.isAcompte ?? false;
  const [companyLogoBase64, architectsLogoBase64] = await Promise.all([
    loadLogoAsBase64("company_logo"),
    loadLogoAsBase64("architects_order_logo"),
  ]);

  const now = new Date();
  const sampleDate = new Date(now.getFullYear(), now.getMonth(), 15);

  const project: Project = {
    id: -1,
    name: "Villa Exemple",
    code: "VEX-2026",
    clientName: "M. et Mme EXEMPLE",
    clientAddress: "12 Avenue des Mimosas, 34480 Cabrerolles",
    siteAddress: "Chemin du Vignoble, 34480 Cabrerolles",
    status: "active",
    feePercentage: "10.00",
    feeType: "percentage",
    conceptionFee: null,
    planningFee: null,
    prorataPercentage: "0.00",
    hasMarche: false,
    archidocId: null,
    archidocClients: null,
    lastSyncedAt: null,
    archivedAt: null,
    clientContactName: null,
    clientContactEmail: null,
    driveFolderId: null,
    pennylaneCustomerId: null,
    createdAt: now,
    updatedAt: now,
  };

  const contractor: Contractor = {
    id: -1,
    name: "ENTREPRISE EXEMPLE BTP",
    siret: "12345678900012",
    address: "5 Rue du Commerce, 34000 Montpellier",
    email: "contact@exemple-btp.fr",
    phone: "04 67 00 00 00",
    notes: null,
    archidocId: null,
    contactName: "Jean DUPONT",
    contactJobTitle: "Gérant",
    contactMobile: "06 12 34 56 78",
    town: "Montpellier",
    postcode: "34000",
    website: null,
    insuranceStatus: "valid",
    decennaleInsurer: null,
    decennalePolicyNumber: null,
    decennaleEndDate: null,
    rcProInsurer: null,
    rcProPolicyNumber: null,
    rcProEndDate: null,
    specialConditions: null,
    accountHolderName: "ENTREPRISE EXEMPLE BTP",
    iban: "FR7630006000011234567890189",
    bic: "BNPAFRPP",
    bankName: "BNP Paribas",
    ribDocumentUrl: null,
    ribDocumentName: null,
    bankingVerifiedAt: now,
    bankingVerifiedBy: "architrak-sample",
    bankingAiExtractedData: null,
    defaultTvaRatePercent: null,
    defaultTvaAutoliquidation: false,
    archidocOrphanedAt: null,
    createdAt: now,
  };

  const lot: Lot = {
    id: -1,
    projectId: -1,
    lotNumber: "03",
    descriptionFr: "Maçonnerie - Gros œuvre",
    descriptionUk: "Masonry - Structural works",
    driveFolderId: null,
    createdAt: now,
  };

  const devisRecord: Devis = {
    id: -1,
    projectId: -1,
    contractorId: -1,
    lotId: -1,
    marcheId: null,
    notes: null,
    archisignPinnedPdfStorageKey: null,
    signedOffVia: null,
    manualSignoffAt: null,
    manualSignoffBy: null,
    manualSignoffNote: null,
    manualSignoffExternalRef: null,
    devisCode: "DEV-2026-014",
    devisNumber: "2026-014",
    ref2: null,
    descriptionFr: "Travaux de maçonnerie - extension",
    descriptionUk: "Masonry works - extension",
    amountHt: "24500.00",
    amountTtc: "29400.00",
    feePercentageOverride: null,
    invoicingMode: "mode_a",
    status: "approved",
    accountingState: "active",
    signOffStage: "signed",
    voidReason: null,
    dateSent: null,
    dateSigned: null,
    pvmvRef: null,
    pdfStorageKey: null,
    pdfFileName: null,
    validationWarnings: null,
    aiExtractedData: null,
    aiConfidence: null,
    acompteRequired: false,
    acomptePercent: null,
    acompteAmountHt: null,
    acompteTrigger: null,
    acompteState: "none",
    acompteInvoiceId: null,
    acomptePaidAt: null,
    acomptePaidVia: null,
    allowProgressBeforeAcompte: false,
    archidocDqeExportId: null,
    archisignEnvelopeId: null,
    archisignAccessUrl: null,
    archisignAccessUrlInvalidatedAt: null,
    archisignEnvelopeStatus: null,
    archisignEnvelopeExpiresAt: null,
    archisignOtpDestination: null,
    archisignSignerMessage: null,
    archisignSubjectDriftAt: null,
    archisignBodyDriftAt: null,
    identityVerification: null,
    signedPdfFetchUrlSnapshot: null,
    signedPdfStorageKey: null,
    signedPdfRetryAttempts: 0,
    signedPdfNextAttemptAt: null,
    signedPdfLastError: null,
    lotCatalogId: null,
    lotRefText: null,
    lotSequence: null,
    driveFileId: null,
    driveWebViewLink: null,
    driveUploadedAt: null,
    extractedIban: null,
    extractedBic: null,
    createdAt: now,
    updatedAt: now,
  };

  const invoice: Invoice = {
    id: -1,
    devisId: -1,
    contractorId: -1,
    projectId: -1,
    invoiceNumber: "FAC-2026-038",
    amountHt: "12000.00",
    tvaAmount: "2400.00",
    amountTtc: "14400.00",
    dateIssued: sampleDate.toISOString().slice(0, 10),
    dateSent: null,
    datePaid: null,
    status: "pending",
    pdfPath: null,
    notes: null,
    validationWarnings: null,
    aiExtractedData: null,
    aiConfidence: null,
    driveFileId: null,
    driveWebViewLink: null,
    driveUploadedAt: null,
    extractedIban: null,
    extractedBic: null,
    createdAt: now,
  };

  const certificat: Certificat = {
    id: -1,
    projectId: -1,
    contractorId: -1,
    acompteDevisId: isAcompte ? -2 : null,
    // Task #566 — PV-gate override audit fields (unused by the sample).
    pvOverrideReason: null,
    pvOverrideByUserId: null,
    pvOverrideAt: null,
    cumulativeAcompteRecoupment: "0.00",
    periodAcompteRecoupment: "0.00",
    tvaRateSource: "default",
    certificateRef: "CP-2026-007",
    dateIssued: sampleDate.toISOString().slice(0, 10),
    totalWorksHt: "24500.00",
    pvMvAdjustment: "0.00",
    previousPayments: "12000.00",
    retenueGarantie: "0.00",
    cumulativeProrataDeduction: "0.00",
    periodProrataDeduction: "0.00",
    netToPayHt: "12500.00",
    tvaRatePercent: "20.00",
    tvaAutoliquidation: false,
    tvaAmount: "2500.00",
    netToPayTtc: "15000.00",
    isSolde: false,
    retenueReleased: false,
    retenueReleaseAmount: "0.00",
    retenueReleaseReason: null,
    retenueReleaseDate: null,
    status: "draft",
    notes: null,
    driveFileId: null,
    driveWebViewLink: null,
    driveUploadedAt: null,
    pdfStorageKey: null,
    pdfFileName: null,
    issuedAt: null,
    issuanceSnapshot: null,
    version: 1,
    reissuedFromCertificatId: null,
    paymentTransferRef: null,
    createdAt: now,
  };

  const devisDetails: DevisWithDetails[] = [
    { devis: devisRecord, lot, invoices: [invoice], invoicedTtc: 14400 },
  ];

  const annexeData: AnnexeData = {
    projectName: project.name,
    projectCode: project.code,
    contractorName: contractor.name,
    projectSummary: {
      rows: [
        {
          devisCode: "DEV-2026-014",
          description: "Masonry works - extension",
          adjustedHt: 24500,
          certifiedHt: 22500,
          resteARealiser: 2000,
        },
        {
          devisCode: "DEV-2026-021",
          description: "Roofing and zinc works",
          adjustedHt: 18200,
          certifiedHt: 9100,
          resteARealiser: 9100,
        },
        {
          devisCode: "DEV-2026-025",
          description: "Electrical installation",
          adjustedHt: 12800,
          certifiedHt: 0,
          resteARealiser: 12800,
        },
      ],
      totalContractedHt: 55500,
      totalContractedTtc: 66600,
      totalCertifiedHt: 31600,
      totalCertifiedTtc: 37920,
      totalResteARealiser: 23900,
      totalResteARealiserTtc: 28680,
    },
    devisRows: [
      {
        devisCode: devisRecord.devisCode,
        descriptionFr: devisRecord.descriptionFr,
        descriptionUk: devisRecord.descriptionUk,
        lotNumber: lot.lotNumber,
        lotDescriptionFr: lot.descriptionFr,
        lotDescriptionUk: lot.descriptionUk,
        originalHt: 24500,
        originalTtc: 29400,
        avenants: [],
        pvTotalHt: 0,
        mvTotalHt: 0,
        adjustedHt: 24500,
        adjustedTtc: 29400,
      },
    ],
    previousCertificats: [
      {
        certificateRef: "CP-2026-005",
        dateIssued: new Date(now.getFullYear(), now.getMonth() - 2, 10).toISOString().slice(0, 10),
        amountHt: 10000,
        amountTtc: 12000,
      },
    ],
    previousCumulativeHt: 10000,
    previousCumulativeTtc: 12000,
    currentCertificatHt: 12500,
    currentCertificatTtc: 15000,
    cumulativeTotalHt: 22500,
    cumulativeTotalTtc: 27000,
    grandTotalOriginalHt: 24500,
    grandTotalPvHt: 0,
    grandTotalMvHt: 0,
    grandTotalAdjustedHt: 24500,
    grandTotalAdjustedTtc: 29400,
    resteARealiserHt: 2000,
    resteARealiserTtc: 2400,
  };

  return buildCertificatHtml({
    certificat,
    project,
    contractor,
    devisDetails,
    companyLogoBase64,
    architectsLogoBase64,
    annexeData,
    retenuePercent: 5,
    hasBankGuarantee: false,
    isAcompte,
    // Task #627 — sample reference for the design preview.
    transferRef: isAcompte
      ? "VEX-2026 CP-2026-007 / DEV-2026-014"
      : "VEX-2026 CP-2026-007 / F-2026-138",
  });
}

export function buildCertificatEmailBody(data: { certificat: Certificat; project: Project; contractor: Contractor }): string {
  const { certificat, project, contractor } = data;
  return `Dear Client,

Please find attached Certificat de Paiement no. ${certificat.certificateRef} for project "${project.name}" (${project.code}).

This certificat covers the works carried out by the contractor ${contractor.name}.

Net amount payable TTC: ${formatCurrency(certificat.netToPayTtc)}

We kindly ask you to arrange payment at your earliest convenience.

Kind regards,
SAS Architects-France`;
}
