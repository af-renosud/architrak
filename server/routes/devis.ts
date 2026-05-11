import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import {
  insertDevisSchema,
  insertDevisLineItemSchema,
  insertAvenantSchema,
  type InsertDevis,
  type InsertDevisLineItem,
  type InsertAvenant,
} from "@shared/schema";
import { upload } from "../middleware/upload";
import { processDevisUpload } from "../services/devis-upload.service";
import { rescrapeDevis } from "../services/devis-rescrape.service";
import { confirmDevisAndMirror, assignTagsForInsertedItems } from "../services/benchmark-ingest.service";
import { PdfPasswordProtectedError } from "../gmail/document-parser";
import { DEVIS_UPLOAD_ERROR_CODES } from "../../shared/devis-upload-errors";
import { getDocumentStream } from "../storage/object-storage";
import { validateExtraction, type ValidationWarning } from "../services/extraction-validator";
import { checkLotReferencesAgainstCatalog } from "../services/lot-reference-validator";
import type { ParsedDocument } from "../gmail/document-parser";
import { roundCurrency } from "../../shared/financial-utils";
import { evaluateInsuranceGate } from "../services/insurance-verdict";
import {
  reconcileAdvisories,
  getAdvisoriesForDevis,
  acknowledgeAdvisoryForSubject,
} from "../services/advisory-reconciler";
import { validateRequest } from "../middleware/validate";
import { translateDevis, retranslateSingleLine, triggerDevisTranslation } from "../services/devis-translation";
import { normalizeDevisText, normalizeLineItemText, toSentenceCase } from "../lib/sentence-case";
import {
  composeDevisCode,
  findNextLotSequence,
  isLotSequenceTaken,
  validateDevisCodeParts,
  type DevisCodeParts,
} from "../lib/devis-code";
import {
  generateDevisTranslationPdf,
  generateCombinedPdf,
} from "../communications/devis-translation-generator";
import {
  devisTranslationLineSchema,
  devisTranslationHeaderSchema,
} from "@shared/schema";

const router = Router();

/**
 * Render a numeric `totalHt` (stored as a Drizzle numeric → string like
 * "18500.00") in fr-FR thousands/decimal form ("18 500,00") for embedding in
 * the auto-suggested line-item check question. Falls back to the raw value if
 * parsing fails so we never throw inside the line-item PATCH handler.
 */
