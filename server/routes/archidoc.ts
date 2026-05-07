import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { isArchidocConfigured, checkConnection } from "../archidoc/sync-client";
import { fullSync, incrementalSync, getLastSyncStatus, getCurrentSourceBaseUrl } from "../archidoc/sync-service";
import { trackProject, refreshProject } from "../archidoc/import-service";
import { env as envCfg, detectMisconfiguredArchidocBaseUrl } from "../env";
import { validateRequest } from "../middleware/validate";
import {
  moveDocument,
  buildDesignContractActiveObjectName,
  isStagingKeyOwnedBy,
} from "../storage/object-storage";
import { roundCurrency } from "../../shared/financial-utils";
import { validateConfirmedSchedule } from "../services/design-contract-parser";
import {
  DESIGN_CONTRACT_TRIGGER_EVENTS,
  type InsertDesignContract,
  type InsertDesignContractMilestone,
} from "@shared/schema";
import { DESIGN_CONTRACT_ERROR_CODES } from "../../shared/design-contract-errors";

const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });
const archidocProjectIdParams = z.object({ archidocProjectId: z.string().min(1) });
const trackBodySchema = z.record(z.string(), z.unknown()).optional().default({});

router.get("/api/archidoc/status", async (_req, res) => {
  try {
    const syncStatus = await getLastSyncStatus();
    const mirroredProjects = await storage.getArchidocProjects();
    const mirroredContractors = await storage.getArchidocContractors();
    const trackedIds = await storage.getTrackedArchidocProjectIds();
    const siretIssues = await storage.getArchidocSiretIssues();

    let connected = false;
    let connectionError: string | undefined;

    if (isArchidocConfigured()) {
      const connResult = await checkConnection();
      connected = connResult.connected;
      connectionError = connResult.error;
    }

    // Derive a short host identifier from ARCHIDOC_BASE_URL so the UI
    // can warn the operator when the deployed Architrak is pointing at
    // the wrong Archidoc backend (Task #164 root cause: prod sync was
    // hitting riker.replit.dev for a week, surfacing dev fixtures).
    const sourceBaseUrl = getCurrentSourceBaseUrl();
    let sourceHost: string | null = null;
    if (sourceBaseUrl) {
      try {
        sourceHost = new URL(sourceBaseUrl).host;
      } catch {
        sourceHost = sourceBaseUrl;
      }
    }

    res.json({
      configured: syncStatus.configured,
      connected,
      connectionError,
      lastSync: syncStatus.lastSync,
      lastSyncType: syncStatus.lastSyncType,
      lastSyncStatus: syncStatus.lastSyncStatus,
      mirroredProjects: mirroredProjects.length,
      mirroredContractors: mirroredContractors.length,
      trackedProjects: trackedIds.length,
      siretIssueCount: siretIssues.length,
      sourceBaseUrl,
      sourceHost,
      // Task #165: surface a server-evaluated "this prod app is wired
      // to a dev backend" verdict so the Projects page can render a
      // non-dismissible banner. Predicate is shared with the boot WARN
      // in env.ts (single source of truth).
      hostMisconfigured:
        detectMisconfiguredArchidocBaseUrl({
          NODE_ENV: envCfg.NODE_ENV,
          ARCHIDOC_BASE_URL: envCfg.ARCHIDOC_BASE_URL,
        }) !== null,
      nodeEnv: envCfg.NODE_ENV,
      webhookEnabled: true,
      webhookSecretConfigured: !!envCfg.ARCHIDOC_WEBHOOK_SECRET,
      pollingEnabled: envCfg.ARCHIDOC_POLLING_ENABLED,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Failed to get ArchiDoc status: ${message}` });
  }
});

router.get("/api/archidoc/projects", async (_req, res) => {
  try {
    const mirroredProjects = await storage.getArchidocProjects();
    const trackedIds = await storage.getTrackedArchidocProjectIds();
    const allProjects = await storage.getProjects({ includeArchived: true });

    const enriched = mirroredProjects.map((mp) => {
      const isTracked = trackedIds.includes(mp.archidocId);
      const architrakProject = isTracked
        ? allProjects.find((p) => p.archidocId === mp.archidocId)
        : undefined;

      return {
        ...mp,
        isTracked,
        architrakProjectId: architrakProject?.id || null,
      };
    });

    res.json(enriched);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Failed to get ArchiDoc projects: ${message}` });
  }
});

