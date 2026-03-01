import { Router } from "express";
import { getDashboardSummary, getProjectBurnUpData } from "../services/dashboard.service";

const router = Router();

router.get("/api/dashboard/summary", async (_req, res) => {
  try {
    const summary = await getDashboardSummary();
    res.json(summary);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Dashboard summary failed: ${message}` });
  }
});

router.get("/api/projects/:id/burn-up", async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    if (isNaN(projectId)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }
    const data = await getProjectBurnUpData(projectId);
    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Burn-up data failed: ${message}` });
  }
});

export default router;