function formatLineTotalForSuggestion(totalHt: string | null): string {
  if (!totalHt) return "—";
  const n = Number(totalHt);
  if (!Number.isFinite(n)) return totalHt;
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

const idParams = z.object({ id: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const devisIdParams = z.object({ devisId: z.coerce.number().int().positive() });
const advisoryAckParams = z.object({
  id: z.coerce.number().int().positive(),
  advisoryId: z.coerce.number().int().positive(),
});

const createDevisBodySchema = insertDevisSchema.omit({ projectId: true });
// PATCH /api/devis/:id accepts the structured lot-code parts as a virtual
// `lotCode` field alongside any of the underlying columns. The handler
// validates uniqueness, composes `devisCode`, and persists the three
// structured columns; raw `lotCatalogId` / `lotRefText` / `lotSequence`
// in the body are ignored when `lotCode` is supplied.
const lotCodePatchSchema = z
  .object({
    lotCatalogId: z.number().int().positive().nullable().optional(),
    lotRefText: z.string().trim().min(1),
    lotSequence: z.number().int().min(1),
    lotDescription: z.string().trim().min(1),
  })
  .optional();
const updateDevisSchema = insertDevisSchema.partial().extend({
  lotCode: lotCodePatchSchema,
});
const createLineItemBodySchema = insertDevisLineItemSchema.omit({ devisId: true });
const updateLineItemSchema = insertDevisLineItemSchema.partial();
const createAvenantBodySchema = insertAvenantSchema.omit({ devisId: true });
const updateAvenantSchema = insertAvenantSchema.partial();

const lotCodePartsSchema = z
  .object({
    lotCatalogId: z.number().int().positive().nullable().optional(),
    lotRefText: z.string().trim().min(1),
    lotSequence: z.number().int().min(1),
    lotDescription: z.string().trim().min(1),
  })
  .optional();

const devisConfirmSchema = z.object({
  amountHt: z.coerce.number().nonnegative().optional(),
  amountTtc: z.coerce.number().nonnegative().optional(),
  devisCode: z.string().min(1).optional(),
  devisNumber: z.string().optional(),
  descriptionFr: z.string().optional(),
  dateSent: z.string().optional(),
  lotCode: lotCodePartsSchema,
}).strict();
type DevisConfirmInput = z.infer<typeof devisConfirmSchema>;

router.get("/api/projects/:projectId/devis", async (req, res) => {
  const devisList = await storage.getDevisByProject(Number(req.params.projectId));
  res.json(devisList);
});

const nextLotNumberQuerySchema = z.object({
  lotRef: z.string().trim().min(1, "lotRef is required"),
  excludeDevisId: z.coerce.number().int().positive().optional(),
});

router.get(
  "/api/projects/:projectId/devis/next-lot-number",
  validateRequest({ params: projectIdParams, query: nextLotNumberQuerySchema }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const lotRef = String(req.query.lotRef);
    const excludeDevisId = req.query.excludeDevisId
      ? Number(req.query.excludeDevisId)
      : undefined;
    const next = await findNextLotSequence(projectId, lotRef, { excludeDevisId });
    // Response key is `nextLotSequence` to match the client contract and
    // signal "the next free number for this (project, lotRef)" — distinct
    // from the row's persisted `lotSequence`.
    res.json({ lotRef, nextLotSequence: next });
  },
);

/**
 * Validate the structured lot-code parts and produce the DB updates that
 * persist them (lotCatalogId, lotRefText, lotSequence) plus the composed
 * `devisCode`. Returns either an error response payload or the updates
 * to merge into the storage.updateDevis call.
 *
 * Uniqueness is checked against the project (case-insensitive on lotRef);
 * on collision the response includes a fresh `nextLotSequence` suggestion
 * so the form can re-populate immediately without a second round-trip.
 */
type LotCodeUpdatesResult =
  | { ok: true; updates: Record<string, unknown>; composedCode: string }
  | { ok: false; status: number; body: Record<string, unknown> };

async function buildLotCodeUpdates(
  projectId: number,
  lotCode: NonNullable<z.infer<typeof lotCodePartsSchema>>,
  opts: { excludeDevisId?: number },
): Promise<LotCodeUpdatesResult> {
  const parts: DevisCodeParts = {
    lotRef: lotCode.lotRefText,
    lotSequence: lotCode.lotSequence,
    description: lotCode.lotDescription,
  };
  const errors = validateDevisCodeParts(parts);
  if (errors.length > 0) {
    return {
      ok: false,
      status: 400,
      body: { message: errors[0].message, code: "devis_code_invalid", errors },
    };
  }
  if (lotCode.lotCatalogId != null) {
    const entry = await storage.getLotCatalogEntry(lotCode.lotCatalogId);
    if (!entry) {
      return {
        ok: false,
        status: 404,
        body: { message: "Lot catalog entry not found", code: "lot_catalog_not_found" },
      };
    }
    if (entry.code.toLowerCase() !== lotCode.lotRefText.trim().toLowerCase()) {
      return {
        ok: false,
        status: 400,
        body: {
          message: "Lot reference does not match the selected catalog entry",
          code: "devis_code_catalog_mismatch",
        },
      };
    }
  }
  const taken = await isLotSequenceTaken(
    projectId,
    lotCode.lotRefText,
    lotCode.lotSequence,
    { excludeDevisId: opts.excludeDevisId },
  );
  if (taken) {
    const next = await findNextLotSequence(projectId, lotCode.lotRefText, {
      excludeDevisId: opts.excludeDevisId,
    });
    return {
      ok: false,
      status: 409,
      body: {
        message: `Devis number ${lotCode.lotSequence} already exists for lot "${lotCode.lotRefText}". The next available number is ${next}.`,
        code: "devis_lot_sequence_taken",
        nextLotSequence: next,
      },
    };
  }
  const composedCode = composeDevisCode(parts);
  return {
    ok: true,
    composedCode,
    updates: {
      lotCatalogId: lotCode.lotCatalogId ?? null,
      lotRefText: lotCode.lotRefText.trim().toUpperCase(),
      lotSequence: lotCode.lotSequence,
      devisCode: composedCode,
    },
  };
}

router.post(
  "/api/projects/:projectId/devis",
  validateRequest({ params: projectIdParams, body: createDevisBodySchema }),
  async (req, res) => {
    const d = await storage.createDevis({ ...normalizeDevisText({ ...req.body }), projectId: Number(req.params.projectId) });
    res.status(201).json(d);
  },
);

router.post(
  "/api/projects/:projectId/devis/upload",
  upload.single("file"),
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      const file = req.file;
      if (!file) return res.status(400).json({ message: "No file provided", code: DEVIS_UPLOAD_ERROR_CODES.NO_FILE_PROVIDED });

      const result = await processDevisUpload(projectId, file);
      res.status(result.status).json(result.data);
    } catch (err: unknown) {
      if (err instanceof PdfPasswordProtectedError) {
        return res.status(422).json({ message: err.message, code: DEVIS_UPLOAD_ERROR_CODES.PDF_PASSWORD_PROTECTED });
      }
      const message = err instanceof Error ? err.message : String(err);
      // assertPdfMagic and similar guards attach a numeric `.status` (e.g. 415)
      // on the thrown Error. Preserve it so the client sees the right HTTP
      // status and stable code instead of a collapsed 500.
      const statusFromErr =
        err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
          ? (err as { status: number }).status
          : null;
      if (statusFromErr === 415) {
        return res.status(415).json({ message, code: DEVIS_UPLOAD_ERROR_CODES.PDF_INVALID_MAGIC });
      }
      console.error("[Devis Upload] Error:", message);
      res
        .status(statusFromErr ?? 500)
        .json({ message: `Upload/parse failed: ${message}`, code: DEVIS_UPLOAD_ERROR_CODES.DEVIS_UPLOAD_FAILED });
    }
  },
);

router.get("/api/devis/:id", async (req, res) => {
  const d = await storage.getDevis(Number(req.params.id));
  if (!d) return res.status(404).json({ message: "Devis not found" });
  res.json(d);
});

const pdfVariantSchema = z.object({
  variant: z.enum(["original", "translation", "combined"]).optional(),
  explanations: z.coerce.boolean().optional(),
});

router.get(
  "/api/devis/:id/pdf",
  validateRequest({ params: idParams, query: pdfVariantSchema }),
  async (req, res) => {
    try {
      const devisId = Number(req.params.id);
      let variant = req.query.variant as "original" | "translation" | "combined" | undefined;
      const includeExplanations = (req.query as { explanations?: boolean }).explanations === true;

      const d = await storage.getDevis(devisId);
      if (!d) return res.status(404).json({ message: "Devis not found" });

      if (!variant) {
        const t = await storage.getDevisTranslation(devisId);
        const ready = !!t && (t.status === "draft" || t.status === "edited" || t.status === "finalised");
        variant = ready && d.pdfStorageKey ? "combined" : "original";
      }

      let storageKey: string | null = null;
      let fileName = d.pdfFileName || "devis.pdf";

      if (variant === "original") {
        if (!d.pdfStorageKey) return res.status(404).json({ message: "No PDF attached to this devis" });
        storageKey = d.pdfStorageKey;
      } else if (variant === "translation") {
        const t = await storage.getDevisTranslation(devisId);
        const ready = !!t && (t.status === "draft" || t.status === "edited" || t.status === "finalised");
        if (!t || !ready) {
          return res.status(409).json({ message: "Translation not ready", status: t?.status ?? "missing" });
        }
        if (t.translatedPdfStorageKey && !includeExplanations) {
          storageKey = t.translatedPdfStorageKey;
        } else {
          const generated = await generateDevisTranslationPdf(devisId, { includeExplanations });
          storageKey = generated.storageKey;
        }
        fileName = `DEVIS-${d.devisCode}-EN${includeExplanations ? "-explained" : ""}.pdf`;
      } else {
        const t = await storage.getDevisTranslation(devisId);
        const ready = !!t && (t.status === "draft" || t.status === "edited" || t.status === "finalised");
        if (!t || !ready) {
          return res.status(409).json({ message: "Translation not ready", status: t?.status ?? "missing" });
        }
        if (t.combinedPdfStorageKey && !includeExplanations) {
          storageKey = t.combinedPdfStorageKey;
        } else {
          const merged = await generateCombinedPdf(devisId, { includeExplanations });
          storageKey = merged.storageKey;
        }
        fileName = `DEVIS-${d.devisCode}-EN-FR${includeExplanations ? "-explained" : ""}.pdf`;
      }

      if (!storageKey) return res.status(404).json({ message: "Document not found" });

      const { stream, contentType, size } = await getDocumentStream(storageKey);
      res.setHeader("Content-Type", contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
      if (size) res.setHeader("Content-Length", String(size));
      stream.pipe(res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `PDF view failed: ${message}` });
    }
  },
);

router.post(
  "/api/devis/:id/rescrape",
  requireAuth,
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const devisId = Number(req.params.id);
      const result = await rescrapeDevis(devisId);
      res.status(result.status).json(result.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Devis Rescrape] Error:", message);
      res.status(500).json({ message: `Re-scrape failed: ${message}` });
    }
  },
);

