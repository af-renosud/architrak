/**
 * Admin DLQ surface for the background intake ingest queue (Task #230).
 *
 * Mirrors `admin-drive-uploads.ts` so the operator workflow is identical:
 *   GET  /api/admin/intake-jobs            — list rows (joined to the
 *                                            owning intake document), ?state=
 *   POST /api/admin/intake-jobs/:id/retry  — reset row to pending and
 *                                            trigger one immediate attempt
 */

import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { attemptIntakeJob } from "../services/intake/ingest-queue.service";
import { INTAKE_JOB_STATES } from "@shared/schema";

const router = Router();

const listQuerySchema = z
  .object({
    state: z.enum(INTAKE_JOB_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

router.get(
  "/api/admin/intake-jobs",
  requireAuth,
  validateRequest({ query: listQuerySchema }),
  async (req, res) => {
    try {
      const filter = req.query as z.infer<typeof listQuerySchema>;
      const rows = await storage.listIntakeJobs(filter);
      res.json({ rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Listing failed: ${message}` });
    }
  },
);

const retryParamsSchema = z.object({ id: z.coerce.number().int().positive() }).strict();

router.post(
  "/api/admin/intake-jobs/:id/retry",
  requireAuth,
  validateRequest({ params: retryParamsSchema }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof retryParamsSchema>;
    try {
      const existing = await storage.getIntakeJob(id);
      if (!existing) return res.status(404).json({ message: "Job not found", id });
      // Restrict retry to terminal-error rows. Resetting a `succeeded`
      // row would re-route an already-routed doc (creating a duplicate
      // draft); resetting an `in_flight` row would race the worker. The
      // sweeper handles ordinary `pending` rows on its own.
      if (existing.state !== "dead_letter" && existing.state !== "failed") {
        return res.status(409).json({
          message: `Job is in state "${existing.state}" — retry is only allowed for dead_letter / failed rows.`,
          id,
        });
      }
      const reset = await storage.resetIntakeJobForRetry(id);
      if (!reset) return res.status(500).json({ message: "Reset failed", id });
      // Reset the owning intake document back to a pre-analysis state so
      // the pipeline runs cleanly and the UI doesn't show a stale
      // failed/parked verdict during the retry.
      await storage.updateProjectIntakeDocument(existing.intakeDocumentId, {
        analysisState: "pending",
        routingState: "unrouted",
      });
      // Fire one immediate attempt synchronously so the admin UI sees the
      // resulting state in the same round-trip. attemptIntakeJob catches
      // its own errors and writes them back to the row.
      await attemptIntakeJob(id);
      const after = await storage.getIntakeJob(id);
      res.json({ id, before: existing, after });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Retry failed: ${message}`, id });
    }
  },
);

export default router;
