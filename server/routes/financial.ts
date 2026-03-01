import { Router } from "express";
import { getProjectFinancialSummary } from "../services/financial-summary.service";

const router = Router();

router.get("/api/projects/:projectId/financial-summary", async (req, res) => {
  try {
    const result = await getProjectFinancialSummary(Number(req.params.projectId));
    res.status(result.status).json(result.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Financial summary failed: ${message}` });
  }
});

export default router;
