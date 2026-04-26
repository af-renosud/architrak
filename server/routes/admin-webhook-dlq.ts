/**
 * Admin DLQ surface for outbound Archidoc webhook deliveries (AT5).
 *
 * Two endpoints:
 *   GET  /api/admin/webhook-dlq           — list rows, optional ?state=
 *   POST /api/admin/webhook-dlq/:id/retry — reset row to pending and
 *                                            trigger one immediate
 *                                            attempt (eventId preserved).
 *
 * The retry endpoint preserves `eventId` so the receiver-side
 * idempotency contract still holds (G6: Archidoc dedups on eventId).
 * That means an admin retry of a previously-delivered-then-flagged-
 * failed row safely 200s as `deduplicated:true` rather than creating
 * a phantom downstream record.
 */

import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { attemptDelivery } from "../services/webhook-delivery";
import { WEBHOOK_DELIVERY_STATES } from "@shared/schema";

const router = Router();

const listQuerySchema = z
  .object({
    state: z.enum(WEBHOOK_DELIVERY_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

router.get(
  "/api/admin/webhook-dlq",
  requireAuth,
  validateRequest({ query: listQuerySchema }),
  async (req, res) => {
    try {
      const filter = req.query as z.infer<typeof listQuerySchema>;
      const rows = await storage.listWebhookDeliveriesOut({
        state: filter.state,
        limit: filter.limit,
        offset: filter.offset,
      });
      res.json({ rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Listing failed: ${message}` });
    }
  },
);

const retryParamsSchema = z
  .object({
    id: z.coerce.number().int().positive(),
  })
  .strict();

router.post(
  "/api/admin/webhook-dlq/:id/retry",
  requireAuth,
  validateRequest({ params: retryParamsSchema }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof retryParamsSchema>;
    try {
      const existing = await storage.getWebhookDeliveryOutById(id);
      if (!existing) {
        return res.status(404).json({ message: "Delivery not found", id });
      }
      const reset = await storage.resetWebhookDeliveryForRetry(id);
      if (!reset) {
        return res.status(500).json({ message: "Reset failed", id });
      }
      // Trigger one immediate attempt synchronously so the admin UI
      // sees the new state in the same round-trip. The orchestrator
      // catches its own errors and persists them to the row.
      const after = await attemptDelivery(id);
      res.json({ id, before: existing, after });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Retry failed: ${message}`, id });
    }
  },
);

export default router;
