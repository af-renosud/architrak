/**
 * Task #215 — Acompte (deposit) workflow routes.
 *
 * Mounted under `/api/devis/:id/acompte/*`. The "spec" fields
 * (`acompteRequired`, `acomptePercent`, `acompteAmountHt`,
 * `allowProgressBeforeAcompte`) are edited via the existing
 * PATCH /api/devis/:id endpoint — those columns are part of the
 * insert/update schema. THIS router only owns the lifecycle
 * transitions (link facture d'acompte, mark paid).
 */
import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { nextAcompteState, resolveAcompteAmounts, linkAcompteInvoiceTx } from "../services/acompte.service";
import { db } from "../db";
import { certificats, devis as devisTable } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

// Unwrap pg error info (drizzle wraps the driver error in `cause`).
function pgErrorInfo(err: unknown): { code?: string; constraint?: string } {
  let e = err as { code?: string; constraint?: string; cause?: unknown } | null;
  while (e && typeof e === "object" && !e.code && e.cause) e = e.cause as typeof e;
  return { code: e?.code, constraint: e?.constraint };
}

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const linkBodySchema = z.object({ invoiceId: z.coerce.number().int().positive() }).strict();

router.post(
  "/api/devis/:id/acompte/link-invoice",
  requireAuth,
  validateRequest({ params: idParams, body: linkBodySchema }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const invoiceId = Number(req.body.invoiceId);
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    if (!devis.acompteRequired) {
      return res.status(409).json({ message: "Devis n'a pas d'acompte requis", code: "acompte_not_required" });
    }
    // Task #491 — mutual exclusion with the no-invoice path: once a live
    // acompte certificat exists, the deposit is authorised without an
    // invoice; linking a facture d'acompte on top would double-authorise.
    // The check, transition and write happen in ONE transaction under a
    // devis row lock (see linkAcompteInvoiceTx) — the same lock the
    // generate-certificat route takes, so the two paths are serialised.
    const invoice = await storage.getInvoice(invoiceId);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.devisId !== devisId) {
      return res.status(409).json({ message: "Invoice does not belong to this devis", code: "acompte_invoice_mismatch" });
    }
    const result = await linkAcompteInvoiceTx({ devisId, invoiceId, invoiceDatePaid: invoice.datePaid ?? null });
    if (!result.ok) {
      if (result.code === "devis_not_found") return res.status(404).json({ message: "Devis not found" });
      if (result.code === "acompte_certificat_exists") {
        return res.status(409).json({
          message: `An acompte certificat (${result.certificateRef}) already covers this deposit — no facture d'acompte can be linked.`,
          code: "acompte_certificat_exists",
          certificatId: result.certificatId,
        });
      }
      return res.status(409).json({
        message: `Cannot link the facture d'acompte from state "${result.currentState}"`,
        code: "acompte_invalid_transition",
        currentState: result.currentState,
      });
    }
    res.json(result.devis);
  },
);

