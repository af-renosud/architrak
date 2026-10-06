import { storage } from "../storage";
import { buildCertificateInvoiceDescription, type CertificateInvoiceDescriptionInput } from "@shared/certificate-invoice-description";

/** Read-only. Never expand an unlinked legacy certificate to all contractor invoices. */
export async function getCertificateInvoiceDescription(certId: number) {
  const cert = await storage.getCertificat(certId);
  if (!cert) return null;
  const snapshot = cert.issuanceSnapshot as {
    sourceInvoiceIds?: number[];
    supplierDirectPayment?: {
      readiness?: { supplier?: { name?: string } };
      sources?: { invoices?: Array<{ invoiceId: number; invoiceNumber: string }> };
    };
  } | null;
  const contractor = await storage.getContractor(cert.contractorId);
  const sources = await storage.getCertificatSources(certId);
  const invoiceIds = new Set<number>();
  const devisIds = new Set<number>();
  for (const source of sources) {
    if (source.invoiceId != null) invoiceIds.add(source.invoiceId);
    if (source.situationId != null) {
      const situation = await storage.getSituation(source.situationId);
      if (situation) {
        devisIds.add(situation.devisId);
        if (situation.invoiceId != null) invoiceIds.add(situation.invoiceId);
      }
    }
  }
  // Sealed source identity is authoritative even if legacy links disappeared.
  const sealedIds = snapshot?.sourceInvoiceIds;
  if (Array.isArray(sealedIds)) {
    invoiceIds.clear();
    sealedIds.forEach(id => { if (Number.isSafeInteger(id) && id > 0) invoiceIds.add(id); });
  }
  // A no-invoice deposit is scoped exclusively to its quotation. Historical
  // render snapshots can include the contractor's other invoices for context;
  // those do not become documentary evidence for this deposit.
  if (cert.acompteDevisId != null) {
    invoiceIds.clear();
    devisIds.clear();
    devisIds.add(cert.acompteDevisId);
  }
  const invoiceNumbers: Array<string | null> = [];
  for (const id of Array.from(invoiceIds)) {
    const invoice = await storage.getInvoice(id);
    if (!invoice || invoice.projectId !== cert.projectId || invoice.contractorId !== cert.contractorId) {
      invoiceNumbers.push(null);
      continue;
    }
    devisIds.add(invoice.devisId);
    const frozen = snapshot?.supplierDirectPayment?.sources?.invoices?.find(i => i.invoiceId === id);
    invoiceNumbers.push(frozen?.invoiceNumber ?? invoice.invoiceNumber);
  }
  if (cert.acompteDevisId != null) devisIds.add(cert.acompteDevisId);
  if (!devisIds.size && cert.tvaEvidenceDevisId != null) devisIds.add(cert.tvaEvidenceDevisId);
  const quotations: CertificateInvoiceDescriptionInput["quotations"] = [];
  for (const id of Array.from(devisIds)) {
    const devis = await storage.getDevis(id);
    if (!devis || devis.projectId !== cert.projectId || devis.contractorId !== cert.contractorId) {
      quotations.push({ lotNumber: null, title: null });
      continue;
    }
    const lot = devis.lotId == null ? undefined : await storage.getLot(devis.lotId);
    quotations.push({
      lotNumber: lot?.projectId === cert.projectId ? lot.lotNumber : null,
      title: devis.descriptionUk?.trim() || devis.descriptionFr,
    });
  }
  return { description: buildCertificateInvoiceDescription({
    certificateRef: cert.certificateRef,
    contractorName: snapshot?.supplierDirectPayment?.readiness?.supplier?.name ?? contractor?.name ?? null,
    netToPayHt: cert.netToPayHt,
    quotations,
    invoiceNumbers,
    openingDeposit: cert.acompteDevisId != null && invoiceIds.size === 0,
  }) };
}
