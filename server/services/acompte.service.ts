/**
 * Task #215 — Acompte (deposit) workflow business logic.
 *
 * The devis row carries the acompte spec (`acompteRequired`,
 * `acomptePercent`, `acompteAmountHt`, `acompteTrigger`), the lifecycle
 * state (`acompteState`), the per-devis gate override
 * (`allowProgressBeforeAcompte`), and the eventual link to the facture
 * d'acompte (`acompteInvoiceId`, `acomptePaidAt`).
 *
 * State machine:
 *
 *   none  ──(architect ticks "Acompte requis"
 *            OR extractor sees a deposit clause)──▶ pending
 *   pending  ──(facture d'acompte linked)──▶ invoiced
 *   invoiced ──(invoice.datePaid set OR
 *               POST /acompte/mark-paid)──▶ paid
 *   paid    ──(future: final reconciliation)──▶ applied
 *
 * Gate:
 *   - Blocks situation/invoice creation when
 *     acompteRequired=true AND acompteState IN ('pending','invoiced')
 *     AND allowProgressBeforeAcompte=false.
 *   - The facture d'acompte itself is exempt (caller passes
 *     opts.isAcompteInvoice=true) so that linking the deposit invoice
 *     doesn't bootstrap-deadlock against its own gate.
 *
 * No raw float math — all amounts go through `roundCurrency` and are
 * compared at 2 decimals only at evaluation time.
 */
import type { Devis } from "@shared/schema";
import { acompteNoInvoicePayments, certificats, devis as devisTable, emailDocuments, invoices, projectIntakeDocuments, projects } from "@shared/schema";
import { deriveTvaAmount, roundCurrency } from "@shared/financial-utils";
import { db } from "../db";
import { and, eq, ne, sql } from "drizzle-orm";

export type AcompteState = "none" | "pending" | "invoiced" | "paid" | "applied";

export const ACOMPTE_GATE_BLOCKING_STATES: ReadonlySet<AcompteState> = new Set<AcompteState>([
  "pending",
  "invoiced",
]);

export interface GateBlockedReason {
  blocked: true;
  code: "acompte_unpaid";
  message: string;
  state: AcompteState;
  acompteAmountHt: string | null;
  acomptePercent: string | null;
}

export interface GateAllowed {
  blocked: false;
}

export type GateDecision = GateAllowed | GateBlockedReason;

export interface GateInputs {
  acompteRequired: boolean;
  acompteState: string;
  allowProgressBeforeAcompte: boolean;
  acompteAmountHt: string | null;
  acomptePercent: string | null;
}

/**
 * Decide whether progress invoicing (situation creation, generic
 * invoice creation) is allowed for a devis.
 *
 * The facture d'acompte itself MUST bypass this gate: when the caller
 * is creating the deposit invoice, pass `opts.isAcompteInvoice=true`.
 */
export function evaluateAcompteGate(
  devis: GateInputs,
  opts: { isAcompteInvoice?: boolean } = {},
): GateDecision {
  if (opts.isAcompteInvoice) return { blocked: false };
  if (!devis.acompteRequired) return { blocked: false };
  if (devis.allowProgressBeforeAcompte) return { blocked: false };
  const state = devis.acompteState as AcompteState;
  if (!ACOMPTE_GATE_BLOCKING_STATES.has(state)) return { blocked: false };

  const amountStr = devis.acompteAmountHt ?? null;
  const pctStr = devis.acomptePercent ?? null;
  const amountFr = amountStr ? `${Number(amountStr).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € HT` : null;
  const pctFr = pctStr ? `${Number(pctStr).toLocaleString("fr-FR")}\u00A0%` : null;
  const spec = amountFr && pctFr ? `${pctFr} (${amountFr})` : amountFr ?? pctFr ?? "Acompte requis";
  const stateMsg = state === "pending"
    ? "facture d'acompte not yet received"
    : "facture d'acompte not yet paid";

  return {
    blocked: true,
    code: "acompte_unpaid",
    message: `Cannot create a progress situation/invoice: the acompte of ${spec} must be settled before invoicing. Current state: ${stateMsg}. To exceptionally bypass this, enable "Autoriser la facturation avant acompte" on the devis.`,
    state,
    acompteAmountHt: amountStr,
    acomptePercent: pctStr,
  };
}