router.get("/api/devis/:id/translation", validateRequest({ params: idParams }), async (req, res) => {
  const t = await storage.getDevisTranslation(Number(req.params.id));
  if (!t) return res.json({ status: "missing" });
  res.json(t);
});

const translateBodySchema = z
  .object({ force: z.boolean().optional() })
  .partial()
  .optional();

router.post(
  "/api/devis/:id/translate",
  validateRequest({ params: idParams, body: translateBodySchema }),
  async (req, res) => {
    try {
      const devisId = Number(req.params.id);
      const force = !!(req.body && (req.body as { force?: boolean }).force);
      const d = await storage.getDevis(devisId);
      if (!d) return res.status(404).json({ message: "Devis not found" });
      await translateDevis(devisId, { force });
      const row = await storage.getDevisTranslation(devisId);
      res.json(row);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/finalised/i.test(message)) {
        return res.status(409).json({ message });
      }
      console.error("[Devis Translation] Failed:", message);
      res.status(500).json({ message: `Translation failed: ${message}` });
    }
  },
);

const lineNumberParams = z.object({
  id: z.coerce.number().int().positive(),
  lineNumber: z.coerce.number().int().nonnegative(),
});

router.post(
  "/api/devis/:id/translation/lines/:lineNumber/retranslate",
  validateRequest({ params: lineNumberParams }),
  async (req, res) => {
    try {
      const devisId = Number(req.params.id);
      const lineNumber = Number(req.params.lineNumber);
      const existing = await storage.getDevisTranslation(devisId);
      if (!existing) return res.status(404).json({ message: "No translation exists yet" });
      if (existing.status === "finalised") {
        return res.status(409).json({ message: "Translation is finalised — re-open by editing or re-translating all lines." });
      }
      if (existing.status !== "draft" && existing.status !== "edited") {
        return res.status(409).json({ message: `Cannot retranslate line while translation is ${existing.status}` });
      }
      const updatedLine = await retranslateSingleLine(devisId, lineNumber);
      if (!updatedLine) return res.status(404).json({ message: `Line ${lineNumber} not found` });
      const row = await storage.getDevisTranslation(devisId);
      res.json({ line: updatedLine, translation: row });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) {
        return res.status(404).json({ message });
      }
      console.error("[Devis Translation] Line retranslate failed:", message);
      res.status(500).json({ message: `Retranslate failed: ${message}` });
    }
  },
);