// Operators may supply the bank-transfer date when marking the deposit
// paid (e.g. backfilling a payment that landed yesterday). Defaults to
// "now" when omitted. The date must be an ISO-8601 string and not in
// the future.
const markPaidBodySchema = z
  .object({
    datePaid: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

router.post(
  "/api/devis/:id/acompte/mark-paid",
  requireAuth,
  validateRequest({ params: idParams, body: markPaidBodySchema }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    if (!devis.acompteRequired) {
      return res.status(409).json({ message: "Devis n'a pas d'acompte requis", code: "acompte_not_required" });
    }
    // Task #491 — no-invoice path: a devis whose deposit was raised via an
    // ACOMPTE CERTIFICAT never gets a facture d'acompte. When the state is
    // still 'pending' AND a live acompte certificat exists, allow
    // pending → paid directly with explicit provenance.
    let target = nextAcompteState(devis.acompteState, "mark_paid");
    let paidVia: "invoice" | "certificat_no_invoice" = "invoice";
    if (!target && devis.acompteState === "pending") {
      const certs = await storage.getCertificatsByProjectAndContractor(devis.projectId, devis.contractorId);
      const acompteCert = certs.find((c) => c.acompteDevisId === devisId && c.status !== "superseded");
      if (acompteCert) {
        target = nextAcompteState(devis.acompteState, "mark_paid_no_invoice");
        paidVia = "certificat_no_invoice";
      }
    }
    if (!target) {
      return res.status(409).json({
        message: `Cannot mark the acompte as paid from state "${devis.acompteState}". Link the facture d'acompte first (or generate the acompte certificat).`,
        code: "acompte_invalid_transition",
        currentState: devis.acompteState,
      });
    }
    const supplied = (req.body as { datePaid?: string }).datePaid;
    const paidAt = supplied ? new Date(supplied) : new Date();
    if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 60_000) {
      return res.status(400).json({ message: "Invalid datePaid (must be ISO-8601 and not in the future)" });
    }
    const updated = await storage.updateDevis(devisId, {
      acompteState: target,
      acomptePaidAt: paidAt,
      acomptePaidVia: paidVia,
    });
    res.json(updated);
  },
);

/**
 * Task #491 — one-click ACOMPTE (opening/deposit) certificat, no supplier
 * invoice. Preconditions: devis signed off by the client, acompte required
 * with a resolvable amount, lifecycle still 'pending' (an 'invoiced' devis
 * has a facture d'acompte and must use the invoice path), and no live
 * acompte certificat yet (DB partial unique index makes this race-free).
 *
 * The money is fixed here from the devis's own acompte spec — no retenue,
 * no prorata, no recoupment, no previous payments — and is never
 * re-resolved by the seal. TVA follows the devis's own HT→TTC ratio
 * (documentary evidence), matching what a facture d'acompte would state.
 */
router.post(
  "/api/devis/:id/acompte/generate-certificat",
  requireAuth,
  validateRequest({ params: idParams, body: z.object({}).strict().optional() }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    if (!devis.acompteRequired) {
      return res.status(409).json({ message: "Devis n'a pas d'acompte requis", code: "acompte_not_required" });
    }
    if (devis.status === "void" || devis.signOffStage === "void") {
      return res.status(409).json({ message: "Devis is void", code: "acompte_devis_void" });
    }
    if (devis.signOffStage !== "client_signed_off") {
      return res.status(409).json({
        message: "The devis must be signed by the client before generating the acompte certificat.",
        code: "acompte_devis_not_signed",
      });
    }
    if (devis.acompteState !== "pending") {
      return res.status(409).json({
        message:
          devis.acompteState === "invoiced"
            ? "A facture d'acompte is already linked — mark it paid via the invoice path instead."
            : `Cannot generate an acompte certificat from state "${devis.acompteState}".`,
        code: "acompte_invalid_transition",
        currentState: devis.acompteState,
      });
    }
    // Pre-lock sanity check only (friendly error before allocating a ref);
    // the authoritative amounts are re-derived from the LOCKED row inside
    // the transaction so a concurrent spec edit can't issue a stale amount.
    if (!resolveAcompteAmounts(devis)) {
      return res.status(409).json({
        message: "No acompte amount configured on the devis (set a % or an HT amount first).",
        code: "acompte_amount_missing",
      });
    }
    const existingCerts = await storage.getCertificatsByProjectAndContractor(devis.projectId, devis.contractorId);
    const existingAcompte = existingCerts.find((c) => c.acompteDevisId === devisId && c.status !== "superseded");
    if (existingAcompte) {
      return res.status(409).json({
        message: `An acompte certificat already exists for this devis (${existingAcompte.certificateRef}).`,
        code: "acompte_certificat_exists",
        certificateRef: existingAcompte.certificateRef,
        certificatId: existingAcompte.id,
      });
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const nextRef = await storage.getNextCertificateRef(devis.projectId);
        // One transaction, devis row locked FOR UPDATE: the state re-check,
        // the certificat INSERT and the resolved-amount persistence commit
        // together, so a concurrent link-invoice / mark-paid / second click
        // can neither slip between the guard and the insert nor leave a
        // live deposit certificat whose amount the recoupment engine
        // (which sums paid devis' acompteAmountHt) cannot see.
        const cert = await db.transaction(async (tx) => {
          const [locked] = await tx
            .select()
            .from(devisTable)
            .where(eq(devisTable.id, devisId))
            .for("update");
          // Re-validate EVERY eligibility condition from the locked row —
          // a concurrent edit may have cleared acompteRequired, voided the
          // devis, or moved the lifecycle on since the pre-lock read.
          if (
            !locked ||
            !locked.acompteRequired ||
            locked.status === "void" ||
            locked.signOffStage === "void" ||
            locked.acompteState !== "pending" ||
            locked.signOffStage !== "client_signed_off" ||
            // nextRef was allocated for the pre-lock project — a concurrent
            // reassignment would mis-sequence the certificate reference.
            locked.projectId !== devis.projectId ||
            locked.contractorId !== devis.contractorId
          ) {
            const e = new Error("acompte_state_changed");
            (e as Error & { acompteStateChanged?: boolean }).acompteStateChanged = true;
            throw e;
          }
          // Authoritative money: derived from the LOCKED row, not the
          // pre-lock read — a concurrent spec edit is either committed
          // before our lock (we see it) or blocked until we commit.
          const amounts = resolveAcompteAmounts(locked);
          if (!amounts) {
            const e = new Error("acompte_amount_missing");
            (e as Error & { acompteAmountMissing?: boolean }).acompteAmountMissing = true;
            throw e;
          }
          const tvaAmount = Math.round((amounts.amountTtc - amounts.amountHt) * 100) / 100;
          const impliedRate = amounts.amountHt > 0 ? Math.round((tvaAmount / amounts.amountHt) * 10000) / 100 : 0;
          const [created] = await tx
            .insert(certificats)
            .values({
              // All identity fields from the LOCKED row, never the pre-lock read.
              projectId: locked.projectId,
              contractorId: locked.contractorId,
              certificateRef: nextRef,
              dateIssued: new Date().toISOString().split("T")[0],
              totalWorksHt: amounts.amountHt.toFixed(2),
              pvMvAdjustment: "0.00",
              previousPayments: "0.00",
              retenueGarantie: "0.00",
              cumulativeProrataDeduction: "0.00",
              periodProrataDeduction: "0.00",
              cumulativeAcompteRecoupment: "0.00",
              periodAcompteRecoupment: "0.00",
              tvaRatePercent: impliedRate.toFixed(2),
              tvaAutoliquidation: false,
              tvaRateSource: "documentary",
              netToPayHt: amounts.amountHt.toFixed(2),
              tvaAmount: tvaAmount.toFixed(2),
              netToPayTtc: amounts.amountTtc.toFixed(2),
              notes: `Acompte (opening/deposit) on devis ${locked.devisCode} — no supplier invoice; recovered in full on the next certificat.`,
              acompteDevisId: devisId,
            })
            .returning();
          // Percent-only spec: persist the resolved HT amount atomically.
          if (locked.acompteAmountHt == null || !(parseFloat(locked.acompteAmountHt) > 0)) {
            await tx
              .update(devisTable)
              .set({ acompteAmountHt: amounts.amountHt.toFixed(2), updatedAt: sql`now()` })
              .where(eq(devisTable.id, devisId));
          }
          return created;
        });
        return res.status(201).json(cert);
      } catch (err) {
        if ((err as { acompteStateChanged?: boolean }).acompteStateChanged) {
          return res.status(409).json({
            message: "The devis changed while generating the acompte certificat — refresh and retry.",
            code: "acompte_state_changed",
          });
        }
        if ((err as { acompteAmountMissing?: boolean }).acompteAmountMissing) {
          return res.status(409).json({
            message: "No acompte amount configured on the devis (set a % or an HT amount first).",
            code: "acompte_amount_missing",
          });
        }
        const { code, constraint } = pgErrorInfo(err);
        if (code === "23505" && constraint === "certificats_acompte_devis_unique") {
          return res.status(409).json({
            message: "An acompte certificat already exists for this devis.",
            code: "acompte_certificat_exists",
          });
        }
        if (code === "23505" && attempt < 2) continue;
        throw err;
      }
    }
    return res.status(500).json({ message: "Could not allocate a certificate reference" });
  },
);

export default router;
