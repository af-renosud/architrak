import { Router } from "express";
import { getDashboardSummary } from "../services/dashboard.service";

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

export default router;
