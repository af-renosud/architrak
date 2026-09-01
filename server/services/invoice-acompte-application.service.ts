import {
  acompteNoInvoicePayments,
  certificatPayments,
  certificats,
  devis,
  emailDocuments,
  invoiceAcompteApplications,
  invoices,
  projectIntakeDocuments,
  type Invoice,
  type InvoiceAcompteApplication,
} from "@shared/schema";
import { computeCertificatPaymentState, roundCurrency } from "@shared/financial-utils";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { isExplicitPaidAcompteEvidence, resolveAcompteAmounts } from "./acompte.service";

export type InvoiceAcompteApplicationResult =
  | { outcome: "applied"; application: InvoiceAcompteApplication; replayed: boolean }
  | { outcome: "not_applicable" }
  | { outcome: "needs_review"; code: string; message: string };

/** The invoice facts that an acompte application will make economically immutable. */
export interface InvoiceAcompteProtectedSnapshot {
  amountHt: string;
  tvaAmount: string;
  amountTtc: string;
  devisId: number;
  projectId: number;
  contractorId: number;
  sourceIntakeDocumentId: number | null;
  pdfPath: string | null;
  aiExtractedData: unknown;
}

export function invoiceAcompteProtectedSnapshot(
  invoice: Pick<Invoice, keyof InvoiceAcompteProtectedSnapshot>,
): InvoiceAcompteProtectedSnapshot {
  return {
    amountHt: String(invoice.amountHt),
    tvaAmount: String(invoice.tvaAmount),
    amountTtc: String(invoice.amountTtc),
    devisId: invoice.devisId,
    projectId: invoice.projectId,
    contractorId: invoice.contractorId,
    sourceIntakeDocumentId: invoice.sourceIntakeDocumentId,
    pdfPath: invoice.pdfPath,
    aiExtractedData: invoice.aiExtractedData,
  };
}

function matchesProtectedSnapshot(
  invoice: Invoice,
  expected: InvoiceAcompteProtectedSnapshot,
): boolean {
  const actual = invoiceAcompteProtectedSnapshot(invoice);
  return actual.amountHt === expected.amountHt
    && actual.tvaAmount === expected.tvaAmount
    && actual.amountTtc === expected.amountTtc
    && actual.devisId === expected.devisId
    && actual.projectId === expected.projectId
    && actual.contractorId === expected.contractorId
    && actual.sourceIntakeDocumentId === expected.sourceIntakeDocumentId
    && actual.pdfPath === expected.pdfPath
    && JSON.stringify(actual.aiExtractedData) === JSON.stringify(expected.aiExtractedData);
}

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A paid opening-deposit certificat is stronger evidence than the stale devis
 * workflow flag. Reconcile that fact before applying the progress-invoice gate
 * so the team is never asked to confirm the same payment twice.
 */
export async function reconcilePaidAcompteFromCertificatLedger(devisId: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [lockedDevis] = await tx.select().from(devis).where(eq(devis.id, devisId)).for("update");
    if (
      !lockedDevis
      || !lockedDevis.acompteRequired
      || lockedDevis.acompteState !== "pending"
      || lockedDevis.acompteInvoiceId != null
    ) {
      return false;
    }
    const amounts = resolveAcompteAmounts(lockedDevis);
    if (!amounts) return false;

    const [certificat] = await tx
      .select()
      .from(certificats)
      .where(and(eq(certificats.acompteDevisId, lockedDevis.id), ne(certificats.status, "superseded")))
      .for("update");
    if (
      !certificat
      || certificat.projectId !== lockedDevis.projectId
      || certificat.contractorId !== lockedDevis.contractorId
      || roundCurrency(Number(certificat.netToPayHt)) !== amounts.amountHt
      || roundCurrency(Number(certificat.netToPayTtc)) !== amounts.amountTtc
    ) {
      return false;
    }

    const payments = await tx
      .select()
      .from(certificatPayments)
      .where(eq(certificatPayments.certificatId, certificat.id))
      .for("update");
    const paymentState = computeCertificatPaymentState(
      Number(certificat.netToPayTtc),
      payments.map((payment) => Number(payment.amount)),
    );
    if (!paymentState.fullyPaid) return false;

    const coverageDate = payments
      .map((payment) => payment.datePaid)
      .sort()
      .at(-1);
    await tx.update(devis).set({
      acompteState: "paid",
      acomptePaidAt: coverageDate ? new Date(`${coverageDate}T12:00:00.000Z`) : sql`now()`,
      acomptePaidVia: "certificat_no_invoice",
      updatedAt: sql`now()`,
    }).where(eq(devis.id, lockedDevis.id));
    return true;
  });
}

/**
 * Apply the exact opening-deposit deduction printed on a source-bound invoice.
 * The immutable row is both the replay key and the accounting proof. Anything
 * ambiguous is refused rather than inferred.
 */
