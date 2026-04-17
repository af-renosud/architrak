import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertProjectSchema, type InsertProject } from "@shared/schema";
import { validateRequest } from "../middleware/validate";

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
    await storage.deleteProject(Number(req.params.id));
    res.status(204).send();
  },
);

export default router;
