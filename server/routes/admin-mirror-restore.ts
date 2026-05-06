/**
 * Admin surface to recover from accidentally-cleared archidoc mirror rows
 * (Task #166). Task #164's reconciliation pass soft-deletes mirror rows that
 * disappear from an upstream response. If Archidoc briefly returns an
 * incomplete payload (transient issue) the rows stay hidden until the next
 * full sync re-asserts them. This admin panel lists the soft-deleted rows
 * and lets an operator restore one with a single click.
 *
 * Endpoints:
 *   GET  /api/admin/mirror-restore                                 — list soft-deleted projects + contractors
 *   POST /api/admin/mirror-restore/projects/:archidocId/restore    — clear soft-delete, refresh from upstream
 *   POST /api/admin/mirror-restore/contractors/:archidocId/restore — clear soft-delete, refresh from upstream
 *
 * The restore route always clears the soft-delete flag, then opportunistically
 * re-fetches the row from the configured backend so the mirror is current.
 * Refresh failures are reported to the operator but do NOT roll back the
 * restore — if the backend is mis-configured the operator can still surface
 * the cached row in the UI and decide what to do next.
 */

import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import {
  isArchidocConfigured,
  fetchProjects,
  fetchContractors,
} from "../archidoc/sync-client";
import { upsertProject, upsertContractor } from "../archidoc/sync-service";

const router = Router();

router.get("/api/admin/mirror-restore", requireAuth, async (_req, res) => {
  try {
    const [projects, contractors] = await Promise.all([
      storage.getSoftDeletedArchidocProjects(),
      storage.getSoftDeletedArchidocContractors(),
    ]);
    res.json({ projects, contractors });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Listing failed: ${message}` });
  }
});

const archidocIdParams = z.object({ archidocId: z.string().min(1) }).strict();

router.post(
  "/api/admin/mirror-restore/projects/:archidocId/restore",
  requireAuth,
  validateRequest({ params: archidocIdParams }),
  async (req, res) => {
    const { archidocId } = req.params as unknown as z.infer<typeof archidocIdParams>;
    const userId = req.session?.userId ?? null;
    try {
      const before = await storage.getArchidocProject(archidocId);
      if (!before) {
        return res.status(404).json({ message: "Mirror project not found", archidocId });
      }
      if (!before.isDeleted) {
        return res.status(409).json({
          message: "Mirror project is not soft-deleted",
          archidocId,
        });
      }

      const restored = await storage.restoreArchidocProject(archidocId);
      let refreshed = false;
      let refreshError: string | null = null;

      if (isArchidocConfigured()) {
        try {
          const response = await fetchProjects();
          const upstream = response.projects.find((p) => p.id === archidocId);
          if (upstream) {
            await upsertProject(upstream);
            refreshed = true;
          } else {
            refreshError = "Upstream backend did not return this project — restored row may be re-soft-deleted on the next full sync.";
          }
        } catch (err: unknown) {
          refreshError = err instanceof Error ? err.message : String(err);
        }
      } else {
        refreshError = "ArchiDoc backend not configured — soft-delete cleared but row not refreshed.";
      }

      const after = await storage.getArchidocProject(archidocId);

      // Audit log: restore decisions are rare admin actions and worth a
      // structured trail in container logs alongside other Architrak
      // operator actions (admin DLQ, contractor re-match, etc).
      console.info(
        `[Admin Audit] Mirror project restore archidocId=${archidocId} userId=${userId ?? "?"} refreshed=${refreshed} previousDeletedAt=${before.deletedAt?.toISOString() ?? "null"} sourceBaseUrl=${before.sourceBaseUrl ?? "null"} refreshError=${refreshError ?? "none"}`,
      );

      res.json({ archidocId, restored: !!restored, refreshed, refreshError, before, after });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Restore failed: ${message}`, archidocId });
    }
  },
);

router.post(
  "/api/admin/mirror-restore/contractors/:archidocId/restore",
  requireAuth,
  validateRequest({ params: archidocIdParams }),
  async (req, res) => {
    const { archidocId } = req.params as unknown as z.infer<typeof archidocIdParams>;
    const userId = req.session?.userId ?? null;
    try {
      const before = await storage.getArchidocContractor(archidocId);
      if (!before) {
        return res.status(404).json({ message: "Mirror contractor not found", archidocId });
      }
      if (!before.isDeleted) {
        return res.status(409).json({
          message: "Mirror contractor is not soft-deleted",
          archidocId,
        });
      }

      const restored = await storage.restoreArchidocContractor(archidocId);
      let refreshed = false;
      let refreshError: string | null = null;

      if (isArchidocConfigured()) {
        try {
          const response = await fetchContractors();
          const upstream = response.contractors.find((c) => c.id === archidocId);
          if (upstream) {
            await upsertContractor(upstream);
            refreshed = true;
          } else {
            refreshError = "Upstream backend did not return this contractor — restored row may be re-soft-deleted on the next full sync.";
          }
        } catch (err: unknown) {
          refreshError = err instanceof Error ? err.message : String(err);
        }
      } else {
        refreshError = "ArchiDoc backend not configured — soft-delete cleared but row not refreshed.";
      }

      const after = await storage.getArchidocContractor(archidocId);

      console.info(
        `[Admin Audit] Mirror contractor restore archidocId=${archidocId} userId=${userId ?? "?"} refreshed=${refreshed} previousDeletedAt=${before.deletedAt?.toISOString() ?? "null"} sourceBaseUrl=${before.sourceBaseUrl ?? "null"} refreshError=${refreshError ?? "none"}`,
      );

      res.json({ archidocId, restored: !!restored, refreshed, refreshError, before, after });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Restore failed: ${message}`, archidocId });
    }
  },
);

export default router;
