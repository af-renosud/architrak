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

      const { requeueIntakeDocument } = await import("../services/intake/ingest-queue.service");
      if (!(await requeueIntakeDocument(id, { rejectConfirmedEvidence: true }))) {
        return res.status(409).json({ message: "This document is immutable payment evidence and cannot be re-analyzed." });
      }
      res.json({ id, status: "reanalysis_triggered" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Re-analysis failed: ${message}` });
    }
  },
);

// Task #449 — server-side precondition guard for the reviewed attach flows.
// Only a PARKED, already-analysed intake document whose AI classification is
// the exact evidence type may be attached — anything else (unrouted /
// still-analyzing docs the queue may yet route, already-routed docs, or a
// quotation/invoice masquerading as evidence) is rejected regardless of what
// the client sent.
function validateEvidenceAttachState(
  doc: { promotedId: number | null; promotedKind: string | null; routingState: string; extractedData: unknown },
  expectedType: "situation" | "commande",
): string | null {
  if (doc.promotedId) {
    return `Already routed into ${doc.promotedKind ?? "a record"} #${doc.promotedId}.`;
  }
  if (doc.routingState !== "parked") {
    return `Only parked documents can be attached (this one is "${doc.routingState}").`;
  }
  const type = (doc.extractedData as { documentType?: unknown } | null)?.documentType;
  if (type !== expectedType) {
    return `This document was classified as "${typeof type === "string" ? type : "unknown"}", not "${expectedType}" — re-analyze or route it through the matching flow.`;
  }
  return null;
}

// Task #449 — reviewed one-click attach flows for parked evidence PDFs.
//
// A parked intake document classified as a "situation" (signed Situation de
// travaux) is attached to an EXISTING situations row picked by the operator;
// a parked "commande" (signed Bon de commande) is retained as a
// marche_documents evidence row against the picked devis. Both are
// human-reviewed decisions, so the attachment is confirmed immediately
// (unlike pipeline auto-attachments, which stay unconfirmed drafts).

router.post(
  "/api/intake-documents/:id/attach-situation",
  validateRequest({
    params: intakeIdParams,
    body: z.object({
      situationId: z.coerce.number().int().positive(),
      reviewedBy: z.string().optional(),
    }),
  }),
  async (req, res) => {
    try {
      const doc = await storage.getProjectIntakeDocument(Number(req.params.id));
      if (!doc) return res.status(404).json({ message: "Document not found" });
      const stateError = validateEvidenceAttachState(doc, "situation");
      if (stateError) return res.status(409).json({ message: stateError });
      const situation = await storage.getSituation(req.body.situationId);
      if (!situation) return res.status(404).json({ message: "Situation not found" });
      const devis = await storage.getDevis(situation.devisId);
      if (!devis || devis.projectId !== doc.projectId) {
        return res.status(409).json({ message: "That situation belongs to a different project than this document." });
      }
      const reviewedBy = req.body.reviewedBy || "operator";
      // Single transaction: claim the parked intake doc (parked→routed,
      // promoted_id still NULL) AND attach the PDF (source_storage_key still
      // NULL), guarded by the partial unique index on
      // situations.source_intake_document_id. Concurrent duplicates,
      // double-submits, and mid-flight failures all resolve to a conflict
      // or a clean rollback — never a half-attached state.
      const result = await storage.attachSituationSourceAndRouteIntake({
        situationId: situation.id,
        intakeDocumentId: doc.id,
        sourceStorageKey: doc.storageKey,
        sourceFileName: doc.fileName,
        sourceUploadedBy: reviewedBy,
        confirmed: true,
        confirmedBy: reviewedBy,
        intakeNote: `Attached to situation n°${situation.situationNumber} by ${reviewedBy}.`,
        existingIntakeNotes: doc.notes,
        expectedRoutingState: "parked",
      });
      if ("conflict" in result) {
        return res.status(409).json({ message: result.conflict });
      }
      res.json({ situation: result.situation });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Attach failed: ${message}` });
    }
  },
);

router.post(
  "/api/intake-documents/:id/attach-commande",
  validateRequest({
    params: intakeIdParams,
    body: z.object({
      devisId: z.coerce.number().int().positive(),
      reviewedBy: z.string().optional(),
    }),
  }),
  async (req, res) => {
    try {
      const doc = await storage.getProjectIntakeDocument(Number(req.params.id));
      if (!doc) return res.status(404).json({ message: "Document not found" });
      const stateError = validateEvidenceAttachState(doc, "commande");
      if (stateError) return res.status(409).json({ message: stateError });
      const devis = await storage.getDevis(req.body.devisId);
      if (!devis || devis.projectId !== doc.projectId) {
        return res.status(409).json({ message: "That devis belongs to a different project than this document." });
      }
      const reviewedBy = req.body.reviewedBy || "operator";
      // Single transaction: create the confirmed evidence row (unique per
      // intake doc) and claim the parked intake doc, or conflict.
      const result = await storage.createMarcheDocumentAndRouteIntake({
        data: {
          projectId: doc.projectId,
          kind: "commande",
          storageKey: doc.storageKey,
          fileName: doc.fileName,
          devisId: devis.id,
          marcheId: devis.marcheId ?? null,
          sourceIntakeDocumentId: doc.id,
          extractedData: doc.extractedData ?? null,
          uploadedBy: reviewedBy,
        },
        confirmedBy: reviewedBy,
        intakeNote: `Retained as bon de commande evidence on devis ${devis.devisCode} by ${reviewedBy}.`,
        existingIntakeNotes: doc.notes,
        expectedRoutingState: "parked",
      });
      if ("conflict" in result) {
        return res.status(409).json({ message: result.conflict });
      }
      res.json({ marcheDocument: result.marcheDocument });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Attach failed: ${message}` });
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
      if (await storage.getAcompteNoInvoicePaymentBySource(id)) {
        return res.status(409).json({
          message: "This document is immutable evidence for a confirmed deposit payment and cannot be deleted.",
        });
      }

      // Gmail-mirrored docs: tombstone the source email document FIRST so a
      // concurrent/later email-document update cannot resurrect this intake
      // row via mirrorEmailDocumentToIntake.
      if (doc.sourceEmailDocumentId) {
        await storage.tombstoneEmailDocumentIntake(doc.sourceEmailDocumentId);
      }

      // Delete the database row first. Its RESTRICT evidence FK is the
      // concurrency-safe decision; only a committed deletion may erase bytes.
      await storage.deleteProjectIntakeDocument(id);
      try {
        await deleteDocument(doc.storageKey);
      } catch (err) {
        console.warn(`[intake] Failed to delete storage object for intake doc ${id} (continuing):`, err);
      }
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
