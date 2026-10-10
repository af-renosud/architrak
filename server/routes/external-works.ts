import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { storage } from "../storage";
import { externalWorksRegister, mutateExternalWork, ExternalWorksError } from "../services/external-works.service";

const router = Router();
const base = "/api/projects/:projectId/external-works";
function positiveId(raw: unknown) { return z.coerce.number().int().positive().parse(raw); }
function errorResponse(res: any, error: unknown) {
  if (error instanceof z.ZodError) return res.status(400).json({ message: error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
  if (error instanceof ExternalWorksError) return res.status(error.status).json({ code: error.code, message: error.message, overlaps: error.overlaps });
  return res.status(500).json({ message: "External works could not be saved or loaded. Please try again." });
}
router.get(base, requireAuth, async (req, res) => {
  try { res.json(await externalWorksRegister(positiveId(req.params.projectId))); }
  catch (error) { errorResponse(res, error); }
});
for (const action of ["create", "edit", "void", "restore"] as const) {
  const path = action === "create" ? base : action === "edit" ? `${base}/:id` : `${base}/:id/${action}`;
  router[action === "edit" ? "patch" : "post"](path, requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ message: "Authentication required" });
      const row = await mutateExternalWork(positiveId(req.params.projectId), action === "create" ? null : positiveId(req.params.id), action, req.body, { id: user.id, name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email });
      res.status(action === "create" ? 201 : 200).json(row);
    } catch (error) { errorResponse(res, error); }
  });
}
export default router;
