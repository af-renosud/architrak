import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { certificatSources, certificats, devis, invoices, projects, type Certificat, type Invoice } from "@shared/schema";
import { invoiceRequestConflict } from "@shared/invoice-request-guard";

export class LateInvoiceLinkError extends Error {}
const cents = (value: string) => Math.round(Number(value) * 100);

/** Linking is documentary, not a financial edit or payment confirmation. */
export function lateInvoiceCandidateReason(invoice: Invoice, cert: Certificat, claimed: boolean, occupied: boolean): string | null {
  if (cert.projectId !== invoice.projectId || cert.contractorId !== invoice.contractorId) return "Different project or contractor.";
  if (claimed) return "This invoice is already linked to an active certificate.";
  if (invoice.status !== "approved") return "Approve the invoice before linking it.";
  if (invoiceRequestConflict(invoice)) return "Resolve the invoice's amount-request conflict first.";
  if (!cert.pdfStorageKey || !["ready", "issued", "sent", "paid"].includes(cert.status)) return "Only an issued, non-superseded certificate can be linked.";
  if (cert.certificateTrack !== "contractor_works") return "Supplier-direct certificates already have fixed invoice sources.";
  if (occupied) return "This certificate already covers another invoice or situation; review its existing scope first.";
  const pinnedDevis = cert.acompteDevisId ?? cert.tvaEvidenceDevisId;
  if (pinnedDevis != null && pinnedDevis !== invoice.devisId) return "This certificate refers to a different quotation.";
  if (cents(invoice.amountHt) <= 0 || cents(invoice.amountHt) !== cents(cert.netToPayHt) ||
      cents(invoice.amountTtc) !== cents(cert.netToPayTtc)) {
    return "Invoice HT/TTC do not match this certificate's payable HT/TTC. Review retention, deductions or scope; no amounts will be changed.";
  }
  return null;
}

export async function existingCertificateInvoiceLink(invoiceId: number, actor: string,
  input?: { certificatId: number; expectedVersion: string; reason: string; confirmed: true }) {
  return db.transaction(async tx => {
    const [identity] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!identity) throw new LateInvoiceLinkError("Invoice not found.");
    const [project] = await tx.select().from(projects).where(eq(projects.id, identity.projectId)).for("share");
    if (!project || project.archivedAt) throw new LateInvoiceLinkError("This project is archived or unavailable.");
    // Same lock as certificate creation and sealing: no invoice can be claimed
    // twice while another certificate is concurrently being created.
    await tx.execute(sql`select pg_advisory_xact_lock(${identity.projectId}, ${identity.contractorId})`);
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!invoice || invoice.projectId !== identity.projectId || invoice.contractorId !== identity.contractorId)
      throw new LateInvoiceLinkError("Invoice changed. Reload the comparison.");
    const [quotation] = await tx.select().from(devis).where(eq(devis.id, invoice.devisId)).for("share");
    if (!quotation || quotation.projectId !== invoice.projectId || quotation.contractorId !== invoice.contractorId)
      throw new LateInvoiceLinkError("Invoice quotation identity is inconsistent.");
    const certificates = await tx.select().from(certificats).where(and(
      eq(certificats.projectId, invoice.projectId), eq(certificats.contractorId, invoice.contractorId),
    )).orderBy(certificats.id).for("update");
    const ids = certificates.map(c => c.id);
    const sources = ids.length ? await tx.select().from(certificatSources)
      .where(inArray(certificatSources.certificatId, ids)).orderBy(certificatSources.id) : [];
    const claimed = sources.some(s => s.invoiceId === invoiceId &&
      certificates.some(c => c.id === s.certificatId && c.status !== "superseded"));
    const expectedVersion = createHash("sha256").update(JSON.stringify({ invoice, quotation, certificates, sources })).digest("hex");
    const candidates = certificates.filter(c => c.status !== "superseded").map(c => ({
      id: c.id, certificateRef: c.certificateRef, status: c.status, dateIssued: c.dateIssued,
      netToPayHt: c.netToPayHt, netToPayTtc: c.netToPayTtc,
      reason: lateInvoiceCandidateReason(invoice, c, claimed, sources.some(s => s.certificatId === c.id)),
    }));
    if (!input) return { invoice: { id: invoice.id, invoiceNumber: invoice.invoiceNumber,
      amountHt: invoice.amountHt, amountTtc: invoice.amountTtc, devisId: invoice.devisId }, candidates, expectedVersion };
    if (!input.confirmed || input.reason.trim().length < 10)
      throw new LateInvoiceLinkError("Confirm the documentary match and record its context.");
    const cert = certificates.find(c => c.id === input.certificatId);
    // A replay of the exact confirmation returns success, never another claim.
    const prior = sources.find(s => s.certificatId === cert?.id && s.invoiceId === invoiceId)?.lateAssociation;
    if (prior && cert?.status !== "superseded" && prior.actor === actor && prior.reason === input.reason.trim())
      return { linked: true, certificatId: cert!.id, certificateRef: cert!.certificateRef };
    if (expectedVersion !== input.expectedVersion)
      throw new LateInvoiceLinkError("Invoice or certificate changed. Reload and review the latest comparison.");
    const candidate = candidates.find(c => c.id === input.certificatId);
    if (!cert || !candidate) throw new LateInvoiceLinkError("Select a certificate from this project and contractor.");
    if (candidate.reason) throw new LateInvoiceLinkError(candidate.reason);
    await tx.insert(certificatSources).values({
      certificatId: cert.id, invoiceId,
      lateAssociation: { reason: input.reason.trim(), actor, linkedAt: new Date().toISOString(),
        invoiceNumber: invoice.invoiceNumber, amountHt: invoice.amountHt, amountTtc: invoice.amountTtc,
        devisId: invoice.devisId, certificateRef: cert.certificateRef },
    });
    // Deliberately no certificate, invoice, commission, payment or PDF writes.
    return { linked: true, certificatId: cert.id, certificateRef: cert.certificateRef };
  });
}