/**
 * Project a `Devis` row down to the gate-relevant fields. Keeps
 * callsites concise and centralises the string→bool mapping.
 */
export function gateInputsFromDevis(d: Devis): GateInputs {
  return {
    acompteRequired: d.acompteRequired === true,
    acompteState: d.acompteState ?? "none",
    allowProgressBeforeAcompte: d.allowProgressBeforeAcompte === true,
    acompteAmountHt: d.acompteAmountHt ?? null,
    acomptePercent: d.acomptePercent ?? null,
  };
}

/**
 * Compute the next legal state on a transition request. Returns the
 * target state, or null if the transition is not permitted from the
 * current state. Pure function — does not write.
 */
export function nextAcompteState(
  current: string,
  event: "link_invoice" | "mark_paid" | "mark_paid_no_invoice",
): AcompteState | null {
  const c = current as AcompteState;
  // Strict forward-only state machine per Task #215 spec:
  //   none → pending → invoiced → paid → applied
  // (`applied` is reached by the deduction engine — see follow-up #216 —
  //  not by these manual transitions.) Backward / skip transitions
  //  (e.g. pending→paid, invoiced→pending) are intentionally rejected;
  //  admin reset to `none` is a separate audited operation, not a
  //  generic event handled here.
  switch (event) {
    case "link_invoice":
      // Linking the facture d'acompte is only meaningful while pending.
      // Re-linking from invoiced is a no-op handled at the route layer
      // (it updates the link target without changing state).
      if (c === "pending") return "invoiced";
      if (c === "invoiced") return "invoiced";
      return null;
    case "mark_paid":
      // The deposit is "paid" only after the facture d'acompte has been
      // linked (state='invoiced'). Operators who never upload a
      // facture d'acompte must link one before marking paid.
      if (c === "invoiced") return "paid";
      return null;
    case "mark_paid_no_invoice":
      // Task #491 — deposit raised via an ACOMPTE CERTIFICAT (no supplier
      // invoice ever exists). The route only fires this event after
      // verifying a live acompte certificat exists for the devis, so
      // 'pending' may advance straight to 'paid'. An 'invoiced' devis has
      // a facture d'acompte — it must use the invoice path for audit.
      if (c === "pending") return "paid";
      return null;
  }
}

/**
 * Task #491 — resolve the deposit money for an acompte certificat from the
 * devis's own acompte spec. Grounded in the devis document itself:
 *  - explicit `acompteAmountHt` wins; TTC follows the devis's own HT→TTC
 *    ratio (that is exactly what a facture d'acompte would state);
 *  - otherwise `acomptePercent` of the devis HT/TTC.
 * Returns null when the spec resolves to no positive amount.
 */
/**
 * Task #491 — the ONLY way to link a facture d'acompte to a devis's
 * lifecycle. One transaction, devis row locked FOR UPDATE:
 *  - re-checks the lifecycle state under the lock (no stale-read CAS),
 *  - refuses when a live (non-superseded) acompte certificat exists — the
 *    deposit is already authorised without an invoice, so linking a facture
 *    d'acompte on top would double-authorise it,
 *  - writes the link + state + provenance atomically.
 * The generate-certificat route locks the same devis row FOR UPDATE, so the
 * two paths are fully serialised: whichever commits first wins and the
 * other observes it.
 */
export async function linkAcompteInvoiceTx(input: {
  devisId: number;
  invoiceId: number;
  // Kept optional for existing upload callers. Payment status is always read
  // from the locked invoice row, never from this caller-supplied value.
  invoiceDatePaid?: string | null;
}): Promise<
  | { ok: true; devis: Devis }
  | { ok: false; code: "devis_not_found" | "invoice_not_found" | "acompte_invoice_mismatch" | "acompte_invalid_transition"; currentState?: string }
  | { ok: false; code: "acompte_certificat_exists"; certificatId: number; certificateRef: string }
> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(devisTable)
      .where(eq(devisTable.id, input.devisId))
      .for("update");
    if (!locked) return { ok: false as const, code: "devis_not_found" as const };
    const [liveAcompteCert] = await tx
      .select({ id: certificats.id, certificateRef: certificats.certificateRef })
      .from(certificats)
      .where(and(eq(certificats.acompteDevisId, input.devisId), ne(certificats.status, "superseded")))
      .limit(1);
    if (liveAcompteCert) {
      return {
        ok: false as const,
        code: "acompte_certificat_exists" as const,
        certificatId: liveAcompteCert.id,
        certificateRef: liveAcompteCert.certificateRef,
      };
    }
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update");
    // Do not trust an earlier route/upload lookup: the invoice can be
    // reassigned while this request waits for the devis lock.
    if (!invoice) return { ok: false as const, code: "invoice_not_found" as const };
    if (
      invoice.devisId !== locked.id
      || invoice.projectId !== locked.projectId
      || invoice.contractorId !== locked.contractorId
    ) {
      return { ok: false as const, code: "acompte_invoice_mismatch" as const };
    }
    const target = nextAcompteState(locked.acompteState, "link_invoice");
    if (!target) {
      return { ok: false as const, code: "acompte_invalid_transition" as const, currentState: locked.acompteState };
    }
    const finalState = invoice.datePaid ? "paid" : target;
    const [updated] = await tx
      .update(devisTable)
      .set({
        acompteInvoiceId: input.invoiceId,
        acompteState: finalState,
        acomptePaidAt: invoice.datePaid ? new Date(`${invoice.datePaid}T12:00:00.000Z`) : null,
        acomptePaidVia: invoice.datePaid ? "invoice" : null,
      })
      .where(eq(devisTable.id, input.devisId))
      .returning();
    return { ok: true as const, devis: updated };
  });
}

/** Mark an invoice-linked deposit paid only from the invoice's recorded payment evidence. */
export async function markAcompteInvoicePaidTx(devisId: number): Promise<
  | { ok: true; devis: Devis }
  | { ok: false; code: "devis_not_found" | "acompte_invalid_transition" | "acompte_invoice_missing" | "acompte_invoice_mismatch" | "acompte_invoice_unpaid"; currentState?: string }
> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(devisTable).where(eq(devisTable.id, devisId)).for("update");
    if (!locked) return { ok: false as const, code: "devis_not_found" as const };
    if (locked.acompteState !== "invoiced") {
      return { ok: false as const, code: "acompte_invalid_transition" as const, currentState: locked.acompteState };
    }
    if (locked.acompteInvoiceId == null) return { ok: false as const, code: "acompte_invoice_missing" as const };
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, locked.acompteInvoiceId)).for("update");
    if (!invoice) return { ok: false as const, code: "acompte_invoice_missing" as const };
    if (invoice.devisId !== locked.id || invoice.projectId !== locked.projectId || invoice.contractorId !== locked.contractorId) {
      return { ok: false as const, code: "acompte_invoice_mismatch" as const };
    }
    if (!invoice.datePaid) return { ok: false as const, code: "acompte_invoice_unpaid" as const };
    const [updated] = await tx.update(devisTable).set({
      acompteState: "paid",
      acomptePaidAt: new Date(`${invoice.datePaid}T12:00:00.000Z`),
      acomptePaidVia: "invoice",
      updatedAt: sql`now()`,
    }).where(eq(devisTable.id, locked.id)).returning();
    return { ok: true as const, devis: updated };
  });
}

export function resolveAcompteAmounts(d: {
  acompteAmountHt: string | null;
  acomptePercent: string | null;
  amountHt: string;
  amountTtc: string;
}): { amountHt: number; amountTtc: number } | null {
  const devisHt = parseFloat(d.amountHt) || 0;
  const devisTtc = parseFloat(d.amountTtc) || 0;
  const explicit = d.acompteAmountHt != null ? parseFloat(d.acompteAmountHt) : NaN;
  const pct = d.acomptePercent != null ? parseFloat(d.acomptePercent) : NaN;

  if (Number.isFinite(explicit) && explicit > 0) {
    const ratio = devisHt > 0 ? devisTtc / devisHt : 1;
    return { amountHt: roundCurrency(explicit), amountTtc: roundCurrency(explicit * ratio) };
  }
  if (Number.isFinite(pct) && pct > 0 && devisHt > 0) {
    return { amountHt: roundCurrency((devisHt * pct) / 100), amountTtc: roundCurrency((devisTtc * pct) / 100) };
  }
  return null;
}

