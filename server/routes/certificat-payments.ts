import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertCertificatPaymentSchema } from "@shared/schema";
import { validateRequest } from "../middleware/validate";
import {
  logPayment,
  correctPayment,
  removePayment,
  reconcilePayments,
  PaymentsLockedError,
  CertificatSupersededPaymentError,
  CertificatDraftPaymentError,
  PaymentNotFoundError,
} from "../services/certificat-payments.service";

/**
 * Task #465 — structured client-payment logging routes.
 *
 * Payments are recorded facts: partial payments accumulate; the certificat
 * flips to `paid` automatically when coverage reaches the TTC total (inside
 * the atomic storage transaction, roundCurrency compare). Over-payment is
 * accepted but flagged in the response so the UI can warn. The ledger locks
 * once fully paid; drafts and superseded certificats are refused.
 */
const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });

function mapPaymentError(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof PaymentsLockedError) {
    return { status: 409, body: { code: "PAYMENTS_LOCKED", message: err.message } };
  }
  if (err instanceof CertificatSupersededPaymentError) {
    return { status: 409, body: { code: "CERTIFICAT_SUPERSEDED", message: err.message } };
  }
  if (err instanceof CertificatDraftPaymentError) {
    return { status: 409, body: { code: "CERTIFICAT_DRAFT", message: err.message } };
  }
  if (err instanceof PaymentNotFoundError) {
    return { status: 404, body: { message: err.message } };
  }
  return null;
}

// Ledger + reconciliation for one certificat.
router.get("/api/certificats/:id/payments", validateRequest({ params: idParams }), async (req, res) => {
  const cert = await storage.getCertificat(Number(req.params.id));
  if (!cert) return res.status(404).json({ message: "Certificat not found" });
  const payments = await storage.getCertificatPayments(cert.id);
  const audits = await storage.getCertificatPaymentAudits(cert.id);
  res.json({ payments, audits, ...reconcilePayments(cert, payments) });
});

// All payments of a project's certificats (list/summary badges).
router.get("/api/projects/:projectId/certificat-payments", validateRequest({ params: projectIdParams }), async (req, res) => {
  res.json(await storage.getCertificatPaymentsByProject(Number(req.params.projectId)));
});

router.post(
  "/api/certificats/:id/payments",
  validateRequest({ params: idParams, body: insertCertificatPaymentSchema }),
  async (req, res) => {
    const cert = await storage.getCertificat(Number(req.params.id));
    if (!cert) return res.status(404).json({ message: "Certificat not found" });
    try {
      const { payment, state } = await logPayment(cert.id, req.body);
      return res.status(201).json({ payment, ...state });
    } catch (err) {
      const mapped = mapPaymentError(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      throw err;
    }
  },
);

router.patch(
  "/api/certificat-payments/:id",
  validateRequest({ params: idParams, body: insertCertificatPaymentSchema.partial() }),
  async (req, res) => {
    try {
      const { payment, state } = await correctPayment(Number(req.params.id), req.body, req.body.loggedBy ?? null);
      return res.json({ payment, ...state });
    } catch (err) {
      const mapped = mapPaymentError(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      throw err;
    }
  },
);

router.delete(
  "/api/certificat-payments/:id",
  validateRequest({ params: idParams, body: z.object({ changedBy: z.string().trim().max(200).optional() }).optional() }),
  async (req, res) => {
    try {
      const { state } = await removePayment(Number(req.params.id), req.body?.changedBy ?? null);
      return res.json({ deleted: true, ...state });
    } catch (err) {
      const mapped = mapPaymentError(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      throw err;
    }
  },
);

export default router;
