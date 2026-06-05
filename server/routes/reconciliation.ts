import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { storage } from "../storage";
import {
  applyHumanResolution,
  computeOverlapCaseImpact,
  getProjectAccountingStatus,
} from "../services/reconciliation/resolution.service";

const router = Router();

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const caseIdParams = z.object({ id: z.coerce.number().int().positive() });
const resolveBody = z.object({
  decision: z.enum(["confirm", "dismiss"]),
  note: z.string().trim().max(2000).optional(),
});

// Project-level accounting rollup powering the review UI status badge.
router.get(
  "/api/projects/:projectId/accounting-status",
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      const project = await storage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      const status = await getProjectAccountingStatus(projectId);
      res.status(200).json(status);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Accounting status failed: ${message}` });
    }
  },
);

// Euros that resolving this overlap case would remove from Contracted.
router.get(
  "/api/overlap-cases/:id/impact",
  validateRequest({ params: caseIdParams }),
  async (req, res) => {
    try {
      const overlapCase = await storage.getOverlapCase(Number(req.params.id));
      if (!overlapCase) {
        return res.status(404).json({ message: "Overlap case not found" });
      }
      const eurosRemoved = await computeOverlapCaseImpact(overlapCase);
      res.status(200).json({
        caseId: overlapCase.id,
        projectId: overlapCase.projectId,
        verdict: overlapCase.verdict,
        eurosRemoved,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Impact computation failed: ${message}` });
    }
  },
);

// Architect's recorded decision on an overlap case (confirm → supersede
// members; dismiss → keep active). Authenticated — the actor is audited.
router.post(
  "/api/overlap-cases/:id/resolve",
  requireAuth,
  validateRequest({ params: caseIdParams, body: resolveBody }),
  async (req, res) => {
    try {
      const actorUserId = req.session.userId;
      if (!actorUserId) {
        return res.status(401).json({ message: "Authentication required" });
      }
      const body = req.body as z.infer<typeof resolveBody>;
      const result = await applyHumanResolution({
        caseId: Number(req.params.id),
        decision: body.decision,
        actorUserId,
        note: body.note ?? null,
      });
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }
      res.status(result.status).json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Overlap resolution failed: ${message}` });
    }
  },
);

export default router;