router.post(
  "/api/devis/:id/translation/finalise",
  requireAuth,
  validateRequest({ params: idParams }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const existing = await storage.getDevisTranslation(devisId);
    if (!existing) return res.status(404).json({ message: "No translation to finalise" });
    if (existing.status !== "draft" && existing.status !== "edited") {
      return res.status(409).json({ message: `Cannot finalise translation in status ${existing.status}` });
    }
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const approver = await storage.getUser(Number(userId));
    const updated = await storage.updateDevisTranslation(devisId, {
      status: "finalised",
      translatedPdfStorageKey: null,
      combinedPdfStorageKey: null,
      approvedAt: new Date(),
      approvedBy: Number(userId),
      approvedByEmail: approver?.email ?? null,
    });
    res.json(updated);
  },
);

const patchTranslationSchema = z.object({
  header: devisTranslationHeaderSchema.optional(),
  lines: z.array(devisTranslationLineSchema).optional(),
}).strict();

router.patch(
  "/api/devis/:id/translation",
  validateRequest({ params: idParams, body: patchTranslationSchema }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const existing = await storage.getDevisTranslation(devisId);
    if (!existing) return res.status(404).json({ message: "No translation to update" });
    // NOTE: Edits are accepted even when the translation is "finalised" (approved).
    // Architects asked for inline tweaks without having to re-translate everything;
    // this is a low-risk content change, not a security-sensitive one. The approval
    // metadata (approvedAt / approvedByEmail) is preserved untouched below.
    const wasFinalised = existing.status === "finalised";

    const previousLines = (existing.lineTranslations as z.infer<typeof devisTranslationLineSchema>[] | null) || [];
    const previousByNum = new Map(previousLines.map((l) => [l.lineNumber, l]));
    const incomingLines = req.body.lines as z.infer<typeof devisTranslationLineSchema>[] | undefined;

    const mergedLines = incomingLines
      ? incomingLines.map((l) => {
          const prev = previousByNum.get(l.lineNumber);
          const userChanged =
            !prev ||
            (prev.translation ?? "") !== (l.translation ?? "") ||
            (prev.explanation ?? null) !== (l.explanation ?? null);
          return { ...l, edited: l.edited ?? (userChanged ? true : prev?.edited ?? false) };
        })
      : previousLines;

    const updated = await storage.updateDevisTranslation(devisId, {
      headerTranslated: req.body.header ?? existing.headerTranslated,
      lineTranslations: mergedLines,
      translatedPdfStorageKey: null,
      combinedPdfStorageKey: null,
      // Keep the approved/finalised state if it was already approved — only
      // bump to "edited" when starting from a non-finalised state.
      status: wasFinalised ? "finalised" : "edited",
    });
    res.json(updated);
  },
);

