/**
 * Task #650 — Planning Envelope API routes.
 *
 * All routes require authentication. Validation is via Zod.
 * Internal errors are hidden from responses.
 */
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { assertPdfMagic } from "../middleware/upload";
import { uploadDocumentAtKey } from "../storage/object-storage";
import { storage } from "../storage";
import {
  getEnvelopeSummary,
  getRevisionById,
  getEnvelopeById,
  createManualRevision,
  createPdfRevision,
  createPlanningImportJob,
  advancePlanningImportStage,
  touchPlanningImportJob,
  failPlanningImportJob,
  getRecentPlanningImports,
  patchRevision,
  reviewRevision,
  approveRevision,
  reviseRevision,
  promoteRevision,
  PlanningEnvelopeError,
} from "../services/planning-envelope.service";
import { getDocumentStream } from "../storage/object-storage";
import { roundCurrency } from "../../shared/financial-utils";
import { DEVIS_UPLOAD_ERROR_CODES } from "../../shared/devis-upload-errors";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
type ActivePlanningImportStage = "extracting" | "validating" | "storing" | "saving";

function logPlanningImport(
  event: "started" | "stage" | "succeeded" | "failed",
  details: Record<string, unknown>,
): void {
  console.info("[PlanningImport]", JSON.stringify({ event, ...details }));
}

function safePlanningImportFailureMessage(error: unknown): string {
  if (error instanceof PlanningEnvelopeError) {
    if (error.code === "PROJECT_ARCHIVED") {
      return "This project is archived, so the imported draft could not be saved.";
    }
    if (error.code.startsWith("IMPORT_JOB_")) {
      return "The import status changed before the draft could be saved. Refresh the status and try again.";
    }
  }
  return "PDF import failed. Choose the file again to retry.";
}

// ─────────────────────────────────────────────────────────────────────────────
// Param schemas
// ─────────────────────────────────────────────────────────────────────────────

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const revisionIdParams = z.object({ id: z.coerce.number().int().positive() });

// ─────────────────────────────────────────────────────────────────────────────
// Body schemas — server-owned fields are stripped at Zod level
// ─────────────────────────────────────────────────────────────────────────────

// Strict decimal string: non-negative, up to 2 decimal places
const decimalNonNeg = z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a non-negative decimal string");
// Strict decimal string: strict positive
const decimalPos = z.string().regex(/^(?!0+(\.0+)?$)\d+(\.\d{1,2})?$/, "must be a positive decimal string");

const lineSchema = z.object({
  lineNumber: z.number().int().positive(),
  description: z.string().min(1).max(2000),
  quantity: decimalNonNeg.nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  unitPriceHt: decimalNonNeg.nullable().optional(),
  totalHt: decimalNonNeg,
  pdfPageHint: z.number().int().positive().nullable().optional(),
  pdfBbox: z.object({
    x: z.number(), y: z.number(), w: z.number(), h: z.number(),
  }).nullable().optional(),
});

