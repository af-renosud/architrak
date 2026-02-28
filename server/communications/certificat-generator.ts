import { storage } from "../storage";
import { uploadDocument } from "../storage/object-storage";
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
  companyLogoUrl: string | null;
  architectsLogoUrl: string | null;
}

function formatCurrency(value: string | number): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(num);
}

function formatCurrencyNoSymbol(value: string | number): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  return "€ " + new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
}

function formatDate(date: string | Date | null): string {
  if (!date) return new Date().toLocaleDateString("en-GB");
  return new Date(date).toLocaleDateString("en-GB");
}

function numberToFrenchWords(n: number): string {
  if (n === 0) return "ZÉRO EUROS";

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

export async function generateCertificatPdf(certificatId: number): Promise<{ storageKey: string; htmlContent: string }> {
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

  let companyLogoUrl: string | null = null;
  let architectsLogoUrl: string | null = null;
  try {
    const companyAsset = await storage.getTemplateAssetByType("company_logo");
    if (companyAsset) companyLogoUrl = `/api/template-assets/company_logo/file`;
    const archAsset = await storage.getTemplateAssetByType("architects_order_logo");
    if (archAsset) architectsLogoUrl = `/api/template-assets/architects_order_logo/file`;
  } catch {}

  const html = buildCertificatHtml({ certificat, project, contractor, devisDetails, companyLogoUrl, architectsLogoUrl });

  const buffer = Buffer.from(html, "utf-8");
  const fileName = `Certificat_${certificat.certificateRef.replace(/[^a-zA-Z0-9]/g, "_")}.html`;
  const storageKey = await uploadDocument(project.id, fileName, buffer, "text/html");

  return { storageKey, htmlContent: html };
}

function buildCertificatHtml(data: CertificatPdfData): string {
  const { certificat, project, contractor, devisDetails, companyLogoUrl, architectsLogoUrl } = data;

  const netTtc = parseFloat(certificat.netToPayTtc);
  const netHt = parseFloat(certificat.netToPayHt);
  const tvaAmount = parseFloat(certificat.tvaAmount);
  const amountInWords = numberToFrenchWords(netTtc);

  const primaryLot = devisDetails.find(d => d.lot)?.lot;
  const lotLabel = primaryLot ? `LOT ${primaryLot.lotNumber}` : "LOT";
  const compositeRef = `${lotLabel} ${certificat.certificateRef}`;

  const worksRows = devisDetails.map(dd => {
    const lotNum = dd.lot ? `LOT ${dd.lot.lotNumber}` : "—";
    const worksDesc = dd.devis.descriptionUk || dd.devis.descriptionFr || "—";
    return `<tr>
      <td>${worksDesc}</td>
      <td>${contractor.name}</td>
      <td>${lotNum}</td>
      <td>${dd.devis.devisCode}</td>
    </tr>`;
  }).join("");

  const devisSummaryRows = devisDetails.map(dd => {
    const worksTtc = parseFloat(dd.devis.amountTtc);
    const invoicedTtc = dd.invoicedTtc;
    const remaining = worksTtc - invoicedTtc;
    return `<div class="devis-summary-block">
      <div class="devis-summary-header">
        <span class="devis-desc">${dd.devis.descriptionFr || dd.devis.descriptionUk || "—"}</span>
        <span class="devis-ref">${dd.devis.devisCode}</span>
      </div>
      <table class="summary-table">
        <tr><td>WORKS VALUE TTC</td><td class="amount">${formatCurrencyNoSymbol(worksTtc)}</td></tr>
        <tr><td>INVOICED TO DATE</td><td class="amount">${formatCurrencyNoSymbol(invoicedTtc)}</td></tr>
        <tr class="remaining"><td>REMAINING</td><td class="amount">${formatCurrencyNoSymbol(remaining)}</td></tr>
      </table>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${compositeRef} — Certificat de Paiement</title>
<style>
  @page { size: A4; margin: 20mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; font-size: 11px; line-height: 1.5; padding: 30px 40px; }

  .top-ref { text-align: right; font-size: 12px; color: #0B2545; margin-bottom: 20px; letter-spacing: 0.5px; }
  .top-ref strong { font-weight: 800; }

  .main-title { text-align: center; font-size: 16px; font-weight: 800; color: #0B2545; text-transform: uppercase; letter-spacing: 3px; margin-bottom: 4px; border-top: 3px solid #0B2545; border-bottom: 3px solid #0B2545; padding: 10px 0; }
  .sub-title { text-align: center; font-size: 10px; font-weight: 700; color: #0B2545; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 20px; }

  .header-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
  .header-logo img { max-height: 60px; max-width: 200px; }
  .header-date { text-align: right; font-size: 12px; }
  .header-date strong { color: #0B2545; }

  .parties { margin: 16px 0; }
  .party { margin-bottom: 12px; }
  .party-label { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; color: #0B2545; margin-bottom: 3px; }
  .party-value { font-size: 11px; }
  .party-value strong { font-weight: 700; }

  .works-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  .works-table th { background: #0B2545; color: white; padding: 7px 10px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; }
  .works-table td { padding: 7px 10px; border-bottom: 1px solid #e5e5e5; font-size: 11px; }

  .cert-ref-callout { text-align: center; margin: 20px 0; padding: 10px; border: 2px solid #0B2545; }
  .cert-ref-callout span { font-size: 12px; font-weight: 400; color: #0B2545; text-transform: uppercase; letter-spacing: 1px; }
  .cert-ref-callout strong { font-size: 16px; font-weight: 900; color: #0B2545; }

  .amounts-section { margin: 16px 0; }
  .amount-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #eee; }
  .amount-row:last-child { border-bottom: none; }
  .amount-label { font-size: 11px; flex: 1; }
  .amount-code { font-size: 10px; font-weight: 700; color: #0B2545; width: 40px; text-align: center; }
  .amount-value { font-size: 13px; font-weight: 700; text-align: right; width: 140px; font-family: 'Courier New', monospace; }

  .devis-summary-section { margin: 20px 0; }
  .devis-summary-section h3 { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; color: #0B2545; margin-bottom: 8px; }
  .devis-summary-block { border: 1px solid #e5e5e5; border-radius: 4px; padding: 10px; margin-bottom: 10px; }
  .devis-summary-header { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .devis-desc { font-size: 11px; font-weight: 700; }
  .devis-ref { font-size: 10px; color: #666; }
  .summary-table { width: 100%; border-collapse: collapse; }
  .summary-table td { padding: 3px 0; font-size: 10px; }
  .summary-table td.amount { text-align: right; font-family: 'Courier New', monospace; font-weight: 600; }
  .summary-table tr.remaining td { font-weight: 700; border-top: 1px solid #ccc; padding-top: 4px; }

  .warning-note { font-size: 8px; color: #888; margin-top: 6px; font-style: italic; }
  .warning-note::before { content: "⚠ "; }

  .payment-section { margin: 20px 0; padding: 16px; background: #f8f9fa; border-radius: 4px; }
  .payment-propose { font-size: 11px; margin-bottom: 8px; }
  .payment-propose strong { color: #0B2545; }
  .payment-amount-words { font-size: 12px; font-weight: 800; text-align: center; text-transform: uppercase; color: #0B2545; margin: 10px 0; letter-spacing: 1px; }
  .payment-attention { font-size: 11px; font-weight: 800; text-transform: uppercase; color: #c0392b; text-align: center; margin: 10px 0; letter-spacing: 1px; }
  .payment-instructions { font-size: 9px; color: #555; line-height: 1.6; margin-top: 10px; text-align: justify; }

  .footer { margin-top: 30px; border-top: 1px solid #ccc; padding-top: 12px; display: flex; justify-content: space-between; align-items: flex-end; }
  .footer-left { font-size: 9px; color: #666; }
  .footer-left img { max-height: 40px; max-width: 120px; margin-bottom: 4px; display: block; }
  .footer-right { font-size: 14px; font-weight: 900; color: #0B2545; text-align: right; letter-spacing: 1px; }
</style>
</head>
<body>

  <div class="top-ref">
    STATEMENT OF ACCOUNT REFERENCE [CERTIFICAT] <strong>${certificat.certificateRef}</strong>
  </div>

  <div class="main-title">CERTIFICAT DE PAIEMENT: PAYMENT AUTHORISATION</div>

  <div class="header-row">
    <div class="header-logo">
      ${companyLogoUrl ? `<img src="${companyLogoUrl}" alt="Company Logo" />` : ""}
    </div>
    <div class="header-date">
      <strong>DATE</strong>&nbsp;&nbsp;&nbsp;&nbsp;${formatDate(certificat.dateIssued)}
    </div>
  </div>

  <div class="parties">
    <div class="party">
      <div class="party-label">MAÎTRE D'ŒUVRE :</div>
      <div class="party-value">
        <strong>SAS ARCHITECTS-FRANCE</strong><br/>
        2 ROUTE D'AIGUES-VIVES, 34480, CABREROLLES. SIRET: 953 443 918 00016
      </div>
    </div>
    <div class="party">
      <div class="party-label">MAÎTRE D'OUVRAGE:</div>
      <div class="party-value">
        <strong>${project.clientName}</strong> (${project.code})${project.clientAddress ? `<br/>${project.clientAddress}` : ""}
      </div>
    </div>
    <div class="party">
      <div class="party-label">CONTRACTOR:</div>
      <div class="party-value">
        <strong>${contractor.name}</strong>${contractor.address ? `, ${contractor.address}` : ""}${contractor.siret ? `, SIRET : ${contractor.siret}` : ""}
      </div>
    </div>
  </div>

  <table class="works-table">
    <thead>
      <tr>
        <th>WORKS DESCRIPTION UK</th>
        <th>CONTRACTOR</th>
        <th>LOT</th>
        <th>DEVIS NO</th>
      </tr>
    </thead>
    <tbody>
      ${worksRows || `<tr><td colspan="4" style="color:#999;font-style:italic;">No devis linked</td></tr>`}
    </tbody>
  </table>

  <div class="cert-ref-callout">
    <span>THIS CERTIFICATE OF PAYMENT REFERENCE IS</span>&nbsp;&nbsp;&nbsp;<strong>${certificat.certificateRef}</strong>
  </div>

  <div class="amounts-section">
    <div class="amount-row">
      <div class="amount-label">THE CONTRACTOR IS REQUESTING THIS AMOUNT [NET TAX]</div>
      <div class="amount-code">HT</div>
      <div class="amount-value">${formatCurrencyNoSymbol(netHt)}</div>
    </div>
    <div class="amount-row">
      <div class="amount-label">THE CONTRACTOR IS REQUESTING THIS AMOUNT [INC TAX]</div>
      <div class="amount-code">TTC</div>
      <div class="amount-value">${formatCurrencyNoSymbol(netTtc)}</div>
    </div>
    <div class="amount-row">
      <div class="amount-label">THE SALES TAX [TVA] IN THIS PAYMENT IS</div>
      <div class="amount-code">TVA</div>
      <div class="amount-value">${formatCurrencyNoSymbol(tvaAmount)}</div>
    </div>
  </div>

  ${devisDetails.length > 0 ? `
  <div class="devis-summary-section">
    <h3>SUMMARY BY DEVIS CODE</h3>
    ${devisSummaryRows}
    <div class="warning-note">
      NOTE: INCLUDES ALL INVOICES INCLUDING THIS ONE. MAY NOT REFLECT ACTUAL MONIES RECEIVED.
    </div>
  </div>
  ` : ""}

  <div class="payment-section">
    <div class="payment-propose">
      IN VIEW OF THE PROGRESS OF THE WORK, <strong>SAS ARCHITECTS-FRANCE</strong> PROPOSES THAT THE CLIENT PAY THE SUM OF :
      <strong>${formatCurrencyNoSymbol(netTtc)}</strong>
    </div>
    <div class="payment-amount-words">
      IN WORDS: ${amountInWords}
    </div>
    <div class="payment-attention">
      THIS REQUIRES YOUR PAYMENT AND ATTENTION.
    </div>
    <div class="payment-instructions">
      PLEASE PAY THIS NOW USING THE BANK DETAILS PROVIDED IN THE EMAIL. IF YOU NEED TO PAY FROM DIFFERENT ACCOUNTS ENSURE THAT THE TOTAL IS THE EXACT
      AMOUNT AS SHOWN. PLEASE MAKE SURE THAT YOUR BANK DOES NOT DEDUCT A TRANSFER FEE FROM THE RECIPIENT. ALL TRANSACTION FEES REMAIN YOURS. THE
      CONTRACTOR MUST RECEIVE THE EQUIVALENT EUROS IN FULL, EXACTLY AS INDICATED.
    </div>
  </div>

  <div class="footer">
    <div class="footer-left">
      ${architectsLogoUrl ? `<img src="${architectsLogoUrl}" alt="Order of Architects" />` : ""}
      ARCHITECTS-FRANCE: REGISTRATION WITH THE ORDER OF ARCHITECTS OCCITANIE S24348
    </div>
    <div class="footer-right">
      ${compositeRef}
    </div>
  </div>

</body>
</html>`;
}

export function buildCertificatEmailBody(data: { certificat: Certificat; project: Project; contractor: Contractor }): string {
  const { certificat, project, contractor } = data;
  return `Madame, Monsieur,

Veuillez trouver ci-joint le Certificat de Paiement n° ${certificat.certificateRef} relatif au projet "${project.name}" (${project.code}).

Ce certificat concerne les travaux réalisés par l'entreprise ${contractor.name}.

Montant net à payer TTC: ${formatCurrency(certificat.netToPayTtc)}

Nous vous remercions de bien vouloir procéder au règlement dans les meilleurs délais.

Cordialement,
SAS Architects-France`;
}
