/**
 * Admin DLQ surface for the Drive auto-upload queue (Task #198).
 *
 * Mirrors `admin-webhook-dlq.ts` so the operator workflow is the same:
 *   GET  /api/admin/drive-uploads            — list rows, optional ?state=
 *   GET  /api/admin/drive-uploads/ping       — service-account health check
 *   POST /api/admin/drive-uploads/:id/retry  — reset row to pending and
 *                                               trigger one immediate attempt
 */

import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { attemptDriveUpload } from "../services/drive/upload-queue.service";
import { pingDrive, isDriveAutoUploadEnabled } from "../services/drive/client";
import { DRIVE_UPLOAD_STATES } from "@shared/schema";

const router = Router();

const listQuerySchema = z
  .object({
    state: z.enum(DRIVE_UPLOAD_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

router.get(
  "/api/admin/drive-uploads",
  requireAuth,
  validateRequest({ query: listQuerySchema }),
  async (req, res) => {
    try {
      const filter = req.query as z.infer<typeof listQuerySchema>;
      const rows = await storage.listDriveUploads(filter);
      res.json({ rows, enabled: isDriveAutoUploadEnabled() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Listing failed: ${message}` });
    }
  },
);

router.get("/api/admin/drive-uploads/ping", requireAuth, async (_req, res) => {
  const result = await pingDrive();
  res.json(result);
});

const retryParamsSchema = z.object({ id: z.coerce.number().int().positive() }).strict();

router.post(
  "/api/admin/drive-uploads/:id/retry",
  requireAuth,
  validateRequest({ params: retryParamsSchema }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof retryParamsSchema>;
    try {
      const existing = await storage.getDriveUpload(id);
      if (!existing) return res.status(404).json({ message: "Upload not found", id });
      // Restrict retry to terminal-error rows (architect review of
      // Task #198). Resetting a `succeeded` row would create a
      // duplicate Drive copy; resetting an `in_flight` row would race
      // the worker that's currently uploading. The sweeper handles
      // ordinary `pending` rows on its own.
      if (existing.state !== "dead_letter" && existing.state !== "failed") {
        return res.status(409).json({
          message: `Upload is in state "${existing.state}" — retry is only allowed for dead_letter / failed rows.`,
          id,
        });
      }
      const reset = await storage.resetDriveUploadForRetry(id);
      if (!reset) return res.status(500).json({ message: "Reset failed", id });
      // Fire one immediate attempt synchronously so the admin UI sees
      // the resulting state in the same round-trip. attemptDriveUpload
      // catches its own errors and writes them back to the row.
      await attemptDriveUpload(id);
      const after = await storage.getDriveUpload(id);
      res.json({ id, before: existing, after });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Retry failed: ${message}`, id });
    }
  },
);

export default router;
