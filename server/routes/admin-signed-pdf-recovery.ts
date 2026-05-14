/**
 * Task #207 — Admin DLQ-style surface to recover signed devis PDFs
 * whose post-`envelope.signed` persistence dropped on the original
 * webhook (Archisign or object storage briefly unhealthy, sweeper
 * exhausted its retries, etc).
 *
 *   GET  /api/admin/signed-pdf-recovery            — list candidates
 *   POST /api/admin/signed-pdf-recovery/:id/retry  — clear retry
 *                                                    bookkeeping and
 *                                                    re-run the persist
 *                                                    + Drive enqueue path
 *
 * Retention-breached envelopes (rows present in
 * `signed_pdf_retention_breaches`) are surfaced read-only — Archisign
 * has already purged the bytes so retrying cannot succeed.
 */

import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { persistSignedDevisPdf } from "../services/devis-signed-pdf.service";

const router = Router();

router.get("/api/admin/signed-pdf-recovery", requireAuth, async (_req, res) => {
  try {
    const rows = await storage.listSignedPdfRecoveryCandidates();
    res.json({ rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Listing failed: ${message}` });
  }
});

const retryParamsSchema = z.object({ id: z.coerce.number().int().positive() }).strict();

router.post(
  "/api/admin/signed-pdf-recovery/:id/retry",
  requireAuth,
  validateRequest({ params: retryParamsSchema }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof retryParamsSchema>;
    try {
      // Tightly gate the retry on the SAME predicate the list view uses
      // (stage=client_signed_off + envelope present + storage_key NULL).
      // A direct API caller cannot bypass the dropdown by guessing a
      // devisId — this also implicitly checks existence.
      const candidates = await storage.listSignedPdfRecoveryCandidates();
      const candidate = candidates.find((c) => c.id === id);
      if (!candidate) {
        return res.status(409).json({
          message:
            "Devis is not a signed-PDF recovery candidate (already persisted, missing envelope, or not at client_signed_off).",
          id,
        });
      }
      if (candidate.retentionBreachedAt) {
        return res.status(409).json({
          message:
            "Envelope retention breached — Archisign has purged the signed bytes; recovery is no longer possible.",
          id,
          incidentRef: candidate.retentionIncidentRef,
        });
      }

      // Reset retry bookkeeping so the row is "fresh" again. If this
      // single attempt fails, the sweeper picks the row up on its next
      // pass with a clean attempt budget — matching the drive-uploads
      // admin retry semantics.
      await storage.clearSignedPdfRetry(id);
      await persistSignedDevisPdf(id);

      const after = await storage.getDevis(id);
      res.json({
        id,
        recovered: Boolean(after?.signedPdfStorageKey),
        signedPdfStorageKey: after?.signedPdfStorageKey ?? null,
        signedPdfLastError: after?.signedPdfLastError ?? null,
        signedPdfRetryAttempts: after?.signedPdfRetryAttempts ?? 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Retry failed: ${message}`, id });
    }
  },
);

export default router;