const createManualRevisionBody = z.object({
  contractorId: z.number().int().positive().nullable().optional(),
  lotId: z.number().int().positive().nullable().optional(),
  reference: z.string().min(1).max(500).nullable().optional(),
  descriptionFr: z.string().min(1).max(2000).nullable().optional(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  amountHt: decimalPos.nullable().optional(),
  amountTtc: decimalPos.nullable().optional(),
  tvaRatePercent: decimalNonNeg.nullable().optional(),
  tvaAutoliquidation: z.boolean().optional(),
  supersedesRevisionId: z.number().int().positive().nullable().optional(),
  lines: z.array(lineSchema).optional(),
});

const patchRevisionBody = z.object({
  expectedVersion: z.number().int().positive(),
  contractorId: z.number().int().positive().nullable().optional(),
  lotId: z.number().int().positive().nullable().optional(),
  reference: z.string().min(1).max(500).nullable().optional(),
  descriptionFr: z.string().min(1).max(2000).nullable().optional(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  amountHt: decimalPos.nullable().optional(),
  amountTtc: decimalPos.nullable().optional(),
  tvaRatePercent: decimalNonNeg.nullable().optional(),
  tvaAutoliquidation: z.boolean().optional(),
  lines: z.array(lineSchema).optional(),
});

const reviewRevisionBody = z.object({
  expectedVersion: z.number().int().positive(),
  verificationNote: z.string().optional(),
});

const approveRevisionBody = z.object({
  expectedVersion: z.number().int().positive(),
});

const promoteRevisionBody = z.object({
  expectedVersion: z.number().int().positive(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic planning source object key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic key for a planning PDF source:
 * projects/{projectId}/planning-sources/{sha256}.pdf
 * Concurrent re-uploads collapse onto the same object (idempotent overwrite).
 */
function buildPlanningSourceObjectName(projectId: number, sha256Hex: string): string {
  const env = process.env;
  const privateDir = env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const dirPart = privateDir.startsWith("/") ? privateDir.slice(1).split("/").slice(1).join("/") : privateDir.split("/").slice(1).join("/");
  return `${dirPart}/projects/${projectId}/planning-sources/${sha256Hex}.pdf`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────────────────────────────────────

function handlePlanningError(err: unknown, res: import("express").Response): void {
  if (err instanceof PlanningEnvelopeError) {
    res.status(err.status).json({
      message: err.message,
      code: err.code,
      details: err.details,
    });
    return;
  }
  console.error("[PlanningEnvelope]", err instanceof Error ? err.message : err);
  res.status(500).json({ message: "Internal server error" });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/projects/:projectId/planning-envelope
// Returns envelope + all revisions (with lines/source) + totals.
// Never creates anything.
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/api/projects/:projectId/planning-envelope",
  requireAuth,
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);

      // Verify project exists
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const [summary, imports] = await Promise.all([
        getEnvelopeSummary(projectId),
        getRecentPlanningImports(projectId),
      ]);
      if (!summary) {
        // No envelope yet — return empty shape
        return res.json({
          envelope: null,
          revisions: [],
          totals: { amountHt: "0.00", amountTtc: "0.00", byLot: [] },
          imports,
        });
      }
      res.json({ ...summary, imports });
    } catch (err) {
      handlePlanningError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects/:projectId/planning-envelope/revisions
// Create manual draft revision
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/api/projects/:projectId/planning-envelope/revisions",
  requireAuth,
  validateRequest({ params: projectIdParams, body: createManualRevisionBody }),
  async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.archivedAt) {
        return res.status(409).json({ message: "Archived projects are read-only", code: "PROJECT_ARCHIVED" });
      }

      const user = await storage.getUser(req.session.userId!);
      const actor = user?.email ?? String(req.session.userId);

      const detail = await createManualRevision({
        projectId,
        actor,
        ...req.body,
      });
      res.status(201).json(detail);
    } catch (err) {
      handlePlanningError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects/:projectId/planning-envelope/import
// Multipart PDF upload → PDF draft revision
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/api/projects/:projectId/planning-envelope/import",
  requireAuth,
  upload.single("file"),
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    let importJobId: number | null = null;
    let importFileName: string | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    const requestStartedAt = Date.now();
    try {
      const projectId = Number(req.params.projectId);
      const file = req.file;
      if (!file) {
        return res.status(400).json({ message: "No file provided", code: DEVIS_UPLOAD_ERROR_CODES.NO_FILE_PROVIDED });
      }

      // PDF magic check
      try {
        assertPdfMagic(file.buffer);
      } catch (_e) {
        return res.status(415).json({ message: "Uploaded file is not a valid PDF", code: DEVIS_UPLOAD_ERROR_CODES.PDF_INVALID_MAGIC });
      }

      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.archivedAt) {
        return res.status(409).json({ message: "Archived projects are read-only", code: "PROJECT_ARCHIVED" });
      }

      const user = await storage.getUser(req.session.userId!);
      const actor = user?.email ?? String(req.session.userId);

      // Compute file SHA256 BEFORE parse/upload (used for dedup key and provenance)
      const fileSha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
      const fileSizeBytes = file.buffer.length;
      const mimeType = file.mimetype || "application/pdf";
      const safeFileName = path.basename(file.originalname)
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .slice(0, 500) || "planning.pdf";
      importFileName = safeFileName;

      const importJob = await createPlanningImportJob({
        projectId,
        actor,
        fileName: safeFileName,
        fileSha256,
        mimeType,
        fileSizeBytes,
      });
      importJobId = importJob.id;
      logPlanningImport("started", {
        projectId,
        importJobId,
        fileName: safeFileName,
        fileSizeBytes,
      });

      // A short heartbeat distinguishes a genuinely slow AI request from a
      // process that disappeared mid-import. The status read marks jobs stale
      // only after heartbeats stop for five minutes.
      heartbeat = setInterval(() => {
        void touchPlanningImportJob(importJob.id).catch((heartbeatError) => {
          console.error("[PlanningImport] heartbeat failed", {
            projectId,
            importJobId: importJob.id,
            error: heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError),
          });
        });
      }, 30_000);
      heartbeat.unref();

      const advanceStage = async (stage: ActivePlanningImportStage): Promise<void> => {
        const updated = await advancePlanningImportStage(importJob.id, stage);
        if (updated) {
          logPlanningImport("stage", {
            projectId,
            importJobId: importJob.id,
            fileName: safeFileName,
            stage,
            durationMs: Date.now() - requestStartedAt,
          });
        }
      };

      // Parse the PDF using the document parser
      await advanceStage("extracting");
      const {
        parseDocument,
        matchToProject,
        isTransientParseFailure,
      } = await import("../gmail/document-parser");
      const {
        validateExtraction,
      } = await import("../services/extraction-validator");
      const {
        findBlockingCompletenessWarnings,
      } = await import("../services/extraction-completeness");
      const {
        checkLotReferencesAgainstCatalog,
      } = await import("../services/lot-reference-validator");

      const parsed = await parseDocument(file.buffer, safeFileName);
      await advanceStage("validating");

      // Reject only meaningless/transient parse failures (not blocking completeness warnings)
      if (parsed.documentType === "unknown" && !parsed.amountHt && !parsed.contractorName && !parsed.lineItems?.length) {
        const transient = isTransientParseFailure(parsed);
        const message = transient
          ? "AI extraction is temporarily unavailable. Choose the PDF again to retry."
          : "Could not extract usable planning data from this PDF. Check the file and try again.";
        const code = transient ? DEVIS_UPLOAD_ERROR_CODES.AI_TRANSIENT : DEVIS_UPLOAD_ERROR_CODES.DEVIS_PARSE_FAILED;
        await failPlanningImportJob({
          importJobId: importJob.id,
          errorCode: code,
          errorMessage: message,
        });
        logPlanningImport("failed", {
          projectId,
          importJobId: importJob.id,
          fileName: safeFileName,
          stage: "validating",
          code,
          durationMs: Date.now() - requestStartedAt,
        });
        return res.status(transient ? 503 : 422).json({
          message,
          code,
        });
      }

      const validation = validateExtraction(parsed);

      // Blocking completeness warnings are PERSISTED (not rejected) — they set requiresVerification=true
      const blockingCompleteness = findBlockingCompletenessWarnings(validation.warnings);

      const lotWarnings = await checkLotReferencesAgainstCatalog(parsed);
      const corrected = { ...parsed, ...validation.correctedValues };
      const allProjects = await storage.getProjects({ includeArchived: true });
      const allContractors = (await storage.getContractors())
        .filter((contractor) => contractor.archidocOrphanedAt == null);
      const match = await matchToProject(parsed, allProjects, allContractors);
      const allWarnings = [...validation.warnings, ...lotWarnings, ...match.warnings];

      // Provider/model: prefer raw extraction metadata, fall back to configured AI model setting
      const parsedAny = parsed as unknown as Record<string, unknown>;
      let provider = typeof parsedAny.provider === "string" ? parsedAny.provider : "";
      let modelId = typeof parsedAny.modelId === "string" ? parsedAny.modelId : "";
      if (!provider || !modelId) {
        try {
          const aiSetting = await storage.getAiModelSetting("document_parsing");
          if (aiSetting) {
            if (!provider) provider = aiSetting.provider ?? "unknown";
            if (!modelId) modelId = aiSetting.modelId ?? "unknown";
          }
        } catch {
          // Non-fatal: fall back to unknown
        }
        if (!provider) provider = "unknown";
        if (!modelId) modelId = "unknown";
      }

      const amountHt = corrected.amountHt != null
        ? String(roundCurrency(corrected.amountHt))
        : null;
      const amountTtc = corrected.amountTtc != null
        ? String(roundCurrency(corrected.amountTtc))
        : null;

      // Build line items — use correct field names from ParsedDocument
      const lines = (corrected.lineItems ?? []).map((item: Record<string, unknown>, idx: number) => {
        const lineNum = typeof item.lineNumber === "number" ? item.lineNumber : idx + 1;
        // item.total (not item.totalHt) — matches ParsedDocument lineItems field name
        const totalRaw = typeof item.total === "number" ? item.total : (typeof item.total === "string" ? Number(item.total) : 0);
        // item.unitPrice (not item.unitPriceHt)
        const unitPriceRaw = typeof item.unitPrice === "number" ? item.unitPrice : (typeof item.unitPrice === "string" ? Number(item.unitPrice) : null);
        const qtyRaw = typeof item.quantity === "number" ? item.quantity : (typeof item.quantity === "string" ? Number(item.quantity) : null);
        // item.pageHint (not item.pdfPageHint)
        const pageHint = typeof item.pageHint === "number" ? item.pageHint : null;
        // item.bbox (direct field)
        const bbox = (item.bbox && typeof item.bbox === "object" && !Array.isArray(item.bbox))
          ? (item.bbox as { x: number; y: number; w: number; h: number })
          : null;
        return {
          lineNumber: lineNum,
          description: String(item.description ?? ""),
          quantity: qtyRaw != null && Number.isFinite(qtyRaw) ? String(qtyRaw) : null,
          unit: typeof item.unit === "string" ? item.unit : null,
          unitPriceHt: unitPriceRaw != null && Number.isFinite(unitPriceRaw) ? String(roundCurrency(unitPriceRaw)) : null,
          totalHt: String(roundCurrency(Number.isFinite(totalRaw) ? totalRaw : 0)),
          pdfPageHint: pageHint,
          pdfBbox: bbox,
        };
      });

      // Upload AFTER parse/validation succeeds (avoid orphaning rejected files)
      // Use deterministic key based on SHA256 so re-uploads of the same file are idempotent
      await advanceStage("storing");
      const objectName = buildPlanningSourceObjectName(projectId, fileSha256);
      const storageKey = await uploadDocumentAtKey(objectName, file.buffer, mimeType);

      // Confidence: use validation score; if blocking completeness issues exist, cap at below threshold
      const confidence = blockingCompleteness.length > 0
        ? Math.min(validation.confidenceScore, 79) // force requiresVerification=true
        : validation.confidenceScore;

      await advanceStage("saving");
      const detail = await createPdfRevision({
        projectId,
        actor,
        importJobId: importJob.id,
        storageKey,
        fileName: safeFileName,
        fileSha256,
        mimeType,
        fileSizeBytes,
        parserVersion: "1.0",
        provider,
        modelId,
        rawExtraction: parsed as unknown as Record<string, unknown>,
        confidence,
        warnings: allWarnings,
        contractorId: match.contractorId ?? null,
        // reference: prefer the generic reference, then the quotation number.
        reference: corrected.reference ?? corrected.devisNumber ?? null,
        descriptionFr: corrected.description ?? corrected.contractorName ?? null,
        documentDate: corrected.date ?? null,
        amountHt,
        amountTtc,
        tvaRatePercent: null, // Not inferred from extraction
        tvaAutoliquidation: corrected.autoLiquidation === true,
        lines,
      });

      logPlanningImport("succeeded", {
        projectId,
        importJobId: importJob.id,
        fileName: safeFileName,
        revisionId: detail.revision.id,
        lineCount: detail.lines.length,
        durationMs: Date.now() - requestStartedAt,
      });
      res.status(201).json(detail);
    } catch (err) {
      if (importJobId != null) {
        const code = err instanceof PlanningEnvelopeError ? err.code : "IMPORT_FAILED";
        const message = safePlanningImportFailureMessage(err);
        try {
          const failed = await failPlanningImportJob({
            importJobId,
            errorCode: code,
            errorMessage: message,
          });
          if (failed) {
            logPlanningImport("failed", {
              projectId: Number(req.params.projectId),
              importJobId,
              fileName: importFileName,
              stage: failed.stage,
              code,
              durationMs: Date.now() - requestStartedAt,
            });
          }
        } catch (statusError) {
          console.error("[PlanningImport] failed to persist terminal status", {
            importJobId,
            error: statusError instanceof Error ? statusError.message : String(statusError),
          });
        }
      }
      handlePlanningError(err, res);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/planning-revisions/:id
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/api/planning-revisions/:id",
  requireAuth,
  validateRequest({ params: revisionIdParams }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const detail = await getRevisionById(id);
      if (!detail) return res.status(404).json({ message: "Revision not found" });
      res.json(detail);
    } catch (err) {
      handlePlanningError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/planning-revisions/:id/pdf
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/api/planning-revisions/:id/pdf",
  requireAuth,
  validateRequest({ params: revisionIdParams }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const detail = await getRevisionById(id);
      if (!detail) return res.status(404).json({ message: "Revision not found" });
      if (!detail.source?.storageKey) {
        return res.status(404).json({ message: "No PDF attached to this revision" });
      }
      const { stream, contentType, size } = await getDocumentStream(detail.source.storageKey);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(size));

      // Sanitize filename for Content-Disposition — RFC 5987 ASCII encoding
      const rawName = detail.source.fileName ?? "revision.pdf";
      const safeName = path.basename(rawName).replace(/[^\w\s\-_.]/g, "_").slice(0, 200);
      const encodedName = encodeURIComponent(safeName);
      res.setHeader("Content-Disposition", `inline; filename="${safeName}"; filename*=UTF-8''${encodedName}`);
      stream.pipe(res);
    } catch (err) {
      handlePlanningError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/planning-revisions/:id
// ─────────────────────────────────────────────────────────────────────────────

router.patch(
  "/api/planning-revisions/:id",
  requireAuth,
  validateRequest({ params: revisionIdParams, body: patchRevisionBody }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      // Look up the revision to get the projectId
      const existing = await getRevisionById(id);
      if (!existing) return res.status(404).json({ message: "Revision not found" });

      const envelope = await getEnvelopeById(existing.revision.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      const user = await storage.getUser(req.session.userId!);
      const actor = user?.email ?? String(req.session.userId);

      const detail = await patchRevision({
        revisionId: id,
        projectId: envelope.projectId,
        actor,
        ...req.body,
      });
      res.json(detail);
    } catch (err) {
      if (err instanceof PlanningEnvelopeError && err.code === "REVISION_CAS_CONFLICT") {
        return res.status(409).json({ message: err.message, code: err.code, details: err.details });
      }
      handlePlanningError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planning-revisions/:id/review
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/api/planning-revisions/:id/review",
  requireAuth,
  validateRequest({ params: revisionIdParams, body: reviewRevisionBody }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      const existing = await getRevisionById(id);
      if (!existing) return res.status(404).json({ message: "Revision not found" });

      const envelope = await getEnvelopeById(existing.revision.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      const user = await storage.getUser(req.session.userId!);
      const actor = user?.email ?? String(req.session.userId);

      const detail = await reviewRevision({
        revisionId: id,
        projectId: envelope.projectId,
        actor,
        expectedVersion: req.body.expectedVersion,
        verificationNote: req.body.verificationNote,
      });
      res.json(detail);
    } catch (err) {
      handlePlanningError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planning-revisions/:id/approve
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/api/planning-revisions/:id/approve",
  requireAuth,
  validateRequest({ params: revisionIdParams, body: approveRevisionBody }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      const existing = await getRevisionById(id);
      if (!existing) return res.status(404).json({ message: "Revision not found" });

      const envelope = await getEnvelopeById(existing.revision.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      const user = await storage.getUser(req.session.userId!);
      const actor = user?.email ?? String(req.session.userId);

      const detail = await approveRevision({
        revisionId: id,
        projectId: envelope.projectId,
        actor,
        expectedVersion: req.body.expectedVersion,
      });
      res.json(detail);
    } catch (err) {
      handlePlanningError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planning-revisions/:id/revise
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/api/planning-revisions/:id/revise",
  requireAuth,
  validateRequest({ params: revisionIdParams }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      const existing = await getRevisionById(id);
      if (!existing) return res.status(404).json({ message: "Revision not found" });

      const envelope = await getEnvelopeById(existing.revision.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      const user = await storage.getUser(req.session.userId!);
      const actor = user?.email ?? String(req.session.userId);

      const detail = await reviseRevision({
        revisionId: id,
        projectId: envelope.projectId,
        actor,
      });
      res.status(201).json(detail);
    } catch (err) {
      handlePlanningError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planning-revisions/:id/promote
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/api/planning-revisions/:id/promote",
  requireAuth,
  validateRequest({ params: revisionIdParams, body: promoteRevisionBody }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      const existing = await getRevisionById(id);
      if (!existing) return res.status(404).json({ message: "Revision not found" });

      const envelope = await getEnvelopeById(existing.revision.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      const user = await storage.getUser(req.session.userId!);
      const actor = user?.email ?? String(req.session.userId);

      const result = await promoteRevision({
        revisionId: id,
        projectId: envelope.projectId,
        actor,
        expectedVersion: req.body.expectedVersion,
      });
      res.status(result.replay ? 200 : 201).json(result);
    } catch (err) {
      handlePlanningError(err, res);
    }
  },
);

export default router;
