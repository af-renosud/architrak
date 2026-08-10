import { Router } from "express";
import { getProjectFinancialSummary } from "../services/financial-summary.service";
import {
  generateProjectOverviewPdf,
  ProjectOverviewNotFoundError,
} from "../services/project-overview-pdf.service";

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

// Task #413 — one-page French financial overview PDF (addendum alone).
router.get("/api/projects/:projectId/overview-pdf", async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "Invalid project id" });
    }
    const pdfBuffer = await generateProjectOverviewPdf(projectId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="situation-projet-${projectId}.pdf"`,
    );
    res.setHeader("Content-Length", String(pdfBuffer.length));
    res.send(pdfBuffer);
  } catch (err: unknown) {
    if (err instanceof ProjectOverviewNotFoundError) {
      return res.status(404).json({ message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Overview PDF failed: ${message}` });
  }
});

export default router;
