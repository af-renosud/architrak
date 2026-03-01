import { Router } from "express";
import { storage } from "../storage";
import { generateProjectFolder } from "../services/bulk-export.service";

const router = Router();

router.get("/api/projects/:id/export", async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const project = await storage.getProject(projectId);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    const zipBuffer = await generateProjectFolder(projectId);
    const safeName = `${project.code}_Export`.replace(/[^a-zA-Z0-9_-]/g, "_");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}.zip"`
    );
    res.send(zipBuffer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Export failed: ${message}` });
  }
});

export default router;
