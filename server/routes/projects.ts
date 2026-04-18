import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertProjectSchema, type InsertProject } from "@shared/schema";
import { validateRequest } from "../middleware/validate";
import {
  deleteProject as deleteProjectWithRetention,
  ProjectRetentionError,
  ProjectNotFoundError,
} from "../services/project.service";

const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });
const updateProjectSchema = insertProjectSchema.partial();
type UpdateProject = Partial<InsertProject>;

router.get("/api/projects", async (_req, res) => {
  const projects = await storage.getProjects();
  res.json(projects);
});

router.post(
  "/api/projects",
  validateRequest({ body: insertProjectSchema }),
  async (req, res: Response) => {
    const project = await storage.createProject(req.body);
    res.status(201).json(project);
  },
);

router.get("/api/projects/:id", async (req, res) => {
  const project = await storage.getProject(Number(req.params.id));
  if (!project) return res.status(404).json({ message: "Project not found" });
  res.json(project);
});

router.patch(
  "/api/projects/:id",
  validateRequest({ params: idParams, body: updateProjectSchema }),
  async (req, res: Response) => {
    const project = await storage.updateProject(Number(req.params.id), req.body);
    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json(project);
  },
);

router.delete(
  "/api/projects/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      await deleteProjectWithRetention(Number(req.params.id));
      res.status(204).send();
    } catch (err) {
      if (err instanceof ProjectRetentionError) {
        return res.status(409).json({
          message: err.message,
          code: err.code,
          retained: err.retained,
        });
      }
      if (err instanceof ProjectNotFoundError) {
        return res.status(404).json({ message: "Project not found", code: err.code });
      }
      throw err;
    }
  },
);

export default router;
