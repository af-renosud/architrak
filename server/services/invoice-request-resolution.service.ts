import { createHash } from "node:crypto";
import { and, eq, ne, sql, inArray } from "drizzle-orm";
import { db } from "../db";
import { invoices, projects, fees, feeEntries, certificats, certificatSources,
  certificatPayments, certificatArchitectInvoices, projectCommunications,
  invoiceAcompteApplications, invoiceRequestDecisions, devis, pennylanePushes, architectFeeInvoices } from "@shared/schema";
import { invoiceRequestEvidenceKey } from "../../shared/invoice-request-guard";
import { resolveOpeningDeposit } from "../../shared/invoice-deposit";
import { invoiceRequestAmounts } from "./invoice-request-amounts";
import type { ParsedDocument } from "../gmail/document-parser";
import { isReviewedMasseyDepositRelationship } from "./massey-deposit-recovery";

export class RequestResolutionError extends Error {}
const refuse = (message: string): never => { throw new RequestResolutionError(message); };
const money = (value: number) => value.toFixed(2);

export type RequestResolutionInput = {
  expectedVersion: string; amountHt: number; amountTtc: number; reason: string;
  reconcileCertificateId?: number; externalInvoiceUnsent?: boolean;
};

/** The same locked read powers preview and commit; no optimistic dependency checks. */
export async function resolveInvoiceRequest(id: number, actor: string, input?: RequestResolutionInput) {
  return db.transaction(async tx => {
    const [identity] = await tx.select().from(invoices).where(eq(invoices.id, id));
    if (!identity) return refuse("Invoice not found.");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${identity.projectId}, ${identity.contractorId})`);
    const [project] = await tx.select().from(projects).where(eq(projects.id, identity.projectId)).for("update");
    if (!project || project.status === "archived" || project.archivedAt) return refuse("Archived or missing project.");
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
    if (!invoice || invoice.projectId !== identity.projectId || invoice.contractorId !== identity.contractorId) return refuse("Invoice changed. Reload.");
    if (!["draft", "pending", "approved"].includes(invoice.status) || invoice.datePaid) return refuse("Only unpaid draft, pending or approved invoices can be corrected.");
    const [parent] = await tx.select().from(devis).where(eq(devis.id, invoice.devisId)).for("update");
    if (!parent) return refuse("Parent quotation not found.");
    const entries = await tx.select().from(feeEntries).where(eq(feeEntries.invoiceId, id)).orderBy(feeEntries.id).for("update");
    const aggregates = entries.length ? await tx.select().from(fees).where(inArray(fees.id, entries.map(e => e.feeId))).orderBy(fees.id).for("update") : [];
    const certificates = await tx.select().from(certificats).where(and(eq(certificats.projectId, invoice.projectId),
      eq(certificats.contractorId, invoice.contractorId), ne(certificats.status, "superseded"))).orderBy(certificats.id).for("update");
    const allCertIds = certificates.map(c => c.id);
    const sources = allCertIds.length ? await tx.select().from(certificatSources).where(inArray(certificatSources.certificatId, allCertIds)) : [];
    const affected = certificates.filter(c =>
      sources.some(s => s.certificatId === c.id && s.invoiceId === id) ||
      isReviewedMasseyDepositRelationship(invoice, c) ||
      (c.acompteDevisId === invoice.devisId && parent.acompteInvoiceId === id));
    const ambiguous = certificates.filter(c => !affected.includes(c) &&
      !sources.some(s => s.certificatId === c.id) &&
      (c.acompteDevisId == null || c.acompteDevisId === invoice.devisId));
    const certIds = affected.map(c => c.id);
    const attachments = certIds.length ? await tx.select().from(certificatArchitectInvoices).where(inArray(certificatArchitectInvoices.certificatId, certIds)).for("update") : [];
    const applications = await tx.select().from(invoiceAcompteApplications).where(eq(invoiceAcompteApplications.invoiceId, id));
    const pushes = entries.length ? await tx.select().from(pennylanePushes).where(and(
      eq(pennylanePushes.projectId, invoice.projectId),
      inArray(pennylanePushes.kind, ["customer_invoice", "email_send"]),
      inArray(pennylanePushes.docId, entries.map(e => e.id)),
    )).for("update") : [];
    const feeEvidence = entries.length ? await tx.select().from(architectFeeInvoices)
      .where(inArray(architectFeeInvoices.feeEntryId, entries.map(e => e.id))).for("update") : [];
    const payments = certIds.length ? await tx.select().from(certificatPayments).where(inArray(certificatPayments.certificatId, certIds)) : [];
    const communications = certIds.length ? await tx.select().from(projectCommunications).where(inArray(projectCommunications.relatedCertificatId, certIds)) : [];
    const state = { invoice, parent, entries, aggregates, certificates: affected, ambiguousCertificateIds: ambiguous.map(c => c.id),
      sources: sources.filter(s => certIds.includes(s.certificatId)), attachments, applications, payments, communications, pushes, feeEvidence };
    const version = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    const deposit = resolveOpeningDeposit(invoice.aiExtractedData as any ?? {});
    const extracted = invoice.aiExtractedData as any;
    const depositRequest = !!deposit || (
      !(Number(extracted?.acomptePaidAmountTtc ?? 0) > 0) &&
      (extracted?.documentType === "acompte" || !!extracted?.openingDepositEvidenceText));
    const preview = { expectedVersion: version, amountHt: deposit?.amountHt ?? Number(invoice.amountHt),
      amountTtc: deposit?.amountTtc ?? Number(invoice.amountTtc),
      certificates: affected.map(c => ({ id: c.id, reference: c.certificateRef, amountHt: c.totalWorksHt, status: c.status })),
      hasExternalInvoice: attachments.some(a => a.storageKey), feeRates: entries.map(e => Number(e.feeRate)) };
    if (!input) return preview;
    if (version !== input.expectedVersion) return refuse("Invoice or dependent records changed. Reload the correction preview.");
    if (ambiguous.length) return refuse("An unscoped legacy certificate has no proven invoice relationship. Resolve its documentary scope before correction; amount matching is not sufficient.");
    if (input.reconcileCertificateId != null && !certIds.includes(input.reconcileCertificateId))
      return refuse("That certificate has no proven relationship to this invoice.");
    if ((depositRequest || parent.acompteInvoiceId === id) && (parent.acomptePaidAt || ["paid", "applied"].includes(parent.acompteState) ||
      (parent.acompteInvoiceId != null && parent.acompteInvoiceId !== id)))
      return refuse("The quotation already has a paid or separately linked deposit. Its existing link and payment state must be reconciled explicitly.");
    if (input.reason.trim().length < 20) return refuse("Explain the documentary basis for this decision (at least 20 characters).");
    if (applications.length) return refuse("An immutable deposit application protects this invoice.");
    if (feeEvidence.length || pushes.some(p => !p.dryRun && p.kind !== "customer"))
      return refuse("External fee evidence or a Pennylane operation exists. Reconcile that accounting record before correction.");
    if (entries.some(e => e.status !== "pending" || e.pennylaneInvoiceId || e.pennylaneInvoiceRef || e.pennylanePushedAt ||
      e.pennylanePaidAt || Number(e.pennylanePaidAmount ?? 0) > 0)) return refuse("A commission has been externally invoiced or paid. Reconcile it first.");
    if (aggregates.some(f => f.pennylaneRef)) return refuse("The fee aggregate has an external invoice reference. Reconcile it first.");
    if (payments.length || communications.some(c => ["queued", "sending", "sent"].includes(c.status))) return refuse("Certificate payment or delivery activity prevents correction.");
    if (affected.length) {
      const c = affected[0];
      if (affected.length !== 1 || input.reconcileCertificateId !== c.id) return refuse("Explicitly reconcile the existing certificate; do not create a second deposit claim.");
      if (c.pdfStorageKey || c.issuanceSnapshot || !["draft", "ready"].includes(c.status) ||
        sources.some(s => s.certificatId === c.id) || Math.abs(Number(c.totalWorksHt) - input.amountHt) > 0.005)
        return refuse("The existing certificate cannot be safely linked unchanged. Reissue or resolve its scope first.");
      if (attachments.some(a => a.frozenAt)) return refuse("The attached architect invoice is frozen for delivery.");
      if (attachments.some(a => a.storageKey) && !input.externalInvoiceUnsent)
        return refuse("Confirm the external architect invoice has not been sent or paid before removing it from the outbound package for review.");
    }
    const source = { ...(invoice.aiExtractedData as Record<string, unknown> ?? {}) };
    // Match confirmation's source normalization before binding the decision.
    // Otherwise confirmation would invalidate a just-reviewed legacy source
    // merely by adding its preserved full-contract totals.
    source.documentType ??= "invoice";
    invoiceRequestAmounts(source as unknown as ParsedDocument);
    source._requestResolution = { evidenceKey: invoiceRequestEvidenceKey(source), amountHt: input.amountHt,
      amountTtc: input.amountTtc, reason: input.reason.trim(), actor, recordedAt: new Date().toISOString() };
    const [updated] = await tx.update(invoices).set({ amountHt: money(input.amountHt), amountTtc: money(input.amountTtc),
      tvaAmount: money(input.amountTtc - input.amountHt), aiExtractedData: source }).where(eq(invoices.id, id)).returning();
    for (const entry of entries) await tx.update(feeEntries).set({ baseHt: money(input.amountHt),
      feeAmount: money(input.amountHt * Number(entry.feeRate) / 100) }).where(eq(feeEntries.id, entry.id));
    for (const aggregate of aggregates) {
      const all = await tx.select().from(feeEntries).where(eq(feeEntries.feeId, aggregate.id));
      const total = all.reduce((sum, e) => sum + Number(e.feeAmount), 0);
      if (total < Number(aggregate.invoicedAmount ?? 0)) return refuse("Correction would reduce total fees below the already invoiced aggregate.");
      await tx.update(fees).set({ baseAmountHt: money(all.reduce((sum, e) => sum + Number(e.baseHt), 0)),
        feeAmountHt: money(total), remainingAmount: money(total - Number(aggregate.invoicedAmount ?? 0)) }).where(eq(fees.id, aggregate.id));
    }
    for (const c of affected) {
      await tx.insert(certificatSources).values({ certificatId: c.id, invoiceId: id });
      await tx.update(certificats).set({ version: sql`${certificats.version} + 1` }).where(eq(certificats.id, c.id));
      // Original object bytes and their keys remain in the immutable audit below.
      // Sending must require a newly checked attachment or explicit send-without.
      await tx.update(certificatArchitectInvoices).set({ storageKey: null, fileName: null,
        confirmedWithoutInvoice: false, preparedBy: null }).where(eq(certificatArchitectInvoices.certificatId, c.id));
    }
    if (deposit && parent.acompteRequired && parent.acompteInvoiceId == null &&
      ["none", "pending", "invoiced"].includes(parent.acompteState))
      await tx.update(devis).set({ acompteInvoiceId: id, acompteState: "invoiced" }).where(eq(devis.id, invoice.devisId));
    await tx.insert(invoiceRequestDecisions).values({ invoiceId: id, actor, reason: input.reason.trim(),
      beforeState: state, afterState: { invoice: updated, reconciledCertificates: affected.map(c => c.id) } });
    return { invoice: updated, corrected: true, retainedCertificateIds: affected.map(c => c.id),
      attachmentReviewRequired: attachments.some(a => a.storageKey) };
  });
}