router.patch(
  "/api/devis/:id",
  requireAuth,
  validateRequest({ params: idParams, body: updateDevisSchema }),
  async (req, res) => {
    const id = Number(req.params.id);
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const user = await storage.getUser(Number(userId));
    if (!user) return res.status(401).json({ message: "Authentication required" });

    const before = await storage.getDevis(id);
    if (!before) return res.status(404).json({ message: "Devis not found" });

    // CHECKING gate: cannot advance sign-off to 'sent_to_client' or beyond
    // while there are unresolved contractor checks. Lifts automatically once
    // all checks are resolved or dropped.
    const STAGE_ORDER = ["received", "checked_internal", "approved_for_signing", "sent_to_client", "client_signed_off"];
    const SENT_INDEX = STAGE_ORDER.indexOf("sent_to_client");
    if (Object.prototype.hasOwnProperty.call(req.body, "signOffStage")) {
      const nextStage = String(req.body.signOffStage);
      const nextIdx = STAGE_ORDER.indexOf(nextStage);
      const prevIdx = STAGE_ORDER.indexOf(before.signOffStage);
      if (nextIdx >= SENT_INDEX && nextIdx > prevIdx) {
        const openCount = await storage.countOpenDevisChecks(id);
        if (openCount > 0) {
          return res.status(409).json({
            message:
              openCount === 1
                ? "Impossible d'envoyer le devis au client : 1 question contractant est encore ouverte."
                : `Impossible d'envoyer le devis au client : ${openCount} questions contractant sont encore ouvertes.`,
            openChecks: openCount,
          });
        }

        // INSURANCE gate (AT3, contract §1.3): block any transition
        // that crosses into `sent_to_client` (or beyond) — including
        // direct jumps from earlier stages — unless the live verdict
        // is green (200 + canProceed:true) OR an override row exists
        // in `insurance_overrides`. We deliberately do NOT condition
        // on the prior stage so the gate cannot be bypassed by
        // skipping `approved_for_signing`. We ALSO evaluate against
        // the effective post-mutation contractor/lot from the same
        // PATCH body, so a combined `contractorId + signOffStage`
        // change cannot validate against the stale persisted row.
        const ctxOverrides: { contractorId?: number; lotId?: number | null } = {};
        let contractorOrLotMutating = false;
        if (Object.prototype.hasOwnProperty.call(req.body, "contractorId")) {
          const raw = req.body.contractorId;
          const n = typeof raw === "number" ? raw : Number(raw);
          if (Number.isFinite(n) && n > 0) {
            ctxOverrides.contractorId = n;
            contractorOrLotMutating = contractorOrLotMutating || n !== before.contractorId;
          }
        }
        if (Object.prototype.hasOwnProperty.call(req.body, "lotId")) {
          const raw = req.body.lotId;
          const next: number | null =
            raw === null || raw === undefined || raw === ""
              ? null
              : Number.isFinite(Number(raw))
                ? Number(raw)
                : null;
          ctxOverrides.lotId = next;
          contractorOrLotMutating = contractorOrLotMutating || next !== before.lotId;
        }
        const decision = await evaluateInsuranceGate(id, ctxOverrides);
        if (!("error" in decision) && !decision.proceed) {
          // Stale-override guard: an override only authorises the
          // send when the CURRENT verdict is still in an overridable
          // arm AND the contractor/lot are NOT being changed in the
          // same PATCH (a contractor/lot change invalidates the
          // verdict snapshot the override was minted against).
          const existingOverride =
            decision.overridable && !contractorOrLotMutating
              ? await storage.getLatestInsuranceOverrideForDevis(id)
              : null;
          if (!existingOverride) {
            return res.status(409).json({
              message: "Impossible d'envoyer le devis au client : verdict d'assurance défavorable.",
              code: "insurance_gate",
              decision: {
                arm: decision.arm,
                proceed: decision.proceed,
                overridable: decision.overridable,
                reason: decision.reason,
                liveVerdictHttpStatus: decision.liveVerdictHttpStatus,
                liveVerdictCanProceed: decision.liveVerdictCanProceed,
                liveVerdictResponse: decision.liveVerdictResponse,
                mirrorStatus: decision.mirrorStatus,
                mirrorSyncedAt: decision.mirrorSyncedAt.toISOString(),
                liveAttempted: decision.liveAttempted,
              },
            });
          }
        }
      }
    }

    const hasContractorChange =
      Object.prototype.hasOwnProperty.call(req.body, "contractorId") &&
      Number(req.body.contractorId) !== before.contractorId;

    let nextContractor = null as Awaited<ReturnType<typeof storage.getContractor>> | null;
    let prevContractor = null as Awaited<ReturnType<typeof storage.getContractor>> | null;

    if (hasContractorChange) {
      if (before.status === "void") {
        return res.status(409).json({ message: "Cannot change contractor on a void devis" });
      }
      const project = await storage.getProject(before.projectId);
      if (project?.archivedAt) {
        return res.status(409).json({ message: "Cannot change contractor on an archived project" });
      }
      const target = await storage.getContractor(Number(req.body.contractorId));
      if (!target) {
        return res.status(404).json({ message: "Contractor not found" });
      }
      if (target.archidocOrphanedAt) {
        return res
          .status(409)
          .json({ message: "Selected contractor has been removed from ArchiDoc and cannot be assigned to new devis" });
      }
      nextContractor = target;
      prevContractor = (await storage.getContractor(before.contractorId)) ?? null;
    }

    // Structured devis-code (Task #176): when the architect submits the
    // three-part composer through the edit dialog, validate uniqueness,
    // compose the display string, and merge the structured-column updates
    // into the patch payload. Strip the virtual `lotCode` field so it
    // doesn't leak into the storage layer.
    const patchBody: Record<string, unknown> = { ...req.body };
    const lotCodePart = (patchBody as { lotCode?: NonNullable<z.infer<typeof lotCodePatchSchema>> }).lotCode;
    delete patchBody.lotCode;
    if (lotCodePart) {
      const result = await buildLotCodeUpdates(before.projectId, lotCodePart, {
        excludeDevisId: id,
      });
      if (!result.ok) {
        return res.status(result.status).json(result.body);
      }
      Object.assign(patchBody, result.updates);
    }

    const d = await storage.updateDevis(id, normalizeDevisText(patchBody));
    if (!d) return res.status(404).json({ message: "Devis not found" });
    // Lifecycle-bound auto-revoke: if this edit lowered the contracted HT
    // (or otherwise pushed the devis to fully-invoiced), retire the active
    // contractor portal token now. Cheap no-op when the predicate doesn't
    // hold or when no token is active.
    await storage.revokeDevisCheckTokenIfFullyInvoiced(id);

    if (hasContractorChange && nextContractor) {
      await storage.createDevisRefEdit({
        devisId: id,
        field: "contractorId",
        previousValue: `${before.contractorId}:${prevContractor?.name ?? `#${before.contractorId}`}`,
        newValue: `${nextContractor.id}:${nextContractor.name}`,
        editedByUserId: user.id,
        editedByEmail: user.email,
      });
    }

    if (before.status !== "draft") {
      const auditFields: Array<"devisCode" | "devisNumber" | "ref2"> = ["devisCode", "devisNumber", "ref2"];
      // The structured composer rewrites `devisCode` indirectly via the
      // `lotCode` field; treat that as an explicit edit for audit purposes.
      const sentDevisCodeIndirectly = lotCodePart != null;
      for (const f of auditFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, f) || (f === "devisCode" && sentDevisCodeIndirectly)) {
          const prev = (before[f] ?? null) as string | null;
          const next = (d[f] ?? null) as string | null;
          if ((prev ?? "") !== (next ?? "")) {
            await storage.createDevisRefEdit({
              devisId: id,
              field: f,
              previousValue: prev,
              newValue: next,
              editedByUserId: user.id,
              editedByEmail: user.email,
            });
          }
        }
      }
    }
    res.json(d);
  },
);

