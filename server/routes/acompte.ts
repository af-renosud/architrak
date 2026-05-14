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
import { nextAcompteState } from "../services/acompte.service";

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
    const invoice = await storage.getInvoice(invoiceId);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.devisId !== devisId) {
      return res.status(409).json({ message: "Invoice does not belong to this devis", code: "acompte_invoice_mismatch" });
    }
    const target = nextAcompteState(devis.acompteState, "link_invoice");
    if (!target) {
      return res.status(409).json({
        message: `Impossible de lier la facture d'acompte depuis l'état "${devis.acompteState}"`,
        code: "acompte_invalid_transition",
        currentState: devis.acompteState,
      });
    }
    // If the linked invoice already has a payment date, jump straight to 'paid'.
    const finalState = invoice.datePaid ? "paid" : target;
    const updated = await storage.updateDevis(devisId, {
      acompteInvoiceId: invoiceId,
      acompteState: finalState,
      acomptePaidAt: invoice.datePaid ? new Date() : null,
    });
    res.json(updated);
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
    const target = nextAcompteState(devis.acompteState, "mark_paid");
    if (!target) {
      return res.status(409).json({
        message: `Impossible de marquer l'acompte payé depuis l'état "${devis.acompteState}". Lier d'abord la facture d'acompte.`,
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
    });
    res.json(updated);
  },
);

export default router;
