import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { ClientBudgetError, getClientBudget, saveClientBudget } from "../services/client-budget";

const router = Router();
const path = "/api/projects/:projectId/client-budget";
const params = z.coerce.number().int().positive();
const body = z.object({
  version: z.string().regex(/^[a-f0-9]{64}$/),
  alternativesReviewed: z.literal(true),
  entries: z.array(z.object({
    devisId: z.number().int().positive(),
    title: z.string().trim().min(1).max(500),
    refresh: z.boolean(),
    reviewedTotals: z.object({
      amountHt: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/),
      amountTtc: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/),
      pdfPage: z.number().int().positive(),
      confirmedFromPdf: z.literal(true),
    }).strict().optional(),
  }).strict()).max(1000),
}).strict();
router.use(path, requireAuth, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
router.get(path, async (req, res, next) => {
  const id = params.safeParse(req.params.projectId);
  if (!id.success) return res.status(400).json({ message: "Invalid project." });
  try { res.json(await getClientBudget(id.data)); }
  catch (e) { if (e instanceof ClientBudgetError) return res.status(e.status).json({ message: e.message }); next(e); }
});
router.put(path, async (req, res, next) => {
  const id = params.safeParse(req.params.projectId), input = body.safeParse(req.body);
  if (!id.success || !input.success) return res.status(400).json({ message: "Review the selected quotations, their titles and the alternatives confirmation before saving." });
  try { res.json(await saveClientBudget(id.data, req.session.userId!, input.data)); }
  catch (e) { if (e instanceof ClientBudgetError) return res.status(e.status).json({ message: e.message }); next(e); }
});
export default router;