router.get(
  "/api/devis/:id/ref-edits",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const edits = await storage.getDevisRefEdits(Number(req.params.id));
    res.json(edits);
  },
);

router.get("/api/devis/:devisId/line-items", async (req, res) => {
  const items = await storage.getDevisLineItems(Number(req.params.devisId));
  res.json(items);
});

router.post(
  "/api/devis/:devisId/line-items",
  validateRequest({ params: devisIdParams, body: createLineItemBodySchema }),
  async (req, res) => {
    const item = await storage.createDevisLineItem({ ...normalizeLineItemText({ ...req.body }), devisId: Number(req.params.devisId) });
    res.status(201).json(item);
  },
);

router.patch(
  "/api/line-items/:id",
  requireAuth,
  validateRequest({ params: idParams, body: updateLineItemSchema }),
  async (req, res) => {
    const lineItemId = Number(req.params.id);
    const item = await storage.updateDevisLineItem(lineItemId, normalizeLineItemText({ ...req.body }));
    if (!item) return res.status(404).json({ message: "Line item not found" });

    // Auto-create / refresh a contractor check whenever the architect flags
    // a line item red or amber. Notes are optional — if the architect didn't
    // capture a specific question yet, we open the check with a French
    // suggestion derived from the line description + amount so the architect
    // gets a usable starting point, refinable via the inline popover editor.
    //
    // Un-flagging behaviour (Variant B inline-popover graduation): if the
    // architect toggles the line back to unchecked/green AND the open
    // line-item check is still a pure draft (status='open' with no messages
    // exchanged yet), drop it — matches the variant's mental model where
    // un-clicking ✕ retracts the question. Once any message has been
    // exchanged, resolution stays manual to avoid silently losing context.
    const becameFlagged = item.checkStatus === "red" || item.checkStatus === "amber";
    const userId = req.session?.userId ? Number(req.session.userId) : null;
    if (becameFlagged) {
      const note = (item.checkNotes ?? "").trim();
      const formattedTotal = formatLineTotalForSuggestion(item.totalHt);
      const query = note.length > 0
        ? note
        : `Pouvez-vous préciser le détail de la ligne « ${item.description} » ? (montant ${formattedTotal} € HT)`;
      await storage.upsertLineItemCheck(item.devisId, lineItemId, query, userId);
    } else {
      // Un-flagged → retract any pure-draft line-item check.
      const openChecks = await storage.listDevisChecks(item.devisId);
      const draft = openChecks.find(
        (c) => c.lineItemId === lineItemId && c.origin === "line_item" && c.status === "open",
      );
      if (draft) {
        const messages = await storage.listDevisCheckMessages(draft.id);
        if (messages.length === 0) {
          await storage.updateDevisCheck(draft.id, {
            status: "dropped",
            resolvedAt: new Date(),
            resolvedByUserId: userId ?? undefined,
          });
        }
      }
    }
    res.json(item);
  },
);

