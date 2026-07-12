/**
 * Task #279 / #283 — Admin ops surface for Archisign §3.5.1.1 rendering
 * drift, both halves of the /envelopes/create `emailRendering` echo:
 *
 *   - `subjectApplied=false` for a subject we sent — the signer invitation
 *     went out under Archisign's DEFAULT subject instead of ours (#279).
 *   - `bodyApplied=false` for a non-empty body we sent — the architect's
 *     personal note vanished from the signer invitation despite the
 *     in-force §3.5.1.1(b) RENDERED election (#283).
 *
 * Drift is non-blocking (the envelope proceeds), persisted on the devis row
 * (`archisign_subject_drift_at` / `archisign_body_drift_at`), and listed
 * here so operators see it where they already look (/admin/ops/*) rather
 * than only in server logs.
 *
 *   GET /api/admin/archisign-rendering-drift — list affected devis
 *
 * Read-only by design: each flag clears itself when a FRESH envelope for
 * the same devis comes back without that drift (e.g. after Archisign fixes
 * their rendering), and any escalation happens off-app per contract §7.2.
 */

import { Router } from "express";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";

const router = Router();

router.get(
  "/api/admin/archisign-rendering-drift",
  requireAuth,
  async (_req, res) => {
    try {
      const rows = await storage.listArchisignRenderingDriftDevis();
      res.json({ rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Listing failed: ${message}` });
    }
  },
);

export default router;
