/**
 * Manual signed-copy pathway — secondary to the Archisign flow.
 *
 *   POST /api/devis/:id/record-signed-copy   (multipart: file + fields)
 *
 * Authenticates a devis as signed by uploading the signed PDF directly.
 * Covers the cases the sealed Archisign-only flow cannot: a paper/wet
 * signature, a devis signed inside Archisign but OUTSIDE the
 * ArchiDoc↔Archisign integration (no envelope correlated to this devis),
 * or another e-sign provider entirely.
 *
 * Deliberate differences from the webhook path:
 *   - Requires an authenticated operator + a mandatory justification
 *     note; both are persisted for audit (manualSignoffBy/Note/At).
 *   - Provenance is recorded as signedOffVia = "manual_upload" so a
 *     manually attested signature is never confused with a
 *     cryptographically verified Archisign event (no
 *     identityVerification block is fabricated).
 *   - The §5.3.1 work_authorised webhook to Archidoc is NOT fired: that
 *     contract clause echoes Archisign's identityVerification verbatim,
 *     which does not exist here. The response flags this so the UI can
 *     tell the operator authorisation must be handled out-of-band.
 *   - The signed PDF is persisted to the SAME deterministic object key
 *     and mirrored to Drive through the SAME queue as the webhook path,
 *     so every downstream consumer of signedPdfStorageKey keeps working.
 *
 * Allowed source stages: approved_for_signing, sent_to_client. Earlier
 * stages have not passed internal checks; client_signed_off and the
 * non-linear stages (void, client_rejected, …) are rejected.
 */

import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { upload, assertPdfMagic } from "../middleware/upload";
import { uploadDocumentAtKey, buildSignedDevisObjectName } from "../storage/object-storage";
import { enqueueDriveUpload } from "../services/drive/upload-queue.service";
import { signedPdfFileName } from "../services/devis-signed-pdf.service";
import type { InsertDevis } from "@shared/schema";

const router = Router();

export const MANUAL_SIGNOFF_NOTE_MIN_LEN = 10;

export const MANUAL_SIGNOFF_ALLOWED_STAGES = new Set<string>([
  "approved_for_signing",
  "sent_to_client",
]);

const bodySchema = z.object({
  note: z
    .string()
    .trim()
    .min(
      MANUAL_SIGNOFF_NOTE_MIN_LEN,
      `A justification note of at least ${MANUAL_SIGNOFF_NOTE_MIN_LEN} characters is required for the audit trail.`,
    ),
  externalReference: z.string().trim().max(200).optional(),
});

router.post(
  "/api/devis/:id/record-signed-copy",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      const devisId = Number(req.params.id);
      if (!Number.isInteger(devisId) || devisId <= 0) {
        return res.status(400).json({ message: "Invalid devis id" });
      }

      const parsed = bodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          message: parsed.error.errors[0]?.message ?? "Invalid request body",
          code: "manual_signoff_invalid_body",
        });
      }
      const { note, externalReference } = parsed.data;

      const file = req.file;
      if (!file) {
        return res.status(400).json({ message: "No signed PDF provided", code: "manual_signoff_no_file" });
      }
      try {
        assertPdfMagic(file.buffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(415).json({ message, code: "manual_signoff_not_pdf" });
      }

      const d = await storage.getDevis(devisId);
      if (!d) return res.status(404).json({ message: "Devis not found" });

      const stage = d.signOffStage ?? "";
      if (stage === "client_signed_off") {
        return res.status(409).json({
          message: "This devis is already recorded as signed.",
          code: "manual_signoff_already_signed",
        });
      }
      if (!MANUAL_SIGNOFF_ALLOWED_STAGES.has(stage)) {
        return res.status(409).json({
          message:
            "A signed copy can only be recorded once the devis has been approved for signing " +
            "(stages: approved for signing, sent to client). Current stage: " +
            `"${stage || "unknown"}".`,
          code: "manual_signoff_stage_not_allowed",
        });
      }

      // 1. Persist the uploaded signed PDF at the SAME deterministic key
      //    the webhook path uses — downstream consumers (signed-pdf GET
      //    route, Drive mirror, recovery admin) all key off
      //    signedPdfStorageKey and keep working unchanged.
      const objectName = buildSignedDevisObjectName(d.projectId, devisId);
      const storageKey = await uploadDocumentAtKey(objectName, file.buffer, "application/pdf");

      // 2. Transition + provenance in one update. signedOffVia =
      //    "manual_upload" is the durable marker distinguishing this from
      //    a webhook-driven sign-off.
      const update: Partial<InsertDevis> = {
        signOffStage: "client_signed_off",
        signedOffVia: "manual_upload",
        manualSignoffAt: new Date(),
        manualSignoffBy: String(req.session.userId),
        manualSignoffNote: note,
        manualSignoffExternalRef: externalReference || null,
        signedPdfStorageKey: storageKey,
      };
      await storage.updateDevis(devisId, update);

      // 3. Mirror to the per-lot Drive folder through the same idempotent
      //    queue as the webhook path (no-op when the flag is off).
      try {
        await enqueueDriveUpload({
          docKind: "devis_signed",
          docId: d.id,
          projectId: d.projectId,
          lotId: d.lotId ?? null,
          sourceStorageKey: storageKey,
          displayName: signedPdfFileName(d),
          seedDevisCode: d.devisCode,
        });
      } catch (err) {
        // Non-fatal: the sign-off itself is committed; the Drive mirror
        // can be retried from the admin Drive-uploads surface.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ManualSignoff] devis ${devisId}: drive enqueue failed: ${message}`);
      }

      console.log(
        `[ManualSignoff] devis ${devisId} (${d.devisCode}) marked client_signed_off via manual upload ` +
          `by user ${req.session.userId}` +
          (externalReference ? ` (external ref: ${externalReference})` : ""),
      );

      const after = await storage.getDevis(devisId);
      return res.status(200).json({
        ok: true,
        devisId,
        signOffStage: after?.signOffStage ?? "client_signed_off",
        signedOffVia: "manual_upload",
        signedPdfStorageKey: storageKey,
        // The Archidoc work-authorisation webhook is contract-bound to a
        // verified Archisign envelope.signed event and is NOT fired for a
        // manual attestation — surface that so the operator knows.
        workAuthorisationSent: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ManualSignoff] failed: ${message}`);
      return res.status(500).json({ message: `Recording the signed copy failed: ${message}` });
    }
  },
);

export default router;
