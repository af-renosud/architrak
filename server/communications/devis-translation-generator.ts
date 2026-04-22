import { PDFDocument } from "pdf-lib";
import { storage } from "../storage";
import { uploadDocument, getDocumentBuffer } from "../storage/object-storage";
import { convertHtmlToPdf } from "../services/docraptor";
import { roundCurrency } from "@shared/financial-utils";
import type {
  Devis,
  DevisLineItem,
  Contractor,
  Project,
  DevisTranslationLine,
  DevisTranslationHeader,
} from "@shared/schema";

async function loadLogoAsBase64(assetType: string): Promise<string | null> {
  try {
    const asset = await storage.getTemplateAssetByType(assetType);
    if (!asset) return null;
    const buffer = await getDocumentBuffer(asset.storageKey);
    const mime = asset.mimeType || "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.warn(
      `[DevisTranslationPdf] Failed to load logo asset '${assetType}':`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function escapeHtml(input: string | null | undefined): string {
  if (input == null) return "";
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCurrency(value: string | number | null): string {
  if (value == null) return "—";
  const raw = typeof value === "string" ? parseFloat(value) : value;
  if (!Number.isFinite(raw)) return "—";
  const rounded = roundCurrency(raw);
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }).format(rounded);
}

function formatDate(value: string | Date | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB");
}

interface BuildHtmlInput {
  devis: Devis;
  project: Project;
  contractor: Contractor;
  lines: DevisLineItem[];
  header: DevisTranslationHeader;
  translatedLines: DevisTranslationLine[];
  includeExplanations: boolean;
  companyLogoBase64: string | null;
  approvedAt: Date | null;
  approvedByEmail: string | null;
}

function buildHtml(input: BuildHtmlInput): string {
  const { devis, project, contractor, lines, header, translatedLines, includeExplanations, companyLogoBase64, approvedAt, approvedByEmail } = input;
  const isApproved = !!approvedAt;

  const byLineNumber = new Map<number, DevisTranslationLine>();
  for (const t of translatedLines) byLineNumber.set(t.lineNumber, t);

  const colHeaders = includeExplanations
    ? `<th>#</th><th>French (original)</th><th>English (literal)</th><th>Plain English</th><th>Qty</th><th>Unit</th><th>Unit HT</th><th>Total HT</th>`
    : `<th>#</th><th>French (original)</th><th>English (literal)</th><th>Qty</th><th>Unit</th><th>Unit HT</th><th>Total HT</th>`;

  const rows = lines
    .map((li) => {
      const t = byLineNumber.get(li.lineNumber);
      const fr = escapeHtml(li.description);
      const en = escapeHtml(t?.translation || "");
      const expl = escapeHtml(t?.explanation || "");
      const explCell = includeExplanations ? `<td class="expl">${expl}</td>` : "";
      return `<tr>
        <td class="num">${li.lineNumber}</td>
        <td>${fr}</td>
        <td>${en}</td>
        ${explCell}
        <td class="num">${escapeHtml(li.quantity)}</td>
        <td class="num">${escapeHtml(li.unit)}</td>
        <td class="num">${formatCurrency(li.unitPriceHt)}</td>
        <td class="num">${formatCurrency(li.totalHt)}</td>
      </tr>`;
    })
    .join("");

  const headerSummary = escapeHtml(header.summary || "");
  const headerEn = escapeHtml(header.description || "");
  const headerExpl = includeExplanations ? escapeHtml(header.descriptionExplanation || "") : "";
  const headerFr = escapeHtml(devis.descriptionFr || "");

  const logoTag = companyLogoBase64
    ? `<img src="${companyLogoBase64}" alt="Logo" style="height:32px;" />`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Devis Translation — ${escapeHtml(devis.devisCode)}</title>
<style>
@page { size: A4 landscape; margin: 14mm; }
body { font-family: 'Inter', 'Helvetica', sans-serif; font-size: 8.5pt; color: #34312D; }
.header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0B2545; padding-bottom: 6mm; margin-bottom: 5mm; }
.title { font-size: 14pt; font-weight: 800; color: #0B2545; text-transform: uppercase; letter-spacing: 0.05em; }
.subtitle { font-size: 9pt; color: #7E7F83; margin-top: 2mm; }
.meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm 6mm; margin-bottom: 5mm; font-size: 8pt; }
.meta .k { color: #7E7F83; text-transform: uppercase; font-size: 7pt; letter-spacing: 0.05em; }
.meta .v { color: #0B2545; font-weight: 600; }
.summary { background: #F8F9FA; border-left: 3px solid #C1A27B; padding: 4mm; margin-bottom: 5mm; font-size: 9pt; }
.summary .lbl { font-size: 7pt; text-transform: uppercase; color: #7E7F83; letter-spacing: 0.08em; margin-bottom: 1mm; }
.summary p { margin: 1mm 0; }
.scope { margin-bottom: 5mm; }
.scope .lbl { font-size: 7pt; text-transform: uppercase; color: #7E7F83; letter-spacing: 0.08em; margin-bottom: 1mm; }
.scope .fr { color: #7E7F83; font-style: italic; margin-bottom: 1mm; }
.scope .en { color: #34312D; }
.scope .expl { color: #C1A27B; font-size: 8pt; margin-top: 1mm; }
table { width: 100%; border-collapse: collapse; }
thead th { background: #0B2545; color: #FFF; font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 5px 6px; text-align: left; }
tbody td { padding: 5px 6px; border-bottom: 1px solid #E6E6E6; vertical-align: top; }
tbody tr:nth-child(even) td { background: #FAFAFA; }
.num { text-align: right; white-space: nowrap; }
.expl { color: #6B5B3E; font-style: italic; font-size: 8pt; }
.footer { margin-top: 6mm; padding-top: 3mm; border-top: 1px solid #E6E6E6; font-size: 7pt; color: #7E7F83; }
.disclaimer { background: #FFF9F0; border: 1px solid #C1A27B; padding: 3mm; margin-top: 4mm; font-size: 7.5pt; color: #6B5B3E; border-radius: 2px; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">Devis Translation (FR → EN)</div>
      <div class="subtitle">${escapeHtml(devis.devisCode)} — ${escapeHtml(contractor.name)}</div>
    </div>
    ${logoTag}
  </div>

  <div class="meta">
    <div><div class="k">Project</div><div class="v">${escapeHtml(project.name)} (${escapeHtml(project.code)})</div></div>
    <div><div class="k">Contractor</div><div class="v">${escapeHtml(contractor.name)}</div></div>
    <div><div class="k">Devis №</div><div class="v">${escapeHtml(devis.devisNumber || devis.devisCode)}</div></div>
    <div><div class="k">Date</div><div class="v">${formatDate(devis.dateSent)}</div></div>
    <div><div class="k">Amount HT</div><div class="v">${formatCurrency(devis.amountHt)}</div></div>
    <div><div class="k">Amount TTC</div><div class="v">${formatCurrency(devis.amountTtc)}</div></div>
    <div><div class="k">Status</div><div class="v">${escapeHtml(devis.status)}</div></div>
  </div>

  ${headerSummary ? `<div class="summary"><div class="lbl">Document overview</div><p>${headerSummary}</p></div>` : ""}

  ${headerFr || headerEn ? `<div class="scope">
    <div class="lbl">Scope description</div>
    ${headerFr ? `<div class="fr">${headerFr}</div>` : ""}
    ${headerEn ? `<div class="en">${headerEn}</div>` : ""}
    ${headerExpl ? `<div class="expl">${headerExpl}</div>` : ""}
  </div>` : ""}

  <table>
    <thead><tr>${colHeaders}</tr></thead>
    <tbody>
      ${rows || `<tr><td colspan="${includeExplanations ? 8 : 7}" style="color:#7E7F83;font-style:italic;padding:6mm;text-align:center;">No line items extracted from this devis.</td></tr>`}
    </tbody>
  </table>

  ${isApproved ? `<div class="disclaimer" style="background:#F1F7F1;border-color:#7BAE7E;color:#2F5D31;">
    <strong>Reviewed &amp; approved:</strong> This English translation was reviewed and approved${approvedByEmail ? ` by ${escapeHtml(approvedByEmail)}` : ""} on ${formatDate(approvedAt)}.
    The original French document remains the legally binding contractual reference; all amounts, quantities and units are reproduced verbatim from the source.
  </div>` : `<div class="disclaimer">
    <strong>Note:</strong> This is an unofficial translation generated automatically from the original French devis for reference only.
    The original French document remains the legally binding contractual reference. All amounts, quantities and units are reproduced verbatim from the source.
  </div>`}

  <div class="footer">
    Generated by ArchiTrak — Renosud. Original document: ${escapeHtml(devis.pdfFileName || "—")}
  </div>
</body>
</html>`;
}

export interface GeneratePdfOptions {
  includeExplanations?: boolean;
}

export async function generateDevisTranslationPdf(
  devisId: number,
  opts: GeneratePdfOptions = {},
): Promise<{ storageKey: string; pdfBuffer: Buffer }> {
  const devis = await storage.getDevis(devisId);
  if (!devis) throw new Error(`Devis ${devisId} not found`);

  const translation = await storage.getDevisTranslation(devisId);
  const ready = translation && (translation.status === "draft" || translation.status === "edited" || translation.status === "finalised");
  if (!translation || !ready) {
    throw new Error(`Translation for devis ${devisId} is not ready (status: ${translation?.status ?? "missing"})`);
  }

  const project = await storage.getProject(devis.projectId);
  if (!project) throw new Error(`Project ${devis.projectId} not found`);
  const contractor = await storage.getContractor(devis.contractorId);
  if (!contractor) throw new Error(`Contractor ${devis.contractorId} not found`);

  const lines = await storage.getDevisLineItems(devisId);
  const companyLogoBase64 = await loadLogoAsBase64("company_logo");

  const html = buildHtml({
    devis,
    project,
    contractor,
    lines,
    header: (translation.headerTranslated as DevisTranslationHeader) || {},
    translatedLines: (translation.lineTranslations as DevisTranslationLine[]) || [],
    includeExplanations: !!opts.includeExplanations,
    companyLogoBase64,
    approvedAt: translation.approvedAt ?? null,
    approvedByEmail: translation.approvedByEmail ?? null,
  });

  const docName = `DEVIS-TRANSLATION-${devis.devisCode}`;
  const pdfBuffer = await convertHtmlToPdf(html, docName);

  const fileName = `${docName}.pdf`;
  const storageKey = await uploadDocument(project.id, fileName, pdfBuffer, "application/pdf");

  if (!opts.includeExplanations) {
    await storage.updateDevisTranslation(devisId, {
      translatedPdfStorageKey: storageKey,
      combinedPdfStorageKey: null,
    });
  }

  return { storageKey, pdfBuffer };
}

export async function generateCombinedPdf(
  devisId: number,
  opts: GeneratePdfOptions = {},
): Promise<{ storageKey: string; pdfBuffer: Buffer }> {
  const devis = await storage.getDevis(devisId);
  if (!devis) throw new Error(`Devis ${devisId} not found`);
  if (!devis.pdfStorageKey) throw new Error(`Devis ${devisId} has no original PDF`);

  const translation = await storage.getDevisTranslation(devisId);
  if (!translation) throw new Error(`No translation for devis ${devisId}`);

  let translatedBufPromise: Promise<Buffer>;
  if (opts.includeExplanations) {
    translatedBufPromise = generateDevisTranslationPdf(devisId, { includeExplanations: true }).then((g) => g.pdfBuffer);
  } else if (translation.translatedPdfStorageKey) {
    translatedBufPromise = getDocumentBuffer(translation.translatedPdfStorageKey);
  } else {
    translatedBufPromise = generateDevisTranslationPdf(devisId).then((g) => g.pdfBuffer);
  }

  const [originalBuf, translatedBuf] = await Promise.all([
    getDocumentBuffer(devis.pdfStorageKey),
    translatedBufPromise,
  ]);

  const merged = await PDFDocument.create();
  const originalDoc = await PDFDocument.load(originalBuf, { ignoreEncryption: true });
  const translatedDoc = await PDFDocument.load(translatedBuf, { ignoreEncryption: true });

  // Combined PDF leads with the English translation so the English-speaking
  // client sees the readable version first; the original French follows as
  // the legally binding reference.
  const translatedPages = await merged.copyPages(translatedDoc, translatedDoc.getPageIndices());
  for (const p of translatedPages) merged.addPage(p);
  const originalPages = await merged.copyPages(originalDoc, originalDoc.getPageIndices());
  for (const p of originalPages) merged.addPage(p);

  const mergedBytes = await merged.save();
  const pdfBuffer = Buffer.from(mergedBytes);

  const fileName = `DEVIS-${devis.devisCode}-EN-FR.pdf`;
  const storageKey = await uploadDocument(devis.projectId, fileName, pdfBuffer, "application/pdf");

  if (!opts.includeExplanations) {
    await storage.updateDevisTranslation(devisId, { combinedPdfStorageKey: storageKey });
  }

  return { storageKey, pdfBuffer };
}