export interface OpeningAcompteResolutionSuggestion {
  devisId: number;
  devisCode: string;
  amountHt: number;
  amountTtc: number;
  evidenceText: string;
  suggestedPaidAt: string | null;
}

export function isExplicitPaidAcompteEvidence(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return normalized.includes("acompte verse")
    || normalized.includes("acompte deja paye")
    || normalized.includes("deduction acompte");
}

export function getOpeningAcompteResolutionSuggestion(
  devis: Devis,
  parsed: {
    documentType?: string;
    date?: string;
    acomptePaidAmountTtc?: unknown;
    acomptePaidEvidenceText?: unknown;
  },
): OpeningAcompteResolutionSuggestion | null {
  if (
    parsed.documentType !== "invoice"
    || devis.status === "void"
    || devis.signOffStage !== "client_signed_off"
    || !devis.acompteRequired
    || devis.acompteState !== "pending"
    || devis.acompteInvoiceId != null
    || !isExplicitPaidAcompteEvidence(parsed.acomptePaidEvidenceText)
  ) {
    return null;
  }
  const expected = resolveAcompteAmounts(devis);
  const evidenceAmount = typeof parsed.acomptePaidAmountTtc === "number"
    ? parsed.acomptePaidAmountTtc
    : Number(parsed.acomptePaidAmountTtc);
  if (!expected || !Number.isFinite(evidenceAmount) || roundCurrency(evidenceAmount) !== expected.amountTtc) {
    return null;
  }
  return {
    devisId: devis.id,
    devisCode: devis.devisCode,
    amountHt: expected.amountHt,
    amountTtc: expected.amountTtc,
    evidenceText: parsed.acomptePaidEvidenceText,
    suggestedPaidAt: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date ?? "") ? parsed.date! : null,
  };
}

export type ConfirmNoInvoiceAcompteResult =
  | { outcome: "ok"; certificatId: number; replayed: boolean }
  | { outcome: "not_found" }
  | { outcome: "invalid"; code: string; message: string };

/**
 * Task #686 — the sole write path for an operator-confirmed opening deposit
 * that has no supplier invoice. It locks the devis, source evidence and
 * existing audit mapping in one transaction. Invoice linking uses the same
 * devis lock, preserving the no-invoice/invoice XOR invariant.
 */
