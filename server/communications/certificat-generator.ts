import { storage } from "../storage";
import { uploadDocument } from "../storage/object-storage";
import type { Certificat, Project, Contractor } from "@shared/schema";

interface CertificatPdfData {
  certificat: Certificat;
  project: Project;
  contractor: Contractor;
}

function formatCurrency(value: string | number): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(num);
}

function formatDate(date: string | Date | null): string {
  if (!date) return new Date().toLocaleDateString("fr-FR");
  return new Date(date).toLocaleDateString("fr-FR");
}

export async function generateCertificatPdf(certificatId: number): Promise<{ storageKey: string; htmlContent: string }> {
  const certificat = await storage.getCertificat(certificatId);
  if (!certificat) throw new Error(`Certificat ${certificatId} not found`);

  const project = await storage.getProject(certificat.projectId);
  if (!project) throw new Error(`Project ${certificat.projectId} not found`);

  const contractor = await storage.getContractor(certificat.contractorId);
  if (!contractor) throw new Error(`Contractor ${certificat.contractorId} not found`);

  const html = buildCertificatHtml({ certificat, project, contractor });

  const buffer = Buffer.from(html, "utf-8");
  const fileName = `Certificat_${certificat.certificateRef.replace(/[^a-zA-Z0-9]/g, "_")}.html`;
  const storageKey = await uploadDocument(project.id, fileName, buffer, "text/html");

  return { storageKey, htmlContent: html };
}

function buildCertificatHtml(data: CertificatPdfData): string {
  const { certificat, project, contractor } = data;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Certificat de Paiement - ${certificat.certificateRef}</title>
<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 40px; color: #333; font-size: 12px; }
  .header { display: flex; justify-content: space-between; margin-bottom: 30px; border-bottom: 2px solid #0B2545; padding-bottom: 20px; }
  .header-left { }
  .header-right { text-align: right; }
  .company { font-size: 18px; font-weight: bold; color: #0B2545; }
  .title { font-size: 22px; font-weight: bold; color: #0B2545; text-align: center; margin: 30px 0; text-transform: uppercase; letter-spacing: 2px; }
  .section { margin: 20px 0; }
  .section-title { font-weight: bold; color: #0B2545; font-size: 13px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  .info-box { border: 1px solid #ddd; padding: 15px; border-radius: 4px; }
  .info-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
  .info-value { font-size: 13px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th { background: #0B2545; color: white; padding: 10px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 10px; border-bottom: 1px solid #eee; }
  .amount { text-align: right; font-family: 'Courier New', monospace; }
  .total-row { font-weight: bold; background: #f8f9fa; }
  .net-row { font-weight: bold; background: #0B2545; color: white; font-size: 14px; }
  .footer { margin-top: 40px; border-top: 1px solid #ddd; padding-top: 20px; font-size: 10px; color: #666; }
  .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 40px; }
  .signature-box { border-top: 1px solid #333; padding-top: 10px; text-align: center; font-size: 11px; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="company">SAS Architects-France</div>
      <div>Architecture &amp; Maîtrise d'Oeuvre</div>
    </div>
    <div class="header-right">
      <div><strong>Date:</strong> ${formatDate(certificat.dateIssued)}</div>
      <div><strong>Ref:</strong> ${certificat.certificateRef}</div>
    </div>
  </div>

  <div class="title">Certificat de Paiement</div>

  <div class="info-grid">
    <div class="info-box">
      <div class="info-label">Maître d'Ouvrage (Client)</div>
      <div class="info-value"><strong>${project.clientName}</strong></div>
      <div class="info-value">${project.clientAddress || ""}</div>
    </div>
    <div class="info-box">
      <div class="info-label">Entreprise (Contractor)</div>
      <div class="info-value"><strong>${contractor.name}</strong></div>
      <div class="info-value">${contractor.address || ""}</div>
      ${contractor.siret ? `<div class="info-value">SIRET: ${contractor.siret}</div>` : ""}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Project</div>
    <div class="info-value"><strong>${project.name}</strong> (${project.code})</div>
    ${project.siteAddress ? `<div class="info-value">${project.siteAddress}</div>` : ""}
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th class="amount">Montant</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Montant total des travaux HT</td>
        <td class="amount">${formatCurrency(certificat.totalWorksHt)}</td>
      </tr>
      <tr>
        <td>Ajustements PV/MV</td>
        <td class="amount">${formatCurrency(certificat.pvMvAdjustment || "0")}</td>
      </tr>
      <tr>
        <td>Paiements précédents</td>
        <td class="amount">- ${formatCurrency(certificat.previousPayments || "0")}</td>
      </tr>
      <tr>
        <td>Retenue de Garantie</td>
        <td class="amount">- ${formatCurrency(certificat.retenueGarantie || "0")}</td>
      </tr>
      <tr class="total-row">
        <td>Net à payer HT</td>
        <td class="amount">${formatCurrency(certificat.netToPayHt)}</td>
      </tr>
      <tr>
        <td>TVA (${project.tvaRate}%)</td>
        <td class="amount">${formatCurrency(certificat.tvaAmount)}</td>
      </tr>
      <tr class="net-row">
        <td>Net à payer TTC</td>
        <td class="amount">${formatCurrency(certificat.netToPayTtc)}</td>
      </tr>
    </tbody>
  </table>

  ${certificat.notes ? `<div class="section"><div class="section-title">Notes</div><p>${certificat.notes}</p></div>` : ""}

  <div class="signatures">
    <div class="signature-box">L'Architecte<br/><br/><br/>SAS Architects-France</div>
    <div class="signature-box">Le Maître d'Ouvrage<br/><br/><br/>${project.clientName}</div>
  </div>

  <div class="footer">
    <p>Ce certificat de paiement est émis conformément aux dispositions du marché de travaux privé.</p>
    <p>Document généré par ArchiTrak — ${new Date().toLocaleDateString("fr-FR")}</p>
  </div>
</body>
</html>`;
}

export function buildCertificatEmailBody(data: CertificatPdfData): string {
  const { certificat, project, contractor } = data;
  return `Madame, Monsieur,

Veuillez trouver ci-joint le Certificat de Paiement n° ${certificat.certificateRef} relatif au projet "${project.name}" (${project.code}).

Ce certificat concerne les travaux réalisés par l'entreprise ${contractor.name}.

Montant net à payer TTC: ${formatCurrency(certificat.netToPayTtc)}

Nous vous remercions de bien vouloir procéder au règlement dans les meilleurs délais.

Cordialement,
SAS Architects-France`;
}
