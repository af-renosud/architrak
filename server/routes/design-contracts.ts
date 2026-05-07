/**
 * REST surface for the design contract upload + review flow.
 *
 *   POST /api/design-contracts/preview         — multipart PDF, stages to
 *                                                 object storage, runs Gemini
 *                                                 extraction, returns the
 *                                                 review-modal payload.
 *   POST /api/projects/:id/design-contract     — confirm + persist (replace if
 *                                                 already present, archiving
 *                                                 the prior PDF).
 *   GET  /api/projects/:id/design-contract     — fetch contract + milestones
 *                                                 for the project detail card.
 *   GET  /api/design-contracts/:id/pdf         — authenticated PDF stream for
 *                                                 the inline iframe viewer.
 *   PATCH /api/design-contracts/milestones/:id — update status / notes (also
 *                                                 used by the manual
 *                                                 "Mark reached" button).
 *   GET  /api/design-contracts/dashboard-actions — strip of reached-but-not-
 *                                                 invoiced milestones for
 *                                                 the dashboard reminder strip.
 */
import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { upload, assertPdfMagic } from "../middleware/upload";
import { validateRequest } from "../middleware/validate";
import {
  getDocumentStream,
  moveDocument,
  buildDesignContractActiveObjectName,
  buildDesignContractArchiveObjectName,
  uploadStagingDesignContract,
  isStagingKeyOwnedBy,
} from "../storage/object-storage";
import { roundCurrency as round2 } from "../../shared/financial-utils";
import {
  parseDesignContract,
  validateConfirmedSchedule,
  type ExtractedDesignContract,
} from "../services/design-contract-parser";
import { roundCurrency } from "../../shared/financial-utils";
import { DESIGN_CONTRACT_ERROR_CODES } from "../../shared/design-contract-errors";
import {
  DESIGN_CONTRACT_TRIGGER_EVENTS,
  DESIGN_CONTRACT_MILESTONE_STATUSES,
  type InsertDesignContract,
  type InsertDesignContractMilestone,
} from "@shared/schema";

const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });
const milestoneIdParams = z.object({ id: z.coerce.number().int().positive() });

const milestoneInputSchema = z.object({
  sequence: z.number().int().positive(),
  labelFr: z.string().trim().min(1),
  labelEn: z.string().trim().min(1).nullable().optional(),
  percentage: z.coerce.number().min(0).max(100),
  amountTtc: z.coerce.number().nonnegative(),
  triggerEvent: z.enum(DESIGN_CONTRACT_TRIGGER_EVENTS),
});

const confirmContractSchema = z.object({
  stagingKey: z.string().min(1),
  originalFilename: z.string().min(1),
  totalHt: z.coerce.number().nonnegative().nullable().optional(),
  totalTva: z.coerce.number().nonnegative().nullable().optional(),
  totalTtc: z.coerce.number().positive(),
  tvaRate: z.coerce.number().nonnegative().max(100).nullable().optional(),
  conceptionAmountHt: z.coerce.number().nonnegative().nullable().optional(),
  planningAmountHt: z.coerce.number().nonnegative().nullable().optional(),
  contractDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  contractReference: z.string().trim().min(1).nullable().optional(),
  clientName: z.string().trim().min(1).nullable().optional(),
  architectName: z.string().trim().min(1).nullable().optional(),
  projectAddress: z.string().trim().min(1).nullable().optional(),
  extractionConfidence: z.record(z.string(), z.number()).nullable().optional(),
  extractionWarnings: z.array(z.string()).nullable().optional(),
  milestones: z.array(milestoneInputSchema).min(1),
});

export type ConfirmDesignContractBody = z.infer<typeof confirmContractSchema>;

const milestonePatchSchema = z.object({
  status: z.enum(DESIGN_CONTRACT_MILESTONE_STATUSES).optional(),
  notes: z.string().nullable().optional(),
  triggerEvent: z.enum(DESIGN_CONTRACT_TRIGGER_EVENTS).optional(),
}).refine((v) => v.status !== undefined || v.notes !== undefined || v.triggerEvent !== undefined, {
  message: "At least one of status / notes / triggerEvent is required",
});

router.use(requireAuth);

/**
 * POST /api/design-contracts/preview — multipart upload (single PDF, ≤25 MiB),
 * stages it under `design-contracts/staging/<timestamp>_<file>.pdf`, then
 * runs the Gemini extractor and returns the editable extraction payload.
 *
 * The staged PDF stays in object storage even if the architect cancels; a
 * future cleanup job can sweep the staging prefix. Confirm step (POST
 * /api/projects/:id/design-contract) persists a row keyed off the same
 * storage key — there's no copy / move boundary because the object key
 * already encodes the project once the project is known.
 */
