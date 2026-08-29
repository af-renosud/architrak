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
import { deleteDocument, getDocumentBuffer, uploadDocumentAtKey } from "../storage/object-storage";
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
  deletePlanningUploadedDraft,
  patchRevision,
  updatePlanningLineReview,
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
    if (error.code === "AI_TRANSIENT" || error.code === "DEVIS_PARSE_FAILED") {
      return error.message;
    }
  }
  return "PDF import failed. Choose the file again to retry.";
}

/**
 * Shared extraction-to-revision pipeline for both a new upload and a server-side
 * re-scrape. Keeping this here ensures re-scrapes always use the current
 * validator and totals-box recovery implementation.
 */
async function parsePlanningPdf(
  pdfBuffer: Buffer,
  fileName: string,
  onParsed?: () => Promise<void>,
) {
  const { parseDocument, matchToProject, isTransientParseFailure } =
    await import("../gmail/document-parser");
  const { validateExtraction } = await import("../services/extraction-validator");
  const { findBlockingCompletenessWarnings } =
    await import("../services/extraction-completeness");
  const { checkLotReferencesAgainstCatalog } =
    await import("../services/lot-reference-validator");
  const { recoverPlanningTotalsBoxLines } =
    await import("../services/planning-totals-recovery.service");

  let parsed = await parseDocument(pdfBuffer, fileName);
  await onParsed?.();
  if (
    parsed.documentType === "unknown"
    && !parsed.amountHt
    && !parsed.contractorName
    && !parsed.lineItems?.length
  ) {
    const transient = isTransientParseFailure(parsed);
    throw new PlanningEnvelopeError(
      transient ? 503 : 422,
      transient ? "AI_TRANSIENT" : "DEVIS_PARSE_FAILED",
      transient
        ? "AI extraction is temporarily unavailable. Choose the PDF again to retry."
        : "Could not extract usable planning data from this PDF. Check the file and try again.",
    );
  }

  let validation = validateExtraction(parsed);
  ({ parsed, validation } = await recoverPlanningTotalsBoxLines({
    pdfBuffer,
    fileName,
    parsed,
    validation,
  }));

  const blockingCompleteness = findBlockingCompletenessWarnings(validation.warnings);
  const lotWarnings = await checkLotReferencesAgainstCatalog(parsed);
  const corrected = { ...parsed, ...validation.correctedValues };
  const allProjects = await storage.getProjects({ includeArchived: true });
  const allContractors = (await storage.getContractors())
    .filter((contractor) => contractor.archidocOrphanedAt == null);
  const match = await matchToProject(parsed, allProjects, allContractors);
  const warnings = [...validation.warnings, ...lotWarnings, ...match.warnings];

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
      // Extraction remains valid when model-setting lookup is unavailable.
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
  const lines = (corrected.lineItems ?? []).map((item: Record<string, unknown>, idx: number) => {
    const lineNum = typeof item.lineNumber === "number" ? item.lineNumber : idx + 1;
    const totalRaw = typeof item.total === "number"
      ? item.total
      : (typeof item.total === "string" ? Number(item.total) : 0);
    const unitPriceRaw = typeof item.unitPrice === "number"
      ? item.unitPrice
      : (typeof item.unitPrice === "string" ? Number(item.unitPrice) : null);
    const qtyRaw = typeof item.quantity === "number"
      ? item.quantity
      : (typeof item.quantity === "string" ? Number(item.quantity) : null);
    const pageHint = typeof item.pageHint === "number" ? item.pageHint : null;
    const bbox = (item.bbox && typeof item.bbox === "object" && !Array.isArray(item.bbox))
      ? (item.bbox as { x: number; y: number; w: number; h: number })
      : null;
    return {
      lineNumber: lineNum,
      description: String(item.description ?? ""),
      quantity: qtyRaw != null && Number.isFinite(qtyRaw) ? String(qtyRaw) : null,
      unit: typeof item.unit === "string" ? item.unit : null,
      unitPriceHt: unitPriceRaw != null && Number.isFinite(unitPriceRaw)
        ? String(roundCurrency(unitPriceRaw))
        : null,
      totalHt: String(roundCurrency(Number.isFinite(totalRaw) ? totalRaw : 0)),
      pdfPageHint: pageHint,
      pdfBbox: bbox,
    };
  });

  return {
    parserVersion: "planning-pdf-v3-option-reconciliation",
    provider,
    modelId,
    rawExtraction: parsed as unknown as Record<string, unknown>,
    confidence: blockingCompleteness.length > 0
      ? Math.min(validation.confidenceScore, 79)
      : validation.confidenceScore,
    warnings,
    contractorId: match.contractorId ?? null,
    reference: corrected.reference ?? corrected.devisNumber ?? null,
    descriptionFr: corrected.description ?? corrected.contractorName ?? null,
    documentDate: corrected.date ?? null,
    amountHt,
    amountTtc,
    tvaRatePercent: null,
    tvaAutoliquidation: corrected.autoLiquidation === true,
    lines,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Param schemas
// ─────────────────────────────────────────────────────────────────────────────

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const revisionIdParams = z.object({ id: z.coerce.number().int().positive() });
const revisionLineIdParams = z.object({
  id: z.coerce.number().int().positive(),
  lineId: z.coerce.number().int().positive(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Body schemas — server-owned fields are stripped at Zod level
// ─────────────────────────────────────────────────────────────────────────────

// Strict decimal string: non-negative, up to 2 decimal places
const decimalNonNeg = z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a non-negative decimal string");
// Quantities are stored as numeric(12,3), so preserve database-formatted values
// such as "1.000" without relaxing the two-decimal rule for money.
const quantityNonNeg = z.string().regex(
  /^\d+(\.\d{1,3})?$/,
  "must be a non-negative decimal string with up to 3 decimal places",
);
// Strict decimal string: strict positive
const decimalPos = z.string().regex(/^(?!0+(\.0+)?$)\d+(\.\d{1,2})?$/, "must be a positive decimal string");

const lineSchema = z.object({
  lineNumber: z.number().int().positive(),
  description: z.string().min(1).max(2000),
  quantity: quantityNonNeg.nullable().optional(),
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
  archidocTechnicalLotId: z.string().trim().min(1).max(255).nullable().optional(),
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
  archidocTechnicalLotId: z.string().trim().min(1).max(255).nullable().optional(),
  reference: z.string().min(1).max(500).nullable().optional(),
  descriptionFr: z.string().min(1).max(2000).nullable().optional(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  amountHt: decimalPos.nullable().optional(),
  amountTtc: decimalPos.nullable().optional(),
  tvaRatePercent: decimalNonNeg.nullable().optional(),
  tvaAutoliquidation: z.boolean().optional(),
  lines: z.array(lineSchema).optional(),
});

const planningLineReviewBody = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.enum(["unchecked", "green", "amber", "red"]),
  notes: z.string().max(4000).nullable().optional(),
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

const rescrapeRevisionBody = z.object({
  expectedVersion: z.number().int().positive(),
});

const deleteRevisionBody = z.object({
  expectedVersion: z.number().int().positive(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Immutable planning source object key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unique immutable key for one planning import:
 * projects/{projectId}/planning-sources/import-{importJobId}-{sha256}.pdf
 *
 * The import-job generation prevents cleanup authorized for an older draft
 * from deleting a same-SHA replacement uploaded immediately after commit.
 */
function buildPlanningSourceObjectName(
  projectId: number,
  importJobId: number,
  sha256Hex: string,
): string {
  const env = process.env;
  const privateDir = env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const dirPart = privateDir.startsWith("/") ? privateDir.slice(1).split("/").slice(1).join("/") : privateDir.split("/").slice(1).join("/");
  return `${dirPart}/projects/${projectId}/planning-sources/import-${importJobId}-${sha256Hex}.pdf`;
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

      // Compute file SHA256 BEFORE parse/upload (used for provenance and the
      // content-identifying portion of this import's immutable object key).
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
      const parsedRevision = await parsePlanningPdf(
        file.buffer,
        safeFileName,
        () => advanceStage("validating"),
      );

      // Upload AFTER parse/validation succeeds (avoid orphaning rejected files).
      // Each import gets an immutable generation key. Same-SHA replacements must
      // never reuse a key whose prior draft cleanup may already be in flight.
      await advanceStage("storing");
      const objectName = buildPlanningSourceObjectName(projectId, importJob.id, fileSha256);
      const storageKey = await uploadDocumentAtKey(objectName, file.buffer, mimeType);

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
        ...parsedRevision,
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
      if (
        err instanceof PlanningEnvelopeError
        && (err.code === "AI_TRANSIENT" || err.code === "DEVIS_PARSE_FAILED")
      ) {
        return res.status(err.status).json({ message: err.message, code: err.code });
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
      const disposition = req.query.download === "1" ? "attachment" : "inline";
      res.setHeader("Content-Disposition", `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodedName}`);
      stream.pipe(res);
    } catch (err) {
      handlePlanningError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/planning-revisions/:id
// Permanently remove an unpromoted planning candidate.
// ─────────────────────────────────────────────────────────────────────────────

router.delete(
  "/api/planning-revisions/:id",
  requireAuth,
  validateRequest({ params: revisionIdParams, body: deleteRevisionBody }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await deletePlanningUploadedDraft({
        revisionId: id,
        expectedVersion: req.body.expectedVersion,
      });

      if (result.storageKeyToDelete) {
        try {
          await deleteDocument(result.storageKeyToDelete);
        } catch (storageError) {
          console.warn(
            `[PlanningCandidateDelete] Deleted revision ${id}, but source-object cleanup failed (continuing):`,
            storageError,
          );
        }
      }

      const user = await storage.getUser(req.session.userId!);
      console.info("[PlanningCandidateDelete]", JSON.stringify({
        revisionId: id,
        projectId: result.projectId,
        fileName: result.fileName,
        deletedImportJobIds: result.deletedImportJobIds,
        actor: user?.email ?? String(req.session.userId),
      }));
      res.json({ deleted: true, revisionId: id });
    } catch (err) {
      handlePlanningError(err, res);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planning-revisions/:id/rescrape
// Re-run the current parser against the existing immutable PDF source.
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/api/planning-revisions/:id/rescrape",
  requireAuth,
  validateRequest({ params: revisionIdParams, body: rescrapeRevisionBody }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await getRevisionById(id);
      if (!existing) return res.status(404).json({ message: "Revision not found" });

      const envelope = await getEnvelopeById(existing.revision.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });
      const project = await storage.getProject(envelope.projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.archivedAt) {
        return res.status(409).json({
          message: "Archived projects are read-only",
          code: "PROJECT_ARCHIVED",
        });
      }
      if (existing.revision.version !== req.body.expectedVersion) {
        return res.status(409).json({
          message: `Version conflict: expected ${req.body.expectedVersion}, got ${existing.revision.version}`,
          code: "REVISION_CAS_CONFLICT",
          details: {
            expectedVersion: req.body.expectedVersion,
            currentVersion: existing.revision.version,
          },
        });
      }
      if (!["draft", "reviewed", "approved"].includes(existing.revision.status)) {
        return res.status(409).json({
          message: `This ${existing.revision.status} revision cannot be re-scraped`,
          code: "REVISION_STATUS_CONFLICT",
          details: { currentStatus: existing.revision.status },
        });
      }

      const source = existing.source;
      if (
        !source
        || source.sourceKind !== "pdf_upload"
        || !source.storageKey
        || !source.fileSha256
      ) {
        return res.status(422).json({
          message: "Revision does not have an immutable PDF upload source",
          code: "REVISION_SOURCE_INVALID",
        });
      }

      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await getDocumentBuffer(source.storageKey);
      } catch {
        return res.status(503).json({
          message: "The revision PDF is currently unavailable in object storage",
          code: "REVISION_SOURCE_UNAVAILABLE",
        });
      }
      try {
        assertPdfMagic(pdfBuffer);
      } catch {
        return res.status(422).json({
          message: "The stored revision source is not a valid PDF",
          code: "REVISION_SOURCE_INVALID",
        });
      }
      const actualSha = crypto.createHash("sha256").update(pdfBuffer).digest("hex");
      if (actualSha !== source.fileSha256) {
        return res.status(422).json({
          message: "The stored PDF no longer matches its immutable source provenance",
          code: "REVISION_SOURCE_INVALID",
        });
      }

      const user = await storage.getUser(req.session.userId!);
      const actor = user?.email ?? String(req.session.userId);
      const fileName = path.basename(source.fileName ?? "planning.pdf")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .slice(0, 500) || "planning.pdf";
      const parsedRevision = await parsePlanningPdf(pdfBuffer, fileName);
      const detail = await createPdfRevision({
        projectId: envelope.projectId,
        actor,
        storageKey: source.storageKey,
        fileName,
        fileSha256: source.fileSha256,
        mimeType: source.mimeType ?? "application/pdf",
        fileSizeBytes: pdfBuffer.length,
        rescrapedFromRevisionId: id,
        expectedSourceVersion: req.body.expectedVersion,
        ...parsedRevision,
      });
      res.status(201).json(detail);
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

router.patch(
  "/api/planning-revisions/:id/lines/:lineId/review",
  requireAuth,
  validateRequest({ params: revisionLineIdParams, body: planningLineReviewBody }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await getRevisionById(id);
      if (!existing) return res.status(404).json({ message: "Revision not found" });
      const envelope = await getEnvelopeById(existing.revision.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });
      const user = await storage.getUser(req.session.userId!);
      const actor = user?.email ?? String(req.session.userId);
      const detail = await updatePlanningLineReview({
        revisionId: id,
        lineId: Number(req.params.lineId),
        projectId: envelope.projectId,
        actor,
        ...req.body,
      });
      res.json(detail);
    } catch (err) {
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
