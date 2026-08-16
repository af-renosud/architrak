import { PDFDocument } from "pdf-lib";
import { storage } from "../storage";
import { getDocumentBuffer } from "../storage/object-storage";
import { convertHtmlToPdf } from "./docraptor";
import { getProjectFinancialSummary } from "./financial-summary.service";
import { formatCurrencyNoSymbol, roundCurrency } from "../../shared/financial-utils";

/**
 * Task #413 — One-page project financial overview ("Situation financière du
 * projet") generated as a PDF addendum. It can be downloaded alone at project
 * level, or appended as the final page(s) of a stored invoice PDF so the
 * architect can send the client a single combined document.
 *
 * All figures come straight from the project financial summary service so the
 * addendum can never disagree with the in-app dashboard. Rendering is static
 * HTML/CSS through DocRaptor (Prince): no JavaScript charts, no CSS grid.
 */

export interface OverviewDevisRow {
  devisCode: string;
  description: string;
  signed: boolean;
  adjustedHt: number;
  certifiedHt: number;
  resteARealiser: number;
}

/**
 * One-page guarantee: at most this many individual devis rows are rendered.
 * Anything beyond is deterministically folded into a single "Autres devis"
 * rollup row (largest adjusted amounts stay itemised). 14 compact rows +
 * header/KPIs/progress/footer fit A4 with margin to spare.
 */
export const MAX_DEVIS_ROWS = 14;

export interface OverviewRollupRow {
  count: number;
  adjustedHt: number;
  certifiedHt: number;
  resteARealiser: number;
}

export interface ProjectOverviewData {
  projectName: string;
  projectCode: string;
  clientName: string | null;
  generatedAt: Date;
  totalContractedHt: number;
  totalContractedTtc: number;
  totalCertifiedHt: number;
  totalCertifiedTtc: number;
  totalResteARealiser: number;
  totalResteARealiserTtc: number;
  /** 0-100, share of the contracted works already invoiced (HT). */
  progressPercent: number;
  devisRows: OverviewDevisRow[];
  /** Aggregate of devis beyond MAX_DEVIS_ROWS; null when everything fits. */
  rollup: OverviewRollupRow | null;
}

interface SummaryDevisRow {
  devisCode: string;
  descriptionFr: string | null;
  descriptionUk: string | null;
  status: string;
  accountingState: string | null;
  signOffStage: string | null;
  adjustedHt: number;
  certifiedHt: number;
  resteARealiser: number;
}

export interface FinancialSummaryPayload {
  projectName: string;
  projectCode: string | null;
  devis: SummaryDevisRow[];
  totalContractedHt: number;
  totalContractedTtc: number;
  totalCertifiedHt: number;
  totalCertifiedTtc: number;
  totalResteARealiser: number;
  totalResteARealiserTtc: number;
}

/**
 * Pure mapping from the financial-summary payload to the overview template
 * data. Exported for unit tests: the totals here MUST be the summary's totals
 * verbatim (already rounded by the summary service), never recomputed.
 */
