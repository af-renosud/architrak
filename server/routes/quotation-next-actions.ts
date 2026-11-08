import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { rateLimit } from "../middleware/rate-limit";
import { getProjectQuotationNextActions } from "../services/quotation-next-actions";
import { explainQuotationAction, actionFingerprint } from "../services/quotation-next-action-explanation";

const router = Router();
const projectIdSchema = z.coerce.number().int().positive();
const bodySchema = z.object({ devisId: z.number().int().positive(), actionId: z.string().min(1).max(150) }).strict();
const explainLimit = rateLimit({ name: "quotation-next-action-explain", windowMs: 60_000, max: 10,
  keyer: req => String(req.session.userId), message: "Please wait before requesting another explanation." });

router.get("/api/projects/:projectId/quotation-next-actions", requireAuth, async (req, res) => {
  const parsed = projectIdSchema.safeParse(req.params.projectId);
  if (!parsed.success) return res.status(400).json({ message: "Invalid project" });
  res.setHeader("Cache-Control", "no-store");
  try {
    const result = await getProjectQuotationNextActions(parsed.data);
    if (!result) return res.status(404).json({ message: "Project not found" });
    return res.json(result);
  } catch {
    return res.status(503).json({ message: "Next actions are unavailable. Refresh to try again." });
  }
});

router.post("/api/projects/:projectId/quotation-next-actions/explain", requireAuth, explainLimit, async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId), body = bodySchema.safeParse(req.body);
  if (!projectId.success || !body.success) return res.status(400).json({ message: "Invalid explanation request" });
  res.setHeader("Cache-Control", "no-store");
  try {
    const current = await getProjectQuotationNextActions(projectId.data);
    if (!current) return res.status(404).json({ message: "Project not found" });
    const action = current.quotations[body.data.devisId]?.actions.find(a => a.id === body.data.actionId);
    if (!action) return res.status(409).json({ message: "This action has changed. Refresh the suggestions." });
    const explanation = await explainQuotationAction(action);
    // A payment/override/webhook can land while the model is responding.
    const latest = await getProjectQuotationNextActions(projectId.data);
    const refreshed = latest?.quotations[body.data.devisId]?.actions.find(a => a.id === body.data.actionId);
    if (!refreshed || actionFingerprint(refreshed) !== actionFingerprint(action)) {
      return res.status(409).json({ message: "This action has changed. Refresh the suggestions." });
    }
    return res.json(explanation);
  } catch {
    return res.status(503).json({ message: "Could not verify current action details. Refresh to try again." });
  }
});

export default router;