router.delete(
  "/api/line-items/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    await storage.deleteDevisLineItem(Number(req.params.id));
    res.status(204).send();
  },
);

router.get("/api/devis/:devisId/avenants", async (req, res) => {
  const avs = await storage.getAvenantsByDevis(Number(req.params.devisId));
  res.json(avs);
});

router.post(
  "/api/devis/:devisId/avenants",
  validateRequest({ params: devisIdParams, body: createAvenantBodySchema }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const av = await storage.createAvenant({ ...normalizeDevisText({ ...req.body }), devisId });
    // Approved PV/MV avenants change the adjusted contracted HT used by the
    // fully-invoiced predicate. Cheap no-op when the avenant is still draft
    // or doesn't tip the devis past its invoiced total.
    await storage.revokeDevisCheckTokenIfFullyInvoiced(devisId);
    res.status(201).json(av);
  },
);

router.patch(
  "/api/avenants/:id",
  validateRequest({ params: idParams, body: updateAvenantSchema }),
  async (req, res) => {
    const av = await storage.updateAvenant(Number(req.params.id), normalizeDevisText({ ...req.body }));
    if (!av) return res.status(404).json({ message: "Avenant not found" });
    await storage.revokeDevisCheckTokenIfFullyInvoiced(av.devisId);
    res.json(av);
  },
);