export function buildProjectOverviewData(
  summary: FinancialSummaryPayload,
  clientName: string | null,
  now: Date = new Date(),
): ProjectOverviewData {
  const activeDevis = summary.devis.filter(
    (d) => d.accountingState === "active" && d.status !== "void",
  );

  const progressPercent =
    summary.totalContractedHt > 0
      ? Math.min(
          100,
          Math.max(
            0,
            roundCurrency((summary.totalCertifiedHt / summary.totalContractedHt) * 100),
          ),
        )
      : 0;

  const allRows: OverviewDevisRow[] = activeDevis.map((d) => ({
    devisCode: d.devisCode,
    description: d.descriptionFr || d.descriptionUk || "",
    // NB: the canonical signed terminal stage is "client_signed_off" — a
    // prior version compared against "signed_off", which does not exist.
    signed: d.signOffStage === "client_signed_off",
    adjustedHt: d.adjustedHt,
    certifiedHt: d.certifiedHt,
    resteARealiser: d.resteARealiser,
  }));

  // One-page guarantee: keep the largest devis itemised, fold the tail into
  // a single rollup row. Sort is deterministic (amount desc, then code).
  let devisRows = allRows;
  let rollup: OverviewRollupRow | null = null;
  if (allRows.length > MAX_DEVIS_ROWS) {
    const sorted = [...allRows].sort(
      (a, b) => b.adjustedHt - a.adjustedHt || a.devisCode.localeCompare(b.devisCode),
    );
    const kept = sorted.slice(0, MAX_DEVIS_ROWS - 1);
    const folded = sorted.slice(MAX_DEVIS_ROWS - 1);
    devisRows = kept;
    rollup = {
      count: folded.length,
      adjustedHt: roundCurrency(folded.reduce((s, r) => s + r.adjustedHt, 0)),
      certifiedHt: roundCurrency(folded.reduce((s, r) => s + r.certifiedHt, 0)),
      resteARealiser: roundCurrency(folded.reduce((s, r) => s + r.resteARealiser, 0)),
    };
  }

  return {
    projectName: summary.projectName,
    projectCode: summary.projectCode ?? "",
    clientName,
    generatedAt: now,
    totalContractedHt: summary.totalContractedHt,
    totalContractedTtc: summary.totalContractedTtc,
    totalCertifiedHt: summary.totalCertifiedHt,
    totalCertifiedTtc: summary.totalCertifiedTtc,
    totalResteARealiser: summary.totalResteARealiser,
    totalResteARealiserTtc: summary.totalResteARealiserTtc,
    progressPercent,
    devisRows,
    rollup,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

const NAVY = "#0B2545";
const GOLD = "#C1A27B";
const GREY = "#7E7F83";

export function buildProjectOverviewHtml(
  data: ProjectOverviewData,
  companyLogoBase64: string | null,
): string {
  const fmt = (v: number) => formatCurrencyNoSymbol(v);
  const dateStr = data.generatedAt.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Progress bar as nested divs with fixed widths — Prince-safe (no grid, no JS).
  const pct = data.progressPercent;
  const pctLabel = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(pct);

  let rows = "";
  data.devisRows.forEach((r, i) => {
    const zebra = i % 2 === 1 ? ' style="background:#F8F9FA;"' : "";
    rows += `<tr${zebra}>
      <td style="font-weight:700;color:${NAVY};white-space:nowrap;">${escapeHtml(r.devisCode)}</td>
      <td>${escapeHtml(r.description)}</td>
      <td style="text-align:center;">${
        r.signed
          ? `<span style="color:#2a7d2e;font-weight:700;">Signé</span>`
          : `<span style="color:${GREY};">—</span>`
      }</td>
      <td style="text-align:right;font-weight:600;">${fmt(r.adjustedHt)}</td>
      <td style="text-align:right;">${fmt(r.certifiedHt)}</td>
      <td style="text-align:right;font-weight:600;color:${GOLD};">${fmt(r.resteARealiser)}</td>
    </tr>`;
  });
  if (data.rollup) {
    const r = data.rollup;
    rows += `<tr style="background:#F0F2F5;">
      <td style="font-weight:700;color:${GREY};white-space:nowrap;">Autres devis</td>
      <td style="color:${GREY};font-style:italic;">${r.count} autres devis regroupés</td>
      <td style="text-align:center;color:${GREY};">—</td>
      <td style="text-align:right;font-weight:600;">${fmt(r.adjustedHt)}</td>
      <td style="text-align:right;">${fmt(r.certifiedHt)}</td>
      <td style="text-align:right;font-weight:600;color:${GOLD};">${fmt(r.resteARealiser)}</td>
    </tr>`;
  }
  if (!rows) {
    rows = `<tr><td colspan="6" style="color:${GREY};font-style:italic;padding:8px;">Aucun devis actif pour ce projet</td></tr>`;
  }

  const th = (label: string, align: string) =>
    `<th style="background:${NAVY};color:#FFF;font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:5px 6px;text-align:${align};">${label}</th>`;

  const kpiCell = (label: string, valueHt: number, valueTtc: number, accent: string) => `
    <td style="width:33.33%;padding:0 2mm;vertical-align:top;">
      <div style="border:1px solid #E6E6E6;border-top:3px solid ${accent};border-radius:4px;padding:4mm 4mm 3.5mm;">
        <div style="font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${GREY};margin-bottom:2mm;">${label}</div>
        <div style="font-size:14pt;font-weight:800;color:${NAVY};">${fmt(valueTtc)}</div>
        <div style="font-size:7pt;color:${GREY};margin-top:1mm;">TTC &nbsp;·&nbsp; ${fmt(valueHt)} HT</div>
      </div>
    </td>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #34312D; font-size: 8pt; margin: 0; }
  table { border-collapse: collapse; }
  td, th { padding: 4px 6px; }
</style>
</head>
<body>
  <table style="width:100%;margin-bottom:5mm;">
    <tr>
      <td style="vertical-align:middle;padding:0;">
        ${companyLogoBase64 ? `<img src="${companyLogoBase64}" style="max-height:16mm;max-width:50mm;" alt="">` : ""}
      </td>
      <td style="vertical-align:middle;text-align:right;padding:0;">
        <div style="font-size:14pt;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:${NAVY};">Situation financière du projet</div>
        <div style="font-size:8pt;color:${GREY};margin-top:1mm;">
          ${escapeHtml(data.projectName)}${data.projectCode ? ` (${escapeHtml(data.projectCode)})` : ""}
          ${data.clientName ? ` — ${escapeHtml(data.clientName)}` : ""}
        </div>
        <div style="font-size:7pt;color:${GREY};margin-top:0.5mm;">Établie le ${escapeHtml(dateStr)}</div>
      </td>
    </tr>
  </table>
  <div style="height:2px;background:${GOLD};margin-bottom:6mm;"></div>

  <table style="width:100%;margin:0 -2mm 6mm;border-spacing:0;">
    <tr>
      ${kpiCell("Montant total des travaux", data.totalContractedHt, data.totalContractedTtc, NAVY)}
      ${kpiCell("Total facturé à ce jour", data.totalCertifiedHt, data.totalCertifiedTtc, "#2a7d2e")}
      ${kpiCell("Reste à payer", data.totalResteARealiser, data.totalResteARealiserTtc, GOLD)}
    </tr>
  </table>

  <div style="margin-bottom:7mm;">
    <table style="width:100%;margin-bottom:1.5mm;">
      <tr>
        <td style="padding:0;font-size:7pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${NAVY};">Avancement de la facturation</td>
        <td style="padding:0;text-align:right;font-size:9pt;font-weight:800;color:${NAVY};">${pctLabel}&nbsp;%</td>
      </tr>
    </table>
    <div style="width:100%;height:7mm;background:#EDEFF2;border-radius:3.5mm;overflow:hidden;">
      <div style="width:${pct}%;height:7mm;background:${NAVY};border-radius:3.5mm;"></div>
    </div>
    <table style="width:100%;margin-top:1mm;">
      <tr>
        <td style="padding:0;font-size:6.5pt;color:${GREY};">Facturé&nbsp;: ${fmt(data.totalCertifiedHt)} HT</td>
        <td style="padding:0;text-align:right;font-size:6.5pt;color:${GREY};">Reste à réaliser&nbsp;: ${fmt(data.totalResteARealiser)} HT</td>
      </tr>
    </table>
  </div>

  <div style="font-size:9pt;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${NAVY};margin-bottom:2.5mm;padding-bottom:1.5mm;border-bottom:1px solid #E6E6E6;">
    Détail par devis
  </div>
  <table style="width:100%;font-size:7pt;margin-bottom:5mm;">
    <thead>
      <tr>
        ${th("Devis", "left")}
        ${th("Description", "left")}
        ${th("Statut", "center")}
        ${th("Montant HT", "right")}
        ${th("Facturé HT", "right")}
        ${th("Reste HT", "right")}
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr style="border-top:2px solid ${NAVY};background:#E8ECF1;">
        <td colspan="3" style="font-weight:800;font-size:7pt;color:${NAVY};text-transform:uppercase;padding:6px;">Total</td>
        <td style="text-align:right;font-weight:800;font-size:7pt;color:${NAVY};padding:6px;">${fmt(data.totalContractedHt)}</td>
        <td style="text-align:right;font-weight:800;font-size:7pt;color:${NAVY};padding:6px;">${fmt(data.totalCertifiedHt)}</td>
        <td style="text-align:right;font-weight:800;font-size:7pt;color:${GOLD};padding:6px;">${fmt(data.totalResteARealiser)}</td>
      </tr>
    </tfoot>
  </table>

  <div style="font-size:6.5pt;color:${GREY};border-top:1px solid #E6E6E6;padding-top:2mm;">
    Montants ajustés des avenants approuvés (plus-values / moins-values). Document d'information établi par
    l'architecte à la date indiquée&nbsp;; les montants «&nbsp;Facturé&nbsp;» correspondent aux factures
    enregistrées à ce jour, ainsi qu'aux acomptes certifiés non encore récupérés.
  </div>
</body>
</html>`;
}

export async function generateProjectOverviewPdf(projectId: number): Promise<Buffer> {
  const summaryResult = await getProjectFinancialSummary(projectId);
  if (!summaryResult.success) {
    throw new ProjectOverviewNotFoundError(`Project ${projectId} not found`);
  }
  const summaryData = summaryResult.data as FinancialSummaryPayload;
  const project = await storage.getProject(projectId);
  const clientName = project?.clientName ?? null;

  const data = buildProjectOverviewData(summaryData, clientName);
  const logo = await loadLogoAsBase64("company_logo");
  const html = buildProjectOverviewHtml(data, logo);

  const projectCode = (data.projectCode || "PROJ").replace(/[^a-zA-Z0-9]/g, "");
  const dateStr = new Date().toISOString().split("T")[0].replace(/-/g, "");
  return convertHtmlToPdf(html, `SITUATION-${projectCode}-${dateStr}`);
}

export class ProjectOverviewNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
}

/**
 * Combined client package: the stored invoice PDF followed by a freshly
 * generated project overview as the final page(s). Generated on demand and
 * streamed — never cached, so the overview always reflects current figures.
 */
export async function generateInvoicePackagePdf(
  invoiceId: number,
): Promise<{ pdfBuffer: Buffer; invoiceNumber: string }> {
  const invoice = await storage.getInvoice(invoiceId);
  if (!invoice) throw new ProjectOverviewNotFoundError(`Invoice ${invoiceId} not found`);
  if (!invoice.pdfPath) {
    throw new ProjectOverviewNotFoundError(`Invoice ${invoiceId} has no PDF attached`);
  }

  const [invoiceBuf, overviewBuf] = await Promise.all([
    getDocumentBuffer(invoice.pdfPath),
    generateProjectOverviewPdf(invoice.projectId),
  ]);

  const merged = await PDFDocument.create();
  const invoiceDoc = await PDFDocument.load(invoiceBuf, { ignoreEncryption: true });
  const overviewDoc = await PDFDocument.load(overviewBuf, { ignoreEncryption: true });

  for (const p of await merged.copyPages(invoiceDoc, invoiceDoc.getPageIndices())) merged.addPage(p);
  for (const p of await merged.copyPages(overviewDoc, overviewDoc.getPageIndices())) merged.addPage(p);

  const pdfBuffer = Buffer.from(await merged.save());
  return { pdfBuffer, invoiceNumber: String(invoice.invoiceNumber) };
}