router.post("/api/archidoc/sync", validateRequest({ body: z.object({}).strict().optional() }), async (_req, res) => {
  try {
    const result = await fullSync();
    res.json({ message: "Sync completed", ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Sync failed: ${message}` });
  }
});

router.post(
  "/api/archidoc/track/:archidocProjectId",
  validateRequest({ params: archidocProjectIdParams, body: trackBodySchema }),
  async (req, res) => {
    try {
      const archidocProjectId = String(req.params.archidocProjectId);
      const result = await trackProject(archidocProjectId, (req.body ?? {}) as Record<string, unknown>);
      res.status(201).json({
        message: "Project tracked successfully",
        ...result,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("already tracked") ? 409 : 500;
      res.status(status).json({ message });
    }
  },
);

/**
 * Atomic project-tracking + design-contract persistence.
 *
 * The New Project dialog calls this single endpoint with the Archidoc
 * tracking inputs AND the architect-confirmed contract payload. We:
 *   1. trackProject(...) — creates the projects row + contractors + lots.
 *   2. validate the confirmed schedule + ownership of the staging key.
 *   3. move the staged PDF to its final location.
 *   4. replaceDesignContractForProject(...) — single-tx insert of contract
 *      + milestones + project fee mirror + fees rows.
 * If steps 2–4 fail, we roll back step 1 by hard-deleting the just-created
 * project (cascade removes contractors / lots) so the user is never left
 * with a half-created project that has no contract.
 */
const trackWithContractMilestoneSchema = z.object({
  sequence: z.number().int().positive(),
  labelFr: z.string().trim().min(1),
  labelEn: z.string().trim().min(1).nullable().optional(),
  percentage: z.coerce.number().min(0).max(100),
  amountTtc: z.coerce.number().nonnegative(),
  triggerEvent: z.enum(DESIGN_CONTRACT_TRIGGER_EVENTS),
});
const trackWithContractBodySchema = z.object({
  trackOptions: z.object({
    feeType: z.string().optional(),
    feePercentage: z.string().nullable().optional(),
    hasMarche: z.boolean().optional(),
  }).passthrough().optional().default({}),
  designContract: z.object({
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
    milestones: z.array(trackWithContractMilestoneSchema).min(1),
  }),
});

router.post(
  "/api/archidoc/track-with-contract/:archidocProjectId",
  validateRequest({ params: archidocProjectIdParams, body: trackWithContractBodySchema }),
  async (req, res) => {
    const archidocProjectId = String(req.params.archidocProjectId);
    const body = req.body as z.infer<typeof trackWithContractBodySchema>;
    const userId = (req.session as { userId?: number } | undefined)?.userId ?? 0;

    // Pre-flight ownership + schedule validation BEFORE we mutate anything.
    if (!userId || !isStagingKeyOwnedBy(body.designContract.stagingKey, userId)) {
      return res.status(403).json({
        code: DESIGN_CONTRACT_ERROR_CODES.INVALID_PDF,
        message: "Staging key does not belong to the current session",
      });
    }
    const totalTtc = roundCurrency(body.designContract.totalTtc);
    const validation = validateConfirmedSchedule(
      totalTtc,
      body.designContract.milestones.map((m) => ({
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

    let createdProjectId: number | null = null;
    try {
      const trackResult = await trackProject(archidocProjectId, {
        feeType: body.trackOptions.feeType,
        feePercentage: body.trackOptions.feePercentage ?? undefined,
        hasMarche: body.trackOptions.hasMarche,
      });
      createdProjectId = trackResult.projectId;
      if (!createdProjectId) {
        return res.status(500).json({ message: "trackProject returned no projectId" });
      }

      const finalKey = await moveDocument(
        body.designContract.stagingKey,
        buildDesignContractActiveObjectName(createdProjectId, body.designContract.originalFilename),
      );

      const conceptionHt = body.designContract.conceptionAmountHt != null
        ? roundCurrency(body.designContract.conceptionAmountHt) : null;
      const planningHt = body.designContract.planningAmountHt != null
        ? roundCurrency(body.designContract.planningAmountHt) : null;

      const contractInsert: InsertDesignContract = {
        projectId: createdProjectId,
        storageKey: finalKey,
        originalFilename: body.designContract.originalFilename,
        totalHt: body.designContract.totalHt != null ? roundCurrency(body.designContract.totalHt).toFixed(2) : null,
        totalTva: body.designContract.totalTva != null ? roundCurrency(body.designContract.totalTva).toFixed(2) : null,
        totalTtc: totalTtc.toFixed(2),
        tvaRate: body.designContract.tvaRate != null ? roundCurrency(body.designContract.tvaRate).toFixed(2) : null,
        conceptionAmountHt: conceptionHt != null ? conceptionHt.toFixed(2) : null,
        planningAmountHt: planningHt != null ? planningHt.toFixed(2) : null,
        contractDate: body.designContract.contractDate ?? null,
        contractReference: body.designContract.contractReference ?? null,
        clientName: body.designContract.clientName ?? null,
        architectName: body.designContract.architectName ?? null,
        projectAddress: body.designContract.projectAddress ?? null,
        extractionConfidence: body.designContract.extractionConfidence ?? null,
        extractionWarnings: body.designContract.extractionWarnings ?? null,
        uploadedByUserId: userId,
      };

      const milestoneInserts: Omit<InsertDesignContractMilestone, "contractId">[] =
        body.designContract.milestones.map((m) => ({
          sequence: m.sequence,
          labelFr: m.labelFr,
          labelEn: m.labelEn ?? null,
          percentage: roundCurrency(m.percentage).toFixed(2),
          amountTtc: roundCurrency(m.amountTtc).toFixed(2),
          triggerEvent: m.triggerEvent,
        }));

      const feeMirrors: Array<{ feeType: "conception" | "planning"; amountHt: string }> = [];
      if (conceptionHt != null) feeMirrors.push({ feeType: "conception", amountHt: conceptionHt.toFixed(2) });
      if (planningHt != null) feeMirrors.push({ feeType: "planning", amountHt: planningHt.toFixed(2) });

      const result = await storage.replaceDesignContractForProject(
        createdProjectId,
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

      // Auto-mark file_opened milestones as reached (lifecycle event).
      const fileOpened = result.milestones.find((m) => m.triggerEvent === "file_opened" && m.status === "pending");
      if (fileOpened) {
        await storage.updateDesignContractMilestone(fileOpened.id, { status: "reached", reachedAt: new Date() });
      }

      return res.status(201).json({
        message: "Project tracked and design contract saved",
        projectId: createdProjectId,
        contractorsCreated: trackResult.contractorsCreated,
        lotsCreated: trackResult.lotsCreated,
        contractId: result.contract.id,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Rollback step 1 on any failure in steps 2–4 so the user is never
      // left with a project that has no contract. cascade FKs handle
      // contractors + lots.
      if (createdProjectId != null) {
        try { await storage.deleteProject(createdProjectId); } catch (rollbackErr) {
          console.error(`[track-with-contract] rollback delete failed for project ${createdProjectId}:`, rollbackErr);
        }
      }
      const status = message.includes("already tracked") ? 409 : 500;
      return res.status(status).json({ message });
    }
  },
);

router.post(
  "/api/projects/:id/refresh",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const projectId = Number(req.params.id);
      await incrementalSync();
      const result = await refreshProject(projectId);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Refresh failed: ${message}` });
    }
  },
);

router.get("/api/archidoc/siret-issues", async (_req, res) => {
  try {
    const issues = await storage.getArchidocSiretIssues();
    res.json(issues);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Failed to load SIRET issues: ${message}` });
  }
});

router.get("/api/archidoc/proposal-fees/:archidocProjectId", async (req, res) => {
  try {
    const fees = await storage.getArchidocProposalFees(req.params.archidocProjectId);
    res.json(fees.length > 0 ? fees[0] : null);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message });
  }
});

export default router;
