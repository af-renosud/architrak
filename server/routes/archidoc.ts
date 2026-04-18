import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { isArchidocConfigured, checkConnection } from "../archidoc/sync-client";
import { fullSync, incrementalSync, getLastSyncStatus } from "../archidoc/sync-service";
import { trackProject, refreshProject } from "../archidoc/import-service";
import { env as envCfg } from "../env";
import { validateRequest } from "../middleware/validate";

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

    let connected = false;
    let connectionError: string | undefined;

    if (isArchidocConfigured()) {
      const connResult = await checkConnection();
      connected = connResult.connected;
      connectionError = connResult.error;
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