export async function confirmNoInvoiceAcomptePayment(input: {
  devisId: number;
  sourceIntakeDocumentId: number;
  paidAt: Date;
  paymentReference: string;
  confirmedByUserId: number;
}): Promise<ConfirmNoInvoiceAcompteResult> {
  if (input.paidAt.getTime() > Date.now()) {
    return { outcome: "invalid", code: "acompte_payment_date_future", message: "Payment date cannot be in the future." };
  }
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(devisTable).where(eq(devisTable.id, input.devisId)).for("update");
    if (!locked) return { outcome: "not_found" as const };
    const [project] = await tx.select().from(projects).where(eq(projects.id, locked.projectId)).for("update");
    if (!project || project.archivedAt != null) {
      return { outcome: "invalid" as const, code: "acompte_project_archived", message: "Archived projects are read-only." };
    }
    // Replay is intentionally evaluated before lifecycle eligibility: the
    // first commit has already moved pending → paid, so checking pending
    // first would make a safely retried request look like a conflict.
    const [existingAudit] = await tx
      .select()
      .from(acompteNoInvoicePayments)
      .where(eq(acompteNoInvoicePayments.devisId, locked.id))
      .for("update");
    if (existingAudit) {
      if (
        existingAudit.sourceIntakeDocumentId !== input.sourceIntakeDocumentId
        || existingAudit.paymentReference !== input.paymentReference
        || existingAudit.paidAt.getTime() !== input.paidAt.getTime()
        || existingAudit.confirmedByUserId !== input.confirmedByUserId
      ) {
        return {
          outcome: "invalid" as const,
          code: "acompte_confirmation_conflict",
          message: "This deposit already has different confirmed payment evidence.",
        };
      }
      return { outcome: "ok" as const, certificatId: existingAudit.certificatId, replayed: true };
    }
    if (locked.status === "void" || locked.signOffStage === "void") {
      return { outcome: "invalid" as const, code: "acompte_devis_void", message: "Devis is void." };
    }
    if (locked.signOffStage !== "client_signed_off") {
      return { outcome: "invalid" as const, code: "acompte_devis_not_signed", message: "Devis must be client-signed." };
    }
    if (!locked.acompteRequired || locked.acompteState !== "pending") {
      return { outcome: "invalid" as const, code: "acompte_invalid_transition", message: "A pending acompte is required." };
    }
    if (locked.acompteInvoiceId != null) {
      return { outcome: "invalid" as const, code: "acompte_invoice_linked", message: "A supplier invoice is already linked." };
    }
    const amounts = resolveAcompteAmounts(locked);
    if (!amounts) {
      return { outcome: "invalid" as const, code: "acompte_amount_missing", message: "No positive acompte amount is configured." };
    }
    const [source] = await tx
      .select()
      .from(projectIntakeDocuments)
      .where(eq(projectIntakeDocuments.id, input.sourceIntakeDocumentId))
      .for("update");
    if (!source || source.projectId !== locked.projectId) {
      return { outcome: "invalid" as const, code: "acompte_source_project_mismatch", message: "Source intake document does not belong to this project." };
    }
    if (!source.contentFingerprint) {
      return { outcome: "invalid" as const, code: "acompte_source_unfingerprinted", message: "Source evidence has no verified content fingerprint." };
    }
    const extracted = source.extractedData as Record<string, unknown> | null;
    // A no-invoice confirmation can use an invoice that is still awaiting
    // promotion, but never a quotation/certificate/unknown source. Do not
    // require promotion: doing so would recreate the intake gate circularity.
    if (extracted?.documentType !== "invoice" || (source.promotedKind != null && source.promotedKind !== "invoice")) {
      return { outcome: "invalid" as const, code: "acompte_source_not_invoice", message: "Source evidence must be an invoice document." };
    }
    const exactId = (value: unknown): number | null =>
      typeof value === "number" && Number.isInteger(value) ? value
        : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
    const conflictsWithExactId = (key: string, expected: number): boolean =>
      Object.prototype.hasOwnProperty.call(extracted, key)
      && exactId(extracted?.[key]) !== expected;
    const hasPromotionMetadata = source.promotedKind != null || source.promotedId != null;
    if (
      (hasPromotionMetadata && (source.promotedKind !== "invoice" || source.promotedId == null))
      || conflictsWithExactId("projectId", locked.projectId)
      || conflictsWithExactId("contractorId", locked.contractorId)
      || conflictsWithExactId("devisId", locked.id)
      || (typeof extracted?.devisCode === "string" && extracted.devisCode.trim() !== locked.devisCode)
      || (Object.prototype.hasOwnProperty.call(extracted, "devisCode") && typeof extracted?.devisCode !== "string")
    ) {
      return { outcome: "invalid" as const, code: "acompte_source_identity_mismatch", message: "Source evidence identifies a different project, contractor, or devis." };
    }
    if (source.promotedKind === "invoice" && source.promotedId != null) {
      const [promotedInvoice] = await tx.select().from(invoices).where(eq(invoices.id, source.promotedId)).for("update");
      if (
        !promotedInvoice
        || promotedInvoice.projectId !== locked.projectId
        || promotedInvoice.contractorId !== locked.contractorId
        || promotedInvoice.devisId !== locked.id
      ) {
        return { outcome: "invalid" as const, code: "acompte_source_identity_mismatch", message: "Promoted source invoice identifies a different project, contractor, or devis." };
      }
    }
    if (source.sourceEmailDocumentId != null) {
      const [email] = await tx.select().from(emailDocuments).where(eq(emailDocuments.id, source.sourceEmailDocumentId)).for("update");
      if (
        !email
        || (email.projectId != null && email.projectId !== locked.projectId)
        || (email.contractorId != null && email.contractorId !== locked.contractorId)
        || (email.devisId != null && email.devisId !== locked.id)
      ) {
        return { outcome: "invalid" as const, code: "acompte_source_identity_mismatch", message: "Source email provenance identifies a different project, contractor, or devis." };
      }
      if (email.invoiceId != null) {
        const [emailInvoice] = await tx.select().from(invoices).where(eq(invoices.id, email.invoiceId)).for("update");
        if (
          !emailInvoice
          || emailInvoice.projectId !== locked.projectId
          || emailInvoice.contractorId !== locked.contractorId
          || emailInvoice.devisId !== locked.id
        ) {
          return { outcome: "invalid" as const, code: "acompte_source_identity_mismatch", message: "Source email's linked invoice identifies a different project, contractor, or devis." };
        }
      }
    }
    const extractedAmount = extracted?.acomptePaidAmountTtc;
    const evidenceAmount = typeof extractedAmount === "number" ? extractedAmount : Number(extractedAmount);
    if (
      !Number.isFinite(evidenceAmount)
      || roundCurrency(evidenceAmount) !== amounts.amountTtc
      || !isExplicitPaidAcompteEvidence(extracted?.acomptePaidEvidenceText)
    ) {
      return { outcome: "invalid" as const, code: "acompte_source_amount_mismatch", message: "Source evidence does not report the expected paid deposit TTC amount." };
    }
    const [existingCert] = await tx
      .select()
      .from(certificats)
      .where(and(eq(certificats.acompteDevisId, locked.id), ne(certificats.status, "superseded")))
      .for("update");
    let cert = existingCert;
    if (cert) {
      if (roundCurrency(Number(cert.netToPayHt)) !== amounts.amountHt || roundCurrency(Number(cert.netToPayTtc)) !== amounts.amountTtc) {
        return { outcome: "invalid" as const, code: "acompte_certificat_amount_mismatch", message: "Existing acompte certificat does not match the devis amount." };
      }
    } else {
      // Serialize reference allocation per project; certificate_ref's unique
      // constraint remains the final database backstop.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${locked.projectId})`);
      const rows = await tx.select({ ref: certificats.certificateRef }).from(certificats).where(eq(certificats.projectId, locked.projectId));
      const next = rows.reduce((max, row) => Math.max(max, Number(/^C(\d+)$/.exec(row.ref)?.[1] ?? 0)), 0) + 1;
      const tvaAmount = deriveTvaAmount(amounts.amountHt, amounts.amountTtc);
      const rate = amounts.amountHt > 0 ? roundCurrency((tvaAmount / amounts.amountHt) * 100) : 0;
      [cert] = await tx.insert(certificats).values({
        projectId: locked.projectId, contractorId: locked.contractorId, certificateRef: `C${next}`,
        dateIssued: input.paidAt.toISOString().slice(0, 10), totalWorksHt: amounts.amountHt.toFixed(2),
        pvMvAdjustment: "0.00", previousPayments: "0.00", retenueGarantie: "0.00",
        cumulativeProrataDeduction: "0.00", periodProrataDeduction: "0.00",
        cumulativeAcompteRecoupment: "0.00", periodAcompteRecoupment: "0.00",
        tvaRatePercent: rate.toFixed(2), tvaAutoliquidation: false, tvaRateSource: "documentary",
        netToPayHt: amounts.amountHt.toFixed(2), tvaAmount: tvaAmount.toFixed(2), netToPayTtc: amounts.amountTtc.toFixed(2),
        notes: `Acompte (opening/deposit) on devis ${locked.devisCode} — no supplier invoice.`,
        acompteDevisId: locked.id,
      }).returning();
    }
    await tx.insert(acompteNoInvoicePayments).values({
      devisId: locked.id, certificatId: cert.id, sourceIntakeDocumentId: source.id,
      sourceStorageKey: source.storageKey, sourceFileName: source.fileName,
      sourceContentFingerprint: source.contentFingerprint,
      amountHt: amounts.amountHt.toFixed(2), amountTtc: amounts.amountTtc.toFixed(2),
      paidAt: input.paidAt, paymentReference: input.paymentReference,
      evidenceText: typeof extracted?.acomptePaidEvidenceText === "string" ? extracted.acomptePaidEvidenceText : null,
      confirmedByUserId: input.confirmedByUserId,
    });
    await tx.update(devisTable).set({
      acompteState: "paid",
      acompteAmountHt:
        locked.acompteAmountHt != null && parseFloat(locked.acompteAmountHt) > 0
          ? locked.acompteAmountHt
          : amounts.amountHt.toFixed(2),
      acomptePaidAt: input.paidAt,
      acomptePaidVia: "certificat_no_invoice",
      updatedAt: sql`now()`,
    }).where(eq(devisTable.id, locked.id));
    return { outcome: "ok" as const, certificatId: cert.id, replayed: false };
  });
}
