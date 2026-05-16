/**
 * Admin diagnostics for the Pennylane integration (Task #214).
 *
 *   GET  /api/admin/pennylane/me            — proves credentials + scopes
 *                                             are alive (sandbox or prod).
 *   GET  /api/admin/pennylane/pushes        — list rows from the queue
 *                                             (optional ?state=, ?kind=).
 *   POST /api/admin/pennylane/pushes/:id/retry
 *                                           — reset dead_letter/failed row,
 *                                             trigger one inline attempt.
 *
 * The push list + retry mirror the drive-uploads admin shape so the
 * operator workflow is the same. We intentionally keep this router
 * separate from the public API surface — it is for operators only.
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { storage } from "../storage";
import {
  isPennylaneConfigured,
  isPennylaneDryRun,
  isPennylanePushEnabled,
  pingPennylane,
} from "../services/pennylane/client";
import {
  attemptPennylanePush,
} from "../services/pennylane/push-queue.service";
import {
  PENNYLANE_PUSH_KINDS,
  PENNYLANE_PUSH_STATES,
} from "@shared/schema";

const router = Router();

router.get("/api/admin/pennylane/me", requireAuth, async (_req, res) => {
  if (!isPennylaneConfigured()) {
    return res.status(503).json({
      ok: false,
      configured: false,
      pushEnabled: false,
      dryRun: false,
      message: "PENNYLANE_API_KEY not configured",
    });
  }
  try {
    const me = await pingPennylane();
    res.json({
      ok: true,
      configured: true,
      pushEnabled: isPennylanePushEnabled(),
      dryRun: isPennylaneDryRun(),
      me,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({
      ok: false,
      configured: true,
      pushEnabled: isPennylanePushEnabled(),
      dryRun: isPennylaneDryRun(),
      message,
    });
  }
});

const listQuerySchema = z
  .object({
    state: z.enum(PENNYLANE_PUSH_STATES).optional(),
    kind: z.enum(PENNYLANE_PUSH_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

router.get(
  "/api/admin/pennylane/pushes",
  requireAuth,
  validateRequest({ query: listQuerySchema }),
  async (req, res) => {
    try {
      const filter = req.query as z.infer<typeof listQuerySchema>;
      const rows = await storage.listPennylanePushes(filter);
      res.json({
        rows,
        enabled: isPennylanePushEnabled(),
        configured: isPennylaneConfigured(),
        dryRun: isPennylaneDryRun(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Listing failed: ${message}` });
    }
  },
);

const retryParamsSchema = z
  .object({ id: z.coerce.number().int().positive() })
  .strict();

router.post(
  "/api/admin/pennylane/pushes/:id/retry",
  requireAuth,
  validateRequest({ params: retryParamsSchema }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof retryParamsSchema>;
    try {
      const existing = await storage.getPennylanePush(id);
      if (!existing) {
        return res.status(404).json({ message: "Push not found", id });
      }
      if (existing.state !== "dead_letter" && existing.state !== "failed") {
        return res.status(409).json({
          message: `Push is in state "${existing.state}" — retry is only allowed for dead_letter / failed rows.`,
          id,
        });
      }
      const reset = await storage.resetPennylanePushForRetry(id);
      if (!reset) {
        return res.status(500).json({ message: "Reset failed", id });
      }
      await attemptPennylanePush(id);
      const after = await storage.getPennylanePush(id);
      res.json({ id, before: existing, after });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Retry failed: ${message}`, id });
    }
  },
);

export default router;