export async function applyInvoiceAcompteDeduction(
  invoiceId: number,
  expectedProtectedSnapshot?: InvoiceAcompteProtectedSnapshot,
): Promise<InvoiceAcompteApplicationResult> {
  return db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!invoice) return { outcome: "not_applicable" as const };
    if (expectedProtectedSnapshot && !matchesProtectedSnapshot(invoice, expectedProtectedSnapshot)) {
      return {
        outcome: "needs_review" as const,
        code: "invoice_acompte_snapshot_changed",
        message: "The invoice's protected totals or provenance changed while confirmation was in progress.",
      };
    }

    const [existing] = await tx
      .select()
      .from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.invoiceId, invoice.id))
      .for("update");
    if (existing) return { outcome: "applied" as const, application: existing, replayed: true };

    const [lockedDevis] = await tx.select().from(devis).where(eq(devis.id, invoice.devisId)).for("update");
    if (!lockedDevis || !lockedDevis.acompteRequired || !["paid", "applied"].includes(lockedDevis.acompteState)) {
      return { outcome: "not_applicable" as const };
    }
    if (
      invoice.devisId !== lockedDevis.id
      || invoice.projectId !== lockedDevis.projectId
      || invoice.contractorId !== lockedDevis.contractorId
    ) {
      return {
        outcome: "needs_review" as const,
        code: "acompte_invoice_identity_mismatch",
        message: "The invoice's devis, project, or contractor does not match the opening-deposit devis.",
      };
    }
    if (invoice.sourceIntakeDocumentId == null) return { outcome: "not_applicable" as const };
    const [existingForDevis] = await tx
      .select()
      .from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.devisId, lockedDevis.id))
      .for("update");
    if (existingForDevis) {
      return {
        outcome: "needs_review" as const,
        code: "acompte_already_applied",
        message: "This opening deposit is already applied to another invoice.",
      };
    }
    const amounts = resolveAcompteAmounts(lockedDevis);
    if (!amounts) {
      return { outcome: "needs_review" as const, code: "acompte_amount_missing", message: "The opening-deposit amount cannot be resolved from the devis." };
    }

    const [source] = await tx
      .select()
      .from(projectIntakeDocuments)
      .where(eq(projectIntakeDocuments.id, invoice.sourceIntakeDocumentId))
      .for("update");
    if (
      !source
      || source.projectId !== invoice.projectId
      || !source.contentFingerprint
    ) {
      return { outcome: "needs_review" as const, code: "acompte_source_mismatch", message: "The invoice source provenance is incomplete or inconsistent." };
    }
    const parsed = source.extractedData as Record<string, unknown> | null;
    const exactId = (value: unknown): number | null =>
      typeof value === "number" && Number.isInteger(value) ? value
        : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
    const conflictsWithExactId = (key: string, expected: number): boolean =>
      Object.prototype.hasOwnProperty.call(parsed, key)
      && exactId(parsed?.[key]) !== expected;
    const hasPromotionMetadata = source.promotedKind != null || source.promotedId != null;
    if (
      parsed?.documentType !== "invoice"
      || (hasPromotionMetadata && (source.promotedKind !== "invoice" || source.promotedId == null))
      || conflictsWithExactId("projectId", lockedDevis.projectId)
      || conflictsWithExactId("contractorId", lockedDevis.contractorId)
      || conflictsWithExactId("devisId", lockedDevis.id)
      || (typeof parsed?.devisCode === "string" && parsed.devisCode.trim() !== lockedDevis.devisCode)
      || (Object.prototype.hasOwnProperty.call(parsed, "devisCode") && typeof parsed?.devisCode !== "string")
    ) {
      return { outcome: "needs_review" as const, code: "acompte_source_identity_mismatch", message: "The invoice source type or identity provenance contradicts the linked devis." };
    }
    // Promotion is optional (an invoice can legitimately still be awaiting
    // promotion), but when present it must identify this exact invoice.
    if (source.promotedKind === "invoice" && source.promotedId != null) {
      const [promotedInvoice] = await tx.select().from(invoices).where(eq(invoices.id, source.promotedId)).for("update");
      if (
        !promotedInvoice
        || promotedInvoice.id !== invoice.id
        || promotedInvoice.projectId !== lockedDevis.projectId
        || promotedInvoice.contractorId !== lockedDevis.contractorId
        || promotedInvoice.devisId !== lockedDevis.id
      ) {
        return { outcome: "needs_review" as const, code: "acompte_source_identity_mismatch", message: "The promoted source invoice contradicts the linked invoice or devis." };
      }
    }
    if (source.sourceEmailDocumentId != null) {
      const [email] = await tx.select().from(emailDocuments).where(eq(emailDocuments.id, source.sourceEmailDocumentId)).for("update");
      if (
        !email
        || (email.projectId != null && email.projectId !== lockedDevis.projectId)
        || (email.contractorId != null && email.contractorId !== lockedDevis.contractorId)
        || (email.devisId != null && email.devisId !== lockedDevis.id)
        || (email.invoiceId != null && email.invoiceId !== invoice.id)
      ) {
        return { outcome: "needs_review" as const, code: "acompte_source_identity_mismatch", message: "The source email provenance contradicts the linked invoice or devis." };
      }
    }
    const evidenceText = parsed?.acomptePaidEvidenceText;
    const evidenceAmountTtc = asFiniteNumber(parsed?.acomptePaidAmountTtc);
    const netPayableTtc = asFiniteNumber(parsed?.netAPayer);
    const retenueTtc = asFiniteNumber(parsed?.retenueDeGarantie) ?? 0;
    if (
      parsed?.documentType !== "invoice"
      || !isExplicitPaidAcompteEvidence(evidenceText)
      || evidenceAmountTtc == null
      || roundCurrency(evidenceAmountTtc) !== amounts.amountTtc
    ) {
      return { outcome: "needs_review" as const, code: "acompte_evidence_mismatch", message: "The invoice does not contain an exact paid-deposit deduction matching the devis." };
    }
    if (
      netPayableTtc == null
      || roundCurrency(Number(invoice.amountTtc) - amounts.amountTtc - retenueTtc) !== roundCurrency(netPayableTtc)
    ) {
      return { outcome: "needs_review" as const, code: "acompte_net_mismatch", message: "Gross TTC minus the deposit and stated deductions does not equal the invoice net payable." };
    }

    const [certificat] = await tx
      .select()
      .from(certificats)
      .where(and(eq(certificats.acompteDevisId, lockedDevis.id), ne(certificats.status, "superseded")))
      .for("update");
    if (
      !certificat
      || certificat.projectId !== invoice.projectId
      || certificat.contractorId !== invoice.contractorId
      || roundCurrency(Number(certificat.netToPayHt)) !== amounts.amountHt
      || roundCurrency(Number(certificat.netToPayTtc)) !== amounts.amountTtc
    ) {
      return { outcome: "needs_review" as const, code: "acompte_certificat_mismatch", message: "No matching live opening-deposit certificat was found." };
    }

    const payments = await tx
      .select()
      .from(certificatPayments)
      .where(eq(certificatPayments.certificatId, certificat.id))
      .for("update");
    const paymentState = computeCertificatPaymentState(
      Number(certificat.netToPayTtc),
      payments.map((payment) => Number(payment.amount)),
    );
    const [audit] = await tx
      .select()
      .from(acompteNoInvoicePayments)
      .where(eq(acompteNoInvoicePayments.devisId, lockedDevis.id))
      .for("update");
    const matchingAudit = audit
      && audit.certificatId === certificat.id
      && audit.sourceIntakeDocumentId === source.id
      && audit.sourceContentFingerprint === source.contentFingerprint
      && roundCurrency(Number(audit.amountHt)) === amounts.amountHt
      && roundCurrency(Number(audit.amountTtc)) === amounts.amountTtc
      ? audit
      : null;
    if (!paymentState.fullyPaid && !matchingAudit) {
      return { outcome: "needs_review" as const, code: "acompte_payment_unproven", message: "The opening-deposit payment is not covered by the certificat ledger or matching operator audit." };
    }

    const ledgerPaidAt = payments.map((payment) => payment.datePaid).sort().at(-1) ?? null;
    const ledgerReferences = Array.from(new Set(
      payments.map((payment) => payment.reference?.trim()).filter((value): value is string => Boolean(value)),
    )).sort();
    const auditReference = matchingAudit?.paymentReference.trim() || null;
    const dateConflict = Boolean(
      ledgerPaidAt
      && matchingAudit
      && ledgerPaidAt !== matchingAudit.paidAt.toISOString().slice(0, 10),
    );
    const referenceConflict = Boolean(
      ledgerReferences.length > 0
      && auditReference
      && !ledgerReferences.includes(auditReference),
    );

    const [application] = await tx.insert(invoiceAcompteApplications).values({
      invoiceId: invoice.id,
      devisId: lockedDevis.id,
      certificatId: certificat.id,
      sourceIntakeDocumentId: source.id,
      noInvoicePaymentId: matchingAudit?.id ?? null,
      sourceStorageKey: source.storageKey,
      sourceFileName: source.fileName,
      sourceContentFingerprint: source.contentFingerprint,
      appliedHt: amounts.amountHt.toFixed(2),
      appliedTtc: amounts.amountTtc.toFixed(2),
      invoiceGrossHt: roundCurrency(Number(invoice.amountHt)).toFixed(2),
      invoiceGrossTtc: roundCurrency(Number(invoice.amountTtc)).toFixed(2),
      invoiceNetPayableTtc: roundCurrency(netPayableTtc).toFixed(2),
      paymentLedgerPaidAt: ledgerPaidAt,
      paymentAuditPaidAt: matchingAudit?.paidAt ?? null,
      paymentLedgerReferences: ledgerReferences.join(", ") || null,
      paymentAuditReference: auditReference,
      paymentConflict: dateConflict || referenceConflict,
      evidenceText,
    }).returning();

    await tx.update(devis).set({
      acompteState: "applied",
      updatedAt: sql`now()`,
    }).where(eq(devis.id, lockedDevis.id));
    return { outcome: "applied" as const, application, replayed: false };
  });
}