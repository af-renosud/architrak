import { storage } from "../storage";
import { uploadDocument, getDocumentBuffer } from "../storage/object-storage";
import { convertHtmlToPdf } from "../services/docraptor";
import type { Certificat, Project, Contractor, Devis, Lot, Invoice } from "@shared/schema";

interface DevisWithDetails {
  devis: Devis;
  lot: Lot | null;
  invoices: Invoice[];
  invoicedTtc: number;
}

interface CertificatPdfData {
  certificat: Certificat;
  project: Project;
  contractor: Contractor;
  devisDetails: DevisWithDetails[];
  companyLogoBase64: string | null;
  architectsLogoBase64: string | null;
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
      const lot = d.lotId ? await storage.getLot(d.lotId) : null;
      const invoices = await storage.getInvoicesByDevis(d.id);
      const invoicedTtc = invoices.reduce((sum, inv) => sum + parseFloat(inv.amountTtc), 0);
      return { devis: d, lot, invoices, invoicedTtc };
    })
  );

  const [companyLogoBase64, architectsLogoBase64] = await Promise.all([
    loadLogoAsBase64("company_logo"),
    loadLogoAsBase64("architects_order_logo"),
  ]);

  const html = buildCertificatHtml({ certificat, project, contractor, devisDetails, companyLogoBase64, architectsLogoBase64 });

  const dateStr = new Date().toISOString().split("T")[0].replace(/-/g, "");
  const projectCode = (project.code || "PROJ").replace(/[^a-zA-Z0-9]/g, "");
  const docName = `CERT-${projectCode}-${certificat.certificateRef}-${dateStr}`;
  const fileName = `${docName}.pdf`;

  const pdfBuffer = await convertHtmlToPdf(html, docName);
  const storageKey = await uploadDocument(project.id, fileName, pdfBuffer, "application/pdf");

  return { storageKey, pdfBuffer };
}

function buildCertificatHtml(data: CertificatPdfData): string {
  const { certificat, project, contractor, devisDetails, companyLogoBase64, architectsLogoBase64 } = data;

  const netTtc = parseFloat(certificat.netToPayTtc);
  const netHt = parseFloat(certificat.netToPayHt);
  const tvaAmount = parseFloat(certificat.tvaAmount);
  const amountInWords = numberToFrenchWords(netTtc);

  const primaryLot = devisDetails.find(d => d.lot)?.lot;
  const lotLabel = primaryLot ? `LOT ${primaryLot.lotNumber}` : "LOT";
  const compositeRef = `${lotLabel} ${certificat.certificateRef}`;
  const dateIssued = formatDateFr(certificat.dateIssued);

  const worksRows = devisDetails.map((dd, i) => {
    const lotNum = dd.lot ? `LOT ${dd.lot.lotNumber}` : "\u2014";
    const worksDesc = dd.devis.descriptionUk || dd.devis.descriptionFr || "\u2014";
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
    background: linear-gradient(135deg, #0B2545 0%, #143661 55%, #1a4a7a 100%);
    color: #FFFFFF;
    padding: 14px 24px;
    margin: -2mm 0 0 0;
  }
  .cover-header-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  .cover-header-top img {
    height: 32px;
    width: auto;
  }
  .cover-header-top .firm-name {
    font-size: 8pt;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    opacity: 0.7;
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
  }
  .cover-header .doc-ref {
    font-size: 10pt;
    font-weight: 400;
    opacity: 0.85;
    text-align: right;
  }
  .cover-header .doc-ref strong {
    font-size: 14pt;
    font-weight: 800;
    display: block;
    opacity: 1;
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
