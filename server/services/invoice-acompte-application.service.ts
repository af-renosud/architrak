import {
  acompteNoInvoicePayments,
  certificatPayments,
  certificats,
  devis,
  invoiceAcompteApplications,
  invoices,
  projectIntakeDocuments,
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
): Promise<InvoiceAcompteApplicationResult> {
  return db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!invoice || invoice.sourceIntakeDocumentId == null) return { outcome: "not_applicable" as const };

    const [existing] = await tx
      .select()
      .from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.invoiceId, invoice.id))
      .for("update");
    if (existing) return { outcome: "applied" as const, application: existing, replayed: true };

    const [lockedDevis] = await tx.select().from(devis).where(eq(devis.id, invoice.devisId)).for("update");
    if (
      !lockedDevis
      || invoice.projectId !== lockedDevis.projectId
      || invoice.contractorId !== lockedDevis.contractorId
      || !lockedDevis.acompteRequired
      || !["paid", "applied"].includes(lockedDevis.acompteState)
    ) {
      return { outcome: "not_applicable" as const };
    }
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