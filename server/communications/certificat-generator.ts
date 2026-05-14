import { storage } from "../storage";
import { uploadDocument, getDocumentBuffer } from "../storage/object-storage";
import { convertHtmlToPdf } from "../services/docraptor";
import { enqueueDriveUpload } from "../services/drive/upload-queue.service";
import { roundCurrency } from "@shared/financial-utils";
import type { Certificat, Project, Contractor, Devis, Lot, Invoice, Avenant } from "@shared/schema";
import { formatLotDescription } from "@shared/lot-label";

interface DevisWithDetails {
  devis: Devis;
  lot: Lot | null;
  invoices: Invoice[];
  invoicedTtc: number;
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

interface AnnexeData {
  projectName: string;
  projectCode: string;
  contractorName: string;
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

function numberToFrenchWords(n: number): string {
  if (n === 0) return "Z\u00C9RO EUROS";

  const units = ["", "UN", "DEUX", "TROIS", "QUATRE", "CINQ", "SIX", "SEPT", "HUIT", "NEUF",
    "DIX", "ONZE", "DOUZE", "TREIZE", "QUATORZE", "QUINZE", "SEIZE", "DIX-SEPT", "DIX-HUIT", "DIX-NEUF"];
  const tens = ["", "", "VINGT", "TRENTE", "QUARANTE", "CINQUANTE", "SOIXANTE", "SOIXANTE", "QUATRE-VINGT", "QUATRE-VINGT"];

  function chunk(num: number): string {
    if (num === 0) return "";
    if (num < 20) return units[num];
    if (num < 70) {
      const t = Math.floor(num / 10);
      const u = num % 10;
      if (u === 0) return tens[t];
      if (u === 1 && t !== 8) return `${tens[t]} ET UN`;
      return `${tens[t]}-${units[u]}`;
    }
    if (num < 80) {
      const u = num - 60;
      if (u === 1) return "SOIXANTE ET ONZE";
      return `SOIXANTE-${units[u]}`;
    }
    if (num < 100) {
      const u = num - 80;
      if (u === 0) return "QUATRE-VINGTS";
      return `QUATRE-VINGT-${units[u]}`;
    }
    if (num < 200) {
      const r = num - 100;
      if (r === 0) return "CENT";
      return `CENT ${chunk(r)}`;
    }
    if (num < 1000) {
      const h = Math.floor(num / 100);
      const r = num % 100;
      if (r === 0) return `${units[h]} CENTS`;
      return `${units[h]} CENT ${chunk(r)}`;
    }
    return "";
  }

  const euros = Math.floor(n);
  const cents = Math.round((n - euros) * 100);

  let result = "";

  if (euros >= 1000000) {
    const millions = Math.floor(euros / 1000000);
    const remainder = euros % 1000000;
    result += millions === 1 ? "UN MILLION" : `${chunk(millions)} MILLIONS`;
    if (remainder > 0) result += " " + buildThousands(remainder);
  } else {
    result = buildThousands(euros);
  }

  function buildThousands(num: number): string {
    if (num === 0) return "";
    if (num < 1000) return chunk(num);
    const thousands = Math.floor(num / 1000);
    const remainder = num % 1000;
    let s = thousands === 1 ? "MILLE" : `${chunk(thousands)} MILLE`;
    if (remainder > 0) s += " " + chunk(remainder);
    return s;
  }

  result += " EURO" + (euros !== 1 ? "S" : "");
  if (cents > 0) {
    result += ` ET ${chunk(cents)} CENTIME${cents !== 1 ? "S" : ""}`;
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
  const previousCerts = allCertificats.filter((c) => c.id !== certificat.id);

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

  return {
    projectName: project.name,
    projectCode: project.code,
    contractorName: contractor.name,
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
      ? `LOT ${dr.lotNumber}<div style="font-weight:400;font-size:6.5pt;color:#7E7F83;">${formatLotDescription({ descriptionFr: dr.lotDescriptionFr, descriptionUk: dr.lotDescriptionUk })}</div>`
      : `LOT ${dr.lotNumber}`;
    const devisDescHtml = dr.descriptionUk && dr.descriptionUk !== dr.descriptionFr
      ? `${dr.descriptionFr}<div style="font-weight:400;font-size:6.5pt;color:#7E7F83;font-style:italic;">${dr.descriptionUk}</div>`
      : dr.descriptionFr;
    marcheRows += `<tr${zebraClass}>
      <td style="font-weight:700;color:#0B2545;">${lotLabelHtml}</td>
      <td style="font-weight:700;color:#0B2545;">${dr.devisCode}</td>
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
        ? `${av.descriptionFr} <span style="color:#7E7F83;font-style:italic;">(${av.descriptionUk})</span>`
        : av.descriptionFr;
      marcheRows += `<tr style="background:#FAFAFA;">
        <td></td>
        <td style="padding-left:16px;border-left:3px solid #C1A27B;font-size:6.5pt;color:#7E7F83;">${av.avenantNumber}</td>
        <td style="font-size:6.5pt;color:#34312D;">${avDescHtml}</td>
        <td style="text-align:right;font-size:6.5pt;">—</td>
        <td style="text-align:right;font-size:6.5pt;color:${typeColor};font-weight:600;">${av.type === "pv" ? fmtNum(av.amountHt) : "—"}</td>
        <td style="text-align:right;font-size:6.5pt;color:${typeColor};font-weight:600;">${av.type === "mv" ? fmtNum(av.amountHt) : "—"}</td>
        <td style="text-align:right;font-size:6.5pt;">—</td>
      </tr>`;
    }
    if (dr.avenants.length > 0) {
      marcheRows += `<tr style="background:#F0F2F5;">
        <td colspan="3" style="text-align:right;font-weight:700;font-size:6.5pt;color:#7E7F83;text-transform:uppercase;">Sous-total ${dr.devisCode}</td>
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
      <td>${pc.certificateRef}</td>
      <td style="text-align:center;">${pc.dateIssued}</td>
      <td style="text-align:right;">${fmtNum(pc.amountHt)}</td>
      <td style="text-align:right;">${fmtNum(pc.amountTtc)}</td>
    </tr>`;
  }

  return `
  <div class="annexe-section" style="page-break-before:always;">
    <div style="text-align:center;margin-bottom:6mm;">
      <div style="font-size:14pt;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;color:#0B2545;">Annexe Financi\u00E8re</div>
      <div style="font-size:8pt;color:#7E7F83;margin-top:2px;">${data.projectName} (${data.projectCode}) — ${data.contractorName}</div>
    </div>
    <div class="accent-bar"></div>

    <div style="font-size:10pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#0B2545;margin-bottom:3mm;padding-bottom:1.5mm;border-bottom:1px solid #E6E6E6;">
      1. March\u00E9 — R\u00E9capitulatif des Devis &amp; Avenants
    </div>
    <table class="annexe-table" style="width:100%;border-collapse:collapse;margin-bottom:6mm;font-size:7pt;">
      <thead>
        <tr>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:left;">Lot</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:left;">Devis</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:left;">Description</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">Original HT</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">PV (+)</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">MV (\u2212)</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">Ajust\u00E9 HT</th>
        </tr>
      </thead>
      <tbody>
        ${marcheRows}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid #0B2545;background:#E8ECF1;">
          <td colspan="3" style="font-weight:800;font-size:7pt;color:#0B2545;text-transform:uppercase;padding:6px;">TOTAL G\u00C9N\u00C9RAL</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.grandTotalOriginalHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#2a7d2e;padding:6px;">${fmtNum(data.grandTotalPvHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#c0392b;padding:6px;">${fmtNum(data.grandTotalMvHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.grandTotalAdjustedHt)}</td>
        </tr>
        <tr style="background:#E8ECF1;">
          <td colspan="6" style="text-align:right;font-size:6.5pt;color:#7E7F83;padding:3px 6px;">March\u00E9 Ajust\u00E9 TTC</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#0B2545;padding:3px 6px;">${fmtNum(data.grandTotalAdjustedTtc)}</td>
        </tr>
      </tfoot>
    </table>

    <div style="font-size:10pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#0B2545;margin-bottom:3mm;padding-bottom:1.5mm;border-bottom:1px solid #E6E6E6;">
      2. Situation des Travaux — Historique des Paiements
    </div>
    <table class="annexe-table" style="width:100%;border-collapse:collapse;margin-bottom:6mm;font-size:7pt;">
      <thead>
        <tr>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:left;">R\u00E9f\u00E9rence</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:center;">Date</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">Montant HT</th>
          <th style="background:#0B2545;color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:right;">Montant TTC</th>
        </tr>
      </thead>
      <tbody>
        ${situationRows || `<tr><td colspan="4" style="color:#7E7F83;font-style:italic;padding:6px;">Aucun certificat pr\u00E9c\u00E9dent</td></tr>`}
        ${data.previousCertificats.length > 0 ? `
        <tr style="border-top:1px solid #C1A27B;background:#FDF8F3;">
          <td colspan="2" style="font-weight:700;font-size:6.5pt;color:#7E7F83;text-transform:uppercase;padding:4px 6px;">Cumul pr\u00E9c\u00E9dent</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#34312D;padding:4px 6px;">${fmtNum(data.previousCumulativeHt)}</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#34312D;padding:4px 6px;">${fmtNum(data.previousCumulativeTtc)}</td>
        </tr>` : ""}
        <tr style="background:#FFF9F0;border-left:3px solid #C1A27B;">
          <td style="font-weight:800;color:#0B2545;padding:6px;">CERTIFICAT ACTUEL</td>
          <td style="text-align:center;font-weight:600;color:#0B2545;padding:6px;">${formatDateFr(null)}</td>
          <td style="text-align:right;font-weight:800;color:#0B2545;padding:6px;">${fmtNum(data.currentCertificatHt)}</td>
          <td style="text-align:right;font-weight:800;color:#0B2545;padding:6px;">${fmtNum(data.currentCertificatTtc)}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid #0B2545;background:#E8ECF1;">
          <td colspan="2" style="font-weight:800;font-size:7pt;color:#0B2545;text-transform:uppercase;padding:6px;">CUMUL TOTAL CERTIFI\u00C9</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.cumulativeTotalHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.cumulativeTotalTtc)}</td>
        </tr>
        <tr style="background:#F8F9FA;">
          <td colspan="2" style="font-weight:700;font-size:7pt;color:#0B2545;padding:6px;">March\u00E9 Ajust\u00E9</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.grandTotalAdjustedHt)}</td>
          <td style="text-align:right;font-weight:700;font-size:7pt;color:#0B2545;padding:6px;">${fmtNum(data.grandTotalAdjustedTtc)}</td>
        </tr>
        <tr style="background:#FDF8F3;border-top:1px solid #C1A27B;">
          <td colspan="2" style="font-weight:800;font-size:7pt;color:#C1A27B;text-transform:uppercase;padding:6px;">RESTE \u00C0 R\u00C9ALISER</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#C1A27B;padding:6px;">${fmtNum(data.resteARealiserHt)}</td>
          <td style="text-align:right;font-weight:800;font-size:7pt;color:#C1A27B;padding:6px;">${fmtNum(data.resteARealiserTtc)}</td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

export async function generateCertificatPdf(certificatId: number): Promise<{ storageKey: string; pdfBuffer: Buffer }> {
  const certificat = await storage.getCertificat(certificatId);
  if (!certificat) throw new Error(`Certificat ${certificatId} not found`);

  const project = await storage.getProject(certificat.projectId);
  if (!project) throw new Error(`Project ${certificat.projectId} not found`);

  const contractor = await storage.getContractor(certificat.contractorId);
  if (!contractor) throw new Error(`Contractor ${certificat.contractorId} not found`);

  const allDevis = await storage.getDevisByProjectAndContractor(certificat.projectId, certificat.contractorId);
  const activeDevis = allDevis.filter(d => d.status !== "void");

  const devisDetails: DevisWithDetails[] = await Promise.all(
    activeDevis.map(async (d) => {
      const lot = d.lotId ? (await storage.getLot(d.lotId)) ?? null : null;
      const invoices = await storage.getInvoicesByDevis(d.id);
      const invoicedTtc = invoices.reduce((sum, inv) => sum + parseFloat(inv.amountTtc), 0);
      return { devis: d, lot, invoices, invoicedTtc };
    })
  );

  const [companyLogoBase64, architectsLogoBase64] = await Promise.all([
    loadLogoAsBase64("company_logo"),
    loadLogoAsBase64("architects_order_logo"),
  ]);

  const annexeData = await buildAnnexeData(certificat, project, contractor, activeDevis);

  const html = buildCertificatHtml({ certificat, project, contractor, devisDetails, companyLogoBase64, architectsLogoBase64, annexeData });

  const dateStr = new Date().toISOString().split("T")[0].replace(/-/g, "");
  const projectCode = (project.code || "PROJ").replace(/[^a-zA-Z0-9]/g, "");
  const docName = `CERT-${projectCode}-${certificat.certificateRef}-${dateStr}`;
  const fileName = `${docName}.pdf`;

  const pdfBuffer = await convertHtmlToPdf(html, docName);
  const storageKey = await uploadDocument(project.id, fileName, pdfBuffer, "application/pdf");

  // Mirror the certificat PDF into the Renosud shared Drive so it
  // lands in the same `{Lot} {project} {devisCode}` per-lot folder as
  // the devis and factures. Enqueue runs at PDF materialisation time
  // (covers both /preview and /send paths) and is idempotent on
  // (doc_kind, doc_id), so repeated previews collapse to one Drive
  // copy. The whole call no-ops when DRIVE_AUTO_UPLOAD_ENABLED is
  // false — gated inside enqueueDriveUpload itself.
  const seedDevis = activeDevis.find((d) => d.lotId != null) ?? activeDevis[0];
  void enqueueDriveUpload({
    docKind: "certificat",
    docId: certificat.id,
    projectId: project.id,
    lotId: seedDevis?.lotId ?? null,
    sourceStorageKey: storageKey,
    displayName: `${docName}.pdf`,
    seedDevisCode: seedDevis?.devisCode ?? `cert-${certificat.certificateRef}`,
  });

  return { storageKey, pdfBuffer };
}

function buildCertificatHtml(data: CertificatPdfData): string {
  const { certificat, project, contractor, devisDetails, companyLogoBase64, architectsLogoBase64, annexeData } = data;

  const netTtc = parseFloat(certificat.netToPayTtc);
  const netHt = parseFloat(certificat.netToPayHt);
  const tvaAmount = parseFloat(certificat.tvaAmount);
  const amountInWords = numberToFrenchWords(netTtc);

  const primaryLot = devisDetails.find(d => d.lot)?.lot;
  const lotLabel = primaryLot ? `LOT ${primaryLot.lotNumber}` : "LOT";
  const compositeRef = `${lotLabel} ${certificat.certificateRef}`;
  const dateIssued = formatDateFr(certificat.dateIssued);

  const worksRows = devisDetails.map((dd, i) => {
    const lotDesc = dd.lot ? formatLotDescription(dd.lot) : "";
    const lotNum = dd.lot
      ? `LOT ${dd.lot.lotNumber}${lotDesc ? `<div style="font-weight:400;font-size:7pt;color:#7E7F83;">${lotDesc}</div>` : ""}`
      : "\u2014";
    const worksDesc = formatLotDescription(dd.devis) || "\u2014";
    const invoiceNums = dd.invoices.length > 0
      ? dd.invoices.map(inv => `#${inv.invoiceNumber}`).join(", ")
      : "\u2014";
    const rowClass = i % 2 === 1 ? ' class="zebra"' : "";
    return `<tr${rowClass}>
      <td>${worksDesc}</td>
      <td>${contractor.name}</td>
      <td style="text-align:center;">${lotNum}</td>
      <td style="text-align:center;">${dd.devis.devisCode}</td>
      <td style="text-align:center;">${invoiceNums}</td>
    </tr>`;
  }).join("");

  const devisSummaryRows = devisDetails.map(dd => {
    const worksTtc = parseFloat(dd.devis.amountTtc);
    const invoicedTtc = dd.invoicedTtc;
    const remaining = worksTtc - invoicedTtc;
    return `<div class="info-box" style="margin-bottom:10px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="font-weight:700;font-size:10pt;color:#0B2545;padding-bottom:6px;" colspan="2">
            ${dd.devis.descriptionFr || dd.devis.descriptionUk || "\u2014"}
            <span style="float:right;font-size:9pt;color:#7E7F83;font-weight:400;">${dd.devis.devisCode}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:3px 0;font-size:9pt;color:#34312D;">Valeur Travaux TTC</td>
          <td class="num">${formatCurrencyNoSymbol(worksTtc)}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;font-size:9pt;color:#34312D;">Factur\u00E9 \u00E0 ce jour</td>
          <td class="num">${formatCurrencyNoSymbol(invoicedTtc)}</td>
        </tr>
        <tr style="border-top:1px solid #E6E6E6;">
          <td style="padding:5px 0 3px;font-size:9pt;font-weight:700;color:#0B2545;">Restant</td>
          <td class="num" style="font-weight:700;color:#0B2545;">${formatCurrencyNoSymbol(remaining)}</td>
        </tr>
      </table>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${compositeRef} \u2014 Certificat de Paiement</title>
<style>
  @page {
    size: A4;
    margin: 12mm 18mm 18mm 18mm;
    @bottom-left {
      content: "${project.name} \u2014 ${project.clientName}";
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
    font-size: 10pt;
    color: #34312D;
    line-height: 1.55;
  }

  .cover-header {
    background: #FFFFFF;
    color: #0B2545;
    padding: 0 0 10px 0;
    margin: 0;
  }
  .cover-header-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 8px;
  }
  .cover-header-top img {
    height: 96px;
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
    margin-bottom: 4mm;
  }

  .section-title {
    font-size: 11pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #0B2545;
    margin-bottom: 3mm;
    padding-bottom: 1.5mm;
    border-bottom: 1px solid #E6E6E6;
  }

  .parties-grid {
    display: flex;
    gap: 12px;
    margin-bottom: 4mm;
  }
  .party-card {
    flex: 1;
    background: #F8F9FA;
    border-left: 3pt solid #C1A27B;
    padding: 8px 12px;
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

  table.works-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 4mm;
  }
  table.works-table th {
    background: #0B2545;
    color: #FFFFFF;
    font-size: 7pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 6px 8px;
    text-align: left;
  }
  table.works-table td {
    padding: 6px 8px;
    font-size: 8pt;
    border-bottom: 0.5pt solid #E6E6E6;
  }
  table.works-table tr.zebra td {
    background: #F8F9FA;
  }

  .kpi-row {
    display: flex;
    gap: 10px;
    margin-bottom: 4mm;
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
    padding: 8px 12px;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 8pt;
    padding: 2px 0;
  }

  .payment-section {
    margin: 4mm 0;
    padding: 12px 16px;
    background: linear-gradient(135deg, #f7f9fc 0%, #f0f4f8 100%);
    border-top: 3px solid #C1A27B;
    border-radius: 0 0 8px 8px;
  }
  .payment-propose {
    font-size: 9pt;
    margin-bottom: 6px;
    line-height: 1.5;
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
    margin: 8px 0;
    padding: 8px;
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
    color: #c0392b;
    margin: 6px 0;
    letter-spacing: 0.06em;
  }
  .payment-instructions {
    font-size: 7pt;
    color: #7E7F83;
    line-height: 1.5;
    margin-top: 6px;
    text-align: justify;
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
    margin-top: 4mm;
    padding-top: 3mm;
    border-top: 0.5pt solid #E6E6E6;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }
  .doc-footer-left {
    font-size: 7pt;
    color: #7E7F83;
    line-height: 1.5;
  }
  .doc-footer-left img {
    height: 24px;
    width: auto;
    margin-bottom: 3px;
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
    @bottom-left {
      content: "${project.name} \u2014 ${contractor.name}";
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 7pt;
      color: #7E7F83;
    }
    @bottom-center {
      content: "Annexe Financi\u00E8re";
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 7pt;
      color: #7E7F83;
    }
    @bottom-right {
      content: "Annexe \u2014 Page " counter(page) " / " counter(pages);
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
      <div class="doc-title">Certificat de Paiement</div>
      <div class="doc-ref">
        Payment Authorisation
        <strong>${certificat.certificateRef}</strong>
      </div>
    </div>
  </div>
  <div class="accent-bar"></div>

  <div class="parties-grid">
    <div class="party-card">
      <div class="party-label">Ma\u00EEtre d'\u0152uvre</div>
      <div class="party-name">SAS ARCHITECTS-FRANCE</div>
      <div class="party-detail">
        2 Route d'Aigues-Vives, 34480 Cabrerolles<br/>
        SIRET : 953 443 918 00016
      </div>
    </div>
    <div class="party-card">
      <div class="party-label">Ma\u00EEtre d'Ouvrage</div>
      <div class="party-name">${project.clientName}</div>
      <div class="party-detail">
        ${project.siteAddress || ""}
      </div>
    </div>
    <div class="party-card">
      <div class="party-label">Contractor</div>
      <div class="party-name">${contractor.name}</div>
      <div class="party-detail">
        ${contractor.address || ""}${contractor.siret ? `<br/>SIRET : ${contractor.siret}` : ""}
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

  <div class="section-title">Financial Summary</div>
  <div class="kpi-row">
    <div class="kpi-card">
      <div class="kpi-label">Net HT</div>
      <div class="kpi-value">${formatCurrencyNoSymbol(netHt)}</div>
      <div class="kpi-sub">Hors Taxes</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">TVA</div>
      <div class="kpi-value">${formatCurrencyNoSymbol(tvaAmount)}</div>
      <div class="kpi-sub">Taxe sur la Valeur Ajout\u00E9e</div>
    </div>
    <div class="kpi-card" style="border-top-color:#C1A27B;">
      <div class="kpi-label">Net TTC</div>
      <div class="kpi-value">${formatCurrencyNoSymbol(netTtc)}</div>
      <div class="kpi-sub">Toutes Taxes Comprises</div>
    </div>
  </div>

  ${devisDetails.length > 0 ? `
  <div class="section-title">Summary by Devis Code</div>
  ${devisSummaryRows}
  <div class="warning-note">
    ATTENTION : Includes all invoices to date. May not reflect actual monies received.
  </div>
  ` : ""}

  <div class="payment-section">
    <div class="payment-propose">
      In view of the progress of the work, <strong>SAS ARCHITECTS-FRANCE</strong> proposes that the client pay the sum of :
      <strong>${formatCurrencyNoSymbol(netTtc)}</strong>
    </div>
    <div class="payment-amount-words">
      En toutes lettres : ${amountInWords}
    </div>
    <div class="payment-attention">
      This Requires Your Payment and Attention.
    </div>
    <div class="payment-instructions">
      Please pay this now using the bank details provided in the email. If you need to pay from different accounts ensure that the total is the exact
      amount as shown. Please make sure that your bank does not deduct a transfer fee from the recipient. All transaction fees remain yours. The
      contractor must receive the equivalent euros in full, exactly as indicated.
    </div>
  </div>

  ${annexeData ? buildAnnexeHtml(annexeData) : ""}

  <div class="doc-footer">
    <div class="doc-footer-left">
      ${architectsLogoBase64 ? `<img src="${architectsLogoBase64}" alt="Order of Architects" />` : ""}
      Architects-France : Registration with the Order of Architects Occitanie S24348
    </div>
    <div class="doc-footer-right">
      ${compositeRef}
    </div>
  </div>

</body>
</html>`;
}

export async function buildCertificatPreviewHtml(): Promise<string> {
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
    hasMarche: false,
    archidocId: null,
    archidocClients: null,
    lastSyncedAt: null,
    archivedAt: null,
    clientContactName: null,
    clientContactEmail: null,
    driveFolderId: null,
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
    allowProgressBeforeAcompte: false,
    archidocDqeExportId: null,
    archisignEnvelopeId: null,
    archisignAccessUrl: null,
    archisignAccessUrlInvalidatedAt: null,
    archisignEnvelopeStatus: null,
    archisignEnvelopeExpiresAt: null,
    archisignOtpDestination: null,
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
    createdAt: now,
    updatedAt: now,
  };

  const invoice: Invoice = {
    id: -1,
    devisId: -1,
    contractorId: -1,
    projectId: -1,
    certificateNumber: null,
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
    createdAt: now,
  };

  const certificat: Certificat = {
    id: -1,
    projectId: -1,
    contractorId: -1,
    certificateRef: "CP-2026-007",
    dateIssued: sampleDate.toISOString().slice(0, 10),
    totalWorksHt: "24500.00",
    pvMvAdjustment: "0.00",
    previousPayments: "12000.00",
    retenueGarantie: "0.00",
    netToPayHt: "12500.00",
    tvaAmount: "2500.00",
    netToPayTtc: "15000.00",
    status: "draft",
    notes: null,
    driveFileId: null,
    driveWebViewLink: null,
    driveUploadedAt: null,
    createdAt: now,
  };

  const devisDetails: DevisWithDetails[] = [
    { devis: devisRecord, lot, invoices: [invoice], invoicedTtc: 14400 },
  ];

  const annexeData: AnnexeData = {
    projectName: project.name,
    projectCode: project.code,
    contractorName: contractor.name,
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
  });
}

export function buildCertificatEmailBody(data: { certificat: Certificat; project: Project; contractor: Contractor }): string {
  const { certificat, project, contractor } = data;
  return `Madame, Monsieur,

Veuillez trouver ci-joint le Certificat de Paiement n\u00B0 ${certificat.certificateRef} relatif au projet "${project.name}" (${project.code}).

Ce certificat concerne les travaux r\u00E9alis\u00E9s par l'entreprise ${contractor.name}.

Montant net \u00E0 payer TTC: ${formatCurrency(certificat.netToPayTtc)}

Nous vous remercions de bien vouloir proc\u00E9der au r\u00E8glement dans les meilleurs d\u00E9lais.

Cordialement,
SAS Architects-France`;
}