router.post(
  "/api/design-contracts/preview",
  upload.single("file"),
  async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({
          code: DESIGN_CONTRACT_ERROR_CODES.INVALID_PDF,
          message: "PDF file is required (form field name: 'file')",
        });
      }
      try {
        assertPdfMagic(file.buffer);
      } catch {
        return res.status(415).json({
          code: DESIGN_CONTRACT_ERROR_CODES.INVALID_PDF,
          message: "File is not a valid PDF",
        });
      }
      // Staging key is namespaced by the uploader's session id so the
      // preview-pdf streamer + confirm endpoint can verify ownership
      // before serving / mutating — without this binding any
      // authenticated user could iframe-stream or move another user's
      // staged contract by guessing the timestamp prefix.
      const userId = (req.session as { userId?: number } | undefined)?.userId ?? 0;
      if (!userId) {
        return res.status(401).json({ message: "Authenticated session required" });
      }
      const stagingKey = await uploadStagingDesignContract(
        userId,
        file.originalname,
        file.buffer,
        file.mimetype || "application/pdf",
      );

      const extracted = await parseDesignContract(file.buffer, file.originalname);

      if (extracted.transientFailure) {
        return res.status(503).json({
          code: DESIGN_CONTRACT_ERROR_CODES.AI_TRANSIENT,
          message: extracted.errorMessage || "AI extraction temporarily unavailable",
          stagingKey,
          originalFilename: file.originalname,
        });
      }
      if (extracted.documentType !== "design_contract") {
        return res.status(422).json({
          code: DESIGN_CONTRACT_ERROR_CODES.NOT_A_DESIGN_CONTRACT,
          message:
            extracted.errorMessage ||
            "This PDF doesn't look like a design-services contract. Please upload a Contrat de maîtrise d'œuvre / Contrat d'architecte.",
          extracted,
          stagingKey,
          originalFilename: file.originalname,
        });
      }

      return res.status(200).json({
        stagingKey,
        originalFilename: file.originalname,
        extracted,
      });
    } catch (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({
          code: DESIGN_CONTRACT_ERROR_CODES.INVALID_PDF,
          message: err.message,
        });
      }
      next(err);
    }
  },
);

/**
 * POST /api/projects/:id/design-contract — confirm + persist. If the project
 * already has a contract, the prior PDF is best-effort deleted from object
 * storage and the rows are replaced atomically (one contract per project).
 */
