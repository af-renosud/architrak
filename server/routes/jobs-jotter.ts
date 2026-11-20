import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { getJobsJotter, saveJobsJotter } from "../services/jobs-jotter";

const router = Router();
const bodySchema = z.object({
  content: z.string().max(100000),
  revision: z.number().int().min(0).max(2147483646),
}).strict();

router.use("/api/jobs-jotter", requireAuth, (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.get("/api/jobs-jotter", async (req, res, next) => {
  try { res.json(await getJobsJotter(req.session.userId!)); } catch (error) { next(error); }
});
router.put("/api/jobs-jotter", async (req, res, next) => {
  const body = bodySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: "Enter notes up to 100,000 characters and a valid revision." });
  try {
    const result = await saveJobsJotter(req.session.userId!, body.data.content, body.data.revision);
    if (result.saved) return res.json(result.saved);
    return res.status(409).json({ message: "Jobs changed in another window. Review both versions before saving.", current: result.current });
  } catch (error) { next(error); }
});
export default router;