router.post(
  "/api/devis/:id/confirm",
  validateRequest({ params: idParams, body: devisConfirmSchema }),
  async (req, res) => {
    try {
      const devis = await storage.getDevis(Number(req.params.id));
      if (!devis) return res.status(404).json({ message: "Devis not found" });
      if (devis.status !== "draft") return res.status(400).json({ message: "Only draft devis can be confirmed" });

      const corrections = req.body;
      const updates: Record<string, unknown> = { status: "pending" };

      // TVA-neutral: HT and TTC are independent values from the document.
      // We persist whatever the user confirms; tvaAmount is always derivable
      // as TTC − HT. No rate-based gross-up.
      if (corrections.amountHt != null) updates.amountHt = String(roundCurrency(corrections.amountHt));
      if (corrections.amountTtc != null) updates.amountTtc = String(roundCurrency(corrections.amountTtc));
      if (corrections.devisCode != null) updates.devisCode = corrections.devisCode;
      if (corrections.devisNumber != null) updates.devisNumber = corrections.devisNumber;
      if (corrections.descriptionFr != null) updates.descriptionFr = toSentenceCase(corrections.descriptionFr);
      if (corrections.dateSent != null) updates.dateSent = corrections.dateSent;

      // Structured devis-code (Task #176). When the architect submitted the
      // three-part composer, validate uniqueness server-side, persist the
      // structured columns, and overwrite `devisCode` with the composed
      // string. The composer's output takes precedence over any free-text
      // `devisCode` correction in the same payload.
      if (corrections.lotCode) {
        const result = await buildLotCodeUpdates(devis.projectId, corrections.lotCode, {
          excludeDevisId: devis.id,
        });
        if (!result.ok) {
          return res.status(result.status).json(result.body);
        }
        Object.assign(updates, result.updates);
      }

      let nextWarnings = (devis.validationWarnings as ValidationWarning[] | null) ?? [];
      const aiData = (devis.aiExtractedData as Record<string, unknown> | null) ?? {};
      if (Object.keys(corrections).length > 0) {
        const correctedParsed = { ...aiData, ...corrections } as ParsedDocument;
        const revalidation = validateExtraction(correctedParsed);
        const lotWarnings = await checkLotReferencesAgainstCatalog(correctedParsed);
        nextWarnings = [...revalidation.warnings, ...lotWarnings];
        updates.validationWarnings = nextWarnings;
        updates.aiConfidence = revalidation.confidenceScore;
      } else {
        const lotWarnings = await checkLotReferencesAgainstCatalog(aiData as unknown as ParsedDocument);
        if (lotWarnings.length > 0) {
          const existingMessages = new Set(nextWarnings.map((w) => w.message));
          const merged = [
            ...nextWarnings,
            ...lotWarnings.filter((w) => !existingMessages.has(w.message)),
          ];
          if (merged.length !== nextWarnings.length) {
            nextWarnings = merged;
            updates.validationWarnings = nextWarnings;
          }
        }
      }

      // Defense-in-depth: the confirm path must never mutate lot assignment
      // or lot descriptions. lotId is only set via the assign-from-catalog
      // flow (server/routes/lot-catalog.ts). The confirm schema already
      // rejects unknown fields like `lotId`, but we strip any leakage here
      // as a hard guard.
      delete (updates as Record<string, unknown>).lotId;

      const { devis: updated, inserted } = await confirmDevisAndMirror(Number(req.params.id), updates);
      if (updated) {
        // Confirm may have written a corrected amountHt; re-evaluate the
        // fully-invoiced predicate.
        await storage.revokeDevisCheckTokenIfFullyInvoiced(updated.id);
      }
      try {
        await reconcileAdvisories({ devisId: Number(req.params.id) }, nextWarnings);
      } catch (advErr) {
        console.warn("[Devis Confirm] Advisory reconciliation failed:", advErr);
      }
      if (updated && inserted.length > 0) {
        await assignTagsForInsertedItems(inserted);
      }
      if (updated) {
        triggerDevisTranslation(updated.id);
      }
      res.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Confirm failed: ${message}` });
    }
  },
);

router.get("/api/devis/:id/advisories", async (req, res) => {
  const items = await getAdvisoriesForDevis(Number(req.params.id));
  res.json(items);
});

router.post(
  "/api/devis/:id/advisories/:advisoryId/acknowledge",
  requireAuth,
  validateRequest({ params: advisoryAckParams }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const advisoryId = Number(req.params.advisoryId);
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const row = await acknowledgeAdvisoryForSubject(
      advisoryId,
      { devisId },
      String(userId),
    );
    if (!row) {
      return res
        .status(404)
        .json({ message: "Advisory not found, already acknowledged, or not on this devis" });
    }
    res.json(row);
  },
);

export default router;