router.post(
  ["/api/projects/:id/design-contract", "/api/design-contracts/confirm/:id"],
  validateRequest({ params: idParams, body: confirmContractSchema }),
  async (req, res, next) => {
    try {
      const projectId = Number(req.params.id);
      const body = req.body as ConfirmDesignContractBody;

      const project = await storage.getProject(projectId);
      if (!project) {
        return res.status(404).json({
          code: DESIGN_CONTRACT_ERROR_CODES.PROJECT_NOT_FOUND,
          message: `Project ${projectId} not found`,
        });
      }

      const totalTtc = roundCurrency(body.totalTtc);
      const milestones = body.milestones.map((m) => ({
        sequence: m.sequence,
        labelFr: m.labelFr,
        labelEn: m.labelEn ?? null,
        percentage: roundCurrency(m.percentage).toFixed(2),
        amountTtc: roundCurrency(m.amountTtc).toFixed(2),
        triggerEvent: m.triggerEvent,
      }));

      const validation = validateConfirmedSchedule(
        totalTtc,
        body.milestones.map((m) => ({
          sequence: m.sequence,
          labelFr: m.labelFr,
          labelEn: m.labelEn ?? null,
          percentage: m.percentage,
          amountTtc: m.amountTtc,
          triggerEvent: m.triggerEvent,
        })),
      );
      if (!validation.ok) {
        return res.status(422).json({ code: validation.code, message: validation.detail });
      }

      const userId = (req.session as { userId?: number } | undefined)?.userId ?? null;

      // Server-side ownership validation: the confirm endpoint accepts a
      // raw stagingKey from the client, so without this check an
      // authenticated user could pass any object key (including another
      // tenant's blob) and we'd happily move/delete it. The staging path
      // was minted with `staging/u{userId}/` baked in by the preview
      // endpoint; reject anything that doesn't carry the matching segment.
      if (!userId || !isStagingKeyOwnedBy(body.stagingKey, userId)) {
        return res.status(403).json({
          code: DESIGN_CONTRACT_ERROR_CODES.INVALID_PDF,
          message: "Staging key does not belong to the current session",
        });
      }

      // Per task spec: move staged PDF to its final
      // `design-contracts/{projectId}/active/{ts}_{slug}.pdf` location
      // BEFORE writing the row, so the persisted storage_key always
      // points to the canonical path. If the move fails we abort and
      // surface a 502; the staging blob remains for retry.
      const finalKey = await moveDocument(
        body.stagingKey,
        buildDesignContractActiveObjectName(projectId, body.originalFilename),
      );

      const contractInsert: InsertDesignContract = {
        projectId,
        storageKey: finalKey,
        originalFilename: body.originalFilename,
        totalHt: body.totalHt != null ? roundCurrency(body.totalHt).toFixed(2) : null,
        totalTva: body.totalTva != null ? roundCurrency(body.totalTva).toFixed(2) : null,
        totalTtc: totalTtc.toFixed(2),
        tvaRate: body.tvaRate != null ? roundCurrency(body.tvaRate).toFixed(2) : null,
        conceptionAmountHt: body.conceptionAmountHt != null ? roundCurrency(body.conceptionAmountHt).toFixed(2) : null,
        planningAmountHt: body.planningAmountHt != null ? roundCurrency(body.planningAmountHt).toFixed(2) : null,
        contractDate: body.contractDate ?? null,
        contractReference: body.contractReference ?? null,
        clientName: body.clientName ?? null,
        architectName: body.architectName ?? null,
        projectAddress: body.projectAddress ?? null,
        extractionConfidence: body.extractionConfidence ?? null,
        extractionWarnings: body.extractionWarnings ?? null,
        uploadedByUserId: userId,
      };

      const milestoneInserts: Omit<InsertDesignContractMilestone, "contractId">[] = milestones;

      // Mirror data computed up-front so the storage transaction can
      // apply the project + fees changes atomically with the contract
      // row replacement (no partial-persistence window).
      const conceptionHt = body.conceptionAmountHt != null ? round2(body.conceptionAmountHt) : null;
      const planningHt = body.planningAmountHt != null ? round2(body.planningAmountHt) : null;
      const feeMirrors: Array<{ feeType: "conception" | "planning"; amountHt: string }> = [];
      if (conceptionHt != null) feeMirrors.push({ feeType: "conception", amountHt: conceptionHt.toFixed(2) });
      if (planningHt != null) feeMirrors.push({ feeType: "planning", amountHt: planningHt.toFixed(2) });

      const result = await storage.replaceDesignContractForProject(
        projectId,
        contractInsert,
        milestoneInserts,
        {
          projectFeeMirror: {
            conceptionFee: conceptionHt != null ? conceptionHt.toFixed(2) : null,
            planningFee: planningHt != null ? planningHt.toFixed(2) : null,
          },
          feeMirrors,
        },
      );

      // Per task spec: archive (don't hard-delete) the prior PDF blob
      // under `design-contracts/{projectId}/archive/...`. Failures here
      // MUST NOT roll back the row replacement — operators can clean
      // up orphaned blobs separately.
      if (result.previousStorageKey && result.previousStorageKey !== finalKey) {
        try {
          await moveDocument(
            result.previousStorageKey,
            buildDesignContractArchiveObjectName(projectId, result.previousStorageKey),
          );
        } catch (err) {
          console.warn(
            `[design-contracts] Failed to archive prior PDF blob "${result.previousStorageKey}":`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Auto-trigger: if a milestone is mapped to file_opened, mark it
      // reached now (the project is being created/refreshed at this
      // exact lifecycle event).
      const fileOpenedMilestone = result.milestones.find(
        (m) => m.triggerEvent === "file_opened" && m.status === "pending",
      );
      if (fileOpenedMilestone) {
        await storage.updateDesignContractMilestone(fileOpenedMilestone.id, {
          status: "reached",
          reachedAt: new Date(),
        });
      }

      return res.status(201).json({
        contract: result.contract,
        milestones: await storage.getDesignContractMilestones(result.contract.id),
        replaced: result.previousStorageKey !== null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/projects/:id/design-contract — read for the project detail card
 * and the dashboard. Returns 404 (not 200 with null) so React Query treats
 * "no contract yet" as a queryable empty state.
 */
router.get(
  "/api/projects/:id/design-contract",
  validateRequest({ params: idParams }),
  async (req, res, next) => {
    try {
      const projectId = Number(req.params.id);
      const contract = await storage.getDesignContractByProject(projectId);
      if (!contract) return res.status(404).json({ message: "No design contract on this project" });
      const milestones = await storage.getDesignContractMilestones(contract.id);
      return res.status(200).json({ contract, milestones });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/api/design-contracts/:id/pdf",
  validateRequest({ params: idParams }),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const contract = await storage.getDesignContract(id);
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      const { stream, contentType } = await getDocumentStream(contract.storageKey);
      res.setHeader("Content-Type", contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${contract.originalFilename.replace(/"/g, "")}"`);
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/design-contracts/preview-pdf?stagingKey=...&filename=...
 * Streams the staged PDF before persistence so the review modal iframe can
 * render it. The staging key is already auth-scoped because preview required
 * auth, and the key is opaque to clients (they receive it server-side from
 * the preview response).
 */
router.get(
  "/api/design-contracts/preview-pdf",
  validateRequest({
    query: z.object({
      stagingKey: z.string().min(1),
      filename: z.string().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const stagingKey = String((req.query as { stagingKey: string }).stagingKey);
      const filename = String((req.query as { filename?: string }).filename ?? "design-contract.pdf");
      // Ownership binding: the staging key was minted with the uploader's
      // session id baked into the path (`.../staging/u{userId}/...`).
      // Reject any preview request whose session does not match.
      const userId = (req.session as { userId?: number } | undefined)?.userId ?? 0;
      if (!userId || !isStagingKeyOwnedBy(stagingKey, userId)) {
        return res.status(403).json({ message: "Not your staged contract" });
      }
      const { stream, contentType } = await getDocumentStream(stagingKey);
      res.setHeader("Content-Type", contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/"/g, "")}"`);
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Project-scoped PDF download alias used by the project-detail card.
 * Routes through the same stream helper as `/api/design-contracts/:id/pdf`
 * but accepts the project id (which the card already has in scope) and
 * looks up the contract server-side.
 */
router.get(
  "/api/projects/:id/design-contract/pdf",
  validateRequest({ params: idParams }),
  async (req, res, next) => {
    try {
      const projectId = Number(req.params.id);
      const contract = await storage.getDesignContractByProject(projectId);
      if (!contract) return res.status(404).json({ message: "No design contract on this project" });
      const { stream, contentType } = await getDocumentStream(contract.storageKey);
      res.setHeader("Content-Type", contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${contract.originalFilename.replace(/"/g, "")}"`);
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/api/design-contracts/milestones/:id",
  validateRequest({ params: milestoneIdParams, body: milestonePatchSchema }),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const userId = (req.session as { userId?: number } | undefined)?.userId;
      if (!userId) {
        return res.status(401).json({ message: "Authenticated session required" });
      }
      // Per-project ownership check: only the architect who uploaded the
      // contract may mutate its milestones.
      const existing = await storage.getDesignContractMilestone(id);
      if (!existing) return res.status(404).json({ message: "Milestone not found" });
      const owningContract = await storage.getDesignContract(existing.contractId);
      if (!owningContract) return res.status(404).json({ message: "Contract not found" });
      if (owningContract.uploadedByUserId !== userId) {
        return res.status(403).json({ message: "Not the contract owner" });
      }
      const body = req.body as z.infer<typeof milestonePatchSchema>;
      const patch: Partial<InsertDesignContractMilestone> = {};
      if (body.status) {
        patch.status = body.status;
        if (body.status === "reached") patch.reachedAt = new Date();
        if (body.status === "invoiced") patch.invoicedAt = new Date();
        if (body.status === "paid") patch.paidAt = new Date();
      }
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.triggerEvent) patch.triggerEvent = body.triggerEvent;
      const updated = await storage.updateDesignContractMilestone(id, patch);
      if (!updated) return res.status(404).json({ message: "Milestone not found" });
      return res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/design-contracts/dashboard-actions — drives the dashboard
 * "needs invoicing" strip. Returns reached-but-not-invoiced milestones
 * regardless of staleness (the architect wants to see them as soon as
 * they trigger), with project + contract context.
 */
router.get("/api/design-contracts/dashboard-actions", async (req, res, next) => {
  try {
    const userId = (req.session as { userId?: number } | undefined)?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Authenticated session required" });
    }
    // staleAfterMs=0 / reminderQuietMs=0 → return everything reached, used
    // by the dashboard strip (the daily digest passes the real cutoffs).
    // Scoped by architectUserId so each user only sees their own projects.
    const rows = await storage.getReachedUninvoicedMilestones({
      staleAfterMs: 0,
      reminderQuietMs: 0,
      architectUserId: userId,
    });
    res.json(
      rows.map((r) => ({
        milestoneId: r.milestone.id,
        contractId: r.contract.id,
        projectId: r.project.id,
        projectName: r.project.name,
        projectCode: r.project.code,
        labelFr: r.milestone.labelFr,
        amountTtc: r.milestone.amountTtc,
        reachedAt: r.milestone.reachedAt,
        triggerEvent: r.milestone.triggerEvent,
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
