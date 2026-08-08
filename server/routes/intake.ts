import { Router } from "express";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { MulterError } from "multer";
import { storage } from "../storage";
import { intakeUpload } from "../middleware/upload";
import { uploadDocument, getDocumentStream, deleteDocument } from "../storage/object-storage";
import { validateRequest } from "../middleware/validate";

/**
 * Unified document intake (Task #229) — the single "front door".
 *
 * One project-level upload endpoint accepts ANY financial document (devis,
 * facture, situation, …) without the team pre-classifying it. The file is
 * stored and an intake row is parked in a `pending` state; AI classification,
 * extraction, deduplication and routing into typed records are later tasks.
 *
 * Email attachments reach the same intake list through the email-document
 * sync path (see storage.mirrorEmailDocumentToIntake), so this router only
 * owns the manual-upload door plus the read/list/download surfaces.
 */
const router = Router();

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const intakeIdParams = z.object({ id: z.coerce.number().int().positive() });
const intakeUploadBodySchema = z.object({
  uploadedBy: z.string().optional(),
  notes: z.string().optional(),
});

router.get(
  "/api/projects/:projectId/intake",
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    const includeVoid = req.query.includeVoid === "true";
    const docs = await storage.getProjectIntakeDocuments(Number(req.params.projectId), { includeVoid });
    res.json(docs);
  },
);

function intakeUploadSingle(req: Request, res: Response, next: NextFunction) {
  intakeUpload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const message =
        err instanceof MulterError
          ? err.code === "LIMIT_FILE_SIZE"
            ? "File too large (max 25 MB)."
            : err.message
          : err instanceof Error
            ? err.message
            : "Upload failed";
      return res.status(400).json({ message });
    }
    next();
  });
}

router.post(
  "/api/projects/:projectId/intake/upload",
  intakeUploadSingle,
  validateRequest({ params: projectIdParams, body: intakeUploadBodySchema }),
  async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      const file = req.file;
      if (!file) return res.status(400).json({ message: "No file provided" });

      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const storageKey = await uploadDocument(projectId, file.originalname, file.buffer, file.mimetype);
      const doc = await storage.createProjectIntakeDocument({
        projectId,
        fileName: file.originalname,
        storageKey,
        mimeType: file.mimetype || null,
        fileSize: file.size ?? null,
        source: "manual",
        analysisState: "pending",
        routingState: "unrouted",
        uploadedBy: req.body.uploadedBy || "manual",
        notes: req.body.notes || null,
      });
      // Task #230 — kick off background dedup → classify → route. Inline
      // first attempt fires inside enqueue; failures self-heal via sweeper.
      const { enqueueIntakeJob } = await import("../services/intake/ingest-queue.service");
      void enqueueIntakeJob(doc.id);
      res.status(201).json(doc);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Upload failed: ${message}` });
    }
  },
);

router.post(
  "/api/intake-documents/:id/reanalyze",
  validateRequest({ params: intakeIdParams }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const doc = await storage.getProjectIntakeDocument(id);
      if (!doc) return res.status(404).json({ message: "Document not found" });

      // Reset the user-facing state so the UI doesn't show a stale
      // failed/parked verdict while the pipeline re-runs.
      await storage.updateProjectIntakeDocument(id, {
        analysisState: "pending",
        routingState: "unrouted",
      });

      // Reset the queue row (if any) back to a fresh pending state, then
      // fire one immediate attempt. enqueueIntakeJob is idempotent and
      // (re)creates the row if it was never made.
      const existingJob = await storage.getIntakeJobByDocumentId(id);
      const { enqueueIntakeJob, attemptIntakeJob } = await import("../services/intake/ingest-queue.service");
      if (existingJob) {
        await storage.resetIntakeJobForRetry(existingJob.id);
        void attemptIntakeJob(existingJob.id);
      } else {
        void enqueueIntakeJob(id);
      }
      res.json({ id, status: "reanalysis_triggered" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Re-analysis failed: ${message}` });
    }
  },
);

router.delete(
  "/api/intake-documents/:id",
  validateRequest({ params: intakeIdParams }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const doc = await storage.getProjectIntakeDocument(id);
      if (!doc) return res.status(404).json({ message: "Document not found" });

      // A document that has already been routed into a typed record (devis /
      // invoice) is the source file of that record — deleting it from intake
      // would orphan the draft. The user must delete the typed record first.
      if (doc.promotedId) {
        return res.status(409).json({
          message: `This document was routed into ${doc.promotedKind ?? "a record"} #${doc.promotedId}. Delete that record first, then remove the intake document.`,
        });
      }

      // Gmail-mirrored docs: tombstone the source email document FIRST so a
      // concurrent/later email-document update cannot resurrect this intake
      // row via mirrorEmailDocumentToIntake.
      if (doc.sourceEmailDocumentId) {
        await storage.tombstoneEmailDocumentIntake(doc.sourceEmailDocumentId);
      }

      // Best-effort storage cleanup — a missing/failed object delete must not
      // block removing the row (the object is unreachable without it anyway).
      try {
        await deleteDocument(doc.storageKey);
      } catch (err) {
        console.warn(`[intake] Failed to delete storage object for intake doc ${id} (continuing):`, err);
      }
      await storage.deleteProjectIntakeDocument(id);
      console.log(`[intake] Deleted intake document ${id} ("${doc.fileName}") from project ${doc.projectId}`);
      res.json({ id, deleted: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Delete failed: ${message}` });
    }
  },
);

router.get(
  "/api/intake-documents/:id/download",
  validateRequest({ params: intakeIdParams }),
  async (req, res) => {
    try {
      const doc = await storage.getProjectIntakeDocument(Number(req.params.id));
      if (!doc) return res.status(404).json({ message: "Document not found" });

      const { stream, contentType, size } = await getDocumentStream(doc.storageKey);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${doc.fileName}"`);
      if (size) res.setHeader("Content-Length", String(size));
      stream.pipe(res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Download failed: ${message}` });
    }
  },
);

export default router;
