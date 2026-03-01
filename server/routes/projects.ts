import { Router } from "express";
import { storage } from "../storage";
import { insertProjectSchema } from "@shared/schema";

const router = Router();

router.get("/api/projects", async (_req, res) => {
  const projects = await storage.getProjects();
  res.json(projects);
});

router.post("/api/projects", async (req, res) => {
  const parsed = insertProjectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid project data", errors: parsed.error.flatten() });
  const project = await storage.createProject(parsed.data);
  res.status(201).json(project);
});

router.get("/api/projects/:id", async (req, res) => {
  const project = await storage.getProject(Number(req.params.id));
  if (!project) return res.status(404).json({ message: "Project not found" });
  res.json(project);
});

router.patch("/api/projects/:id", async (req, res) => {
  const parsed = insertProjectSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid project data", errors: parsed.error.flatten() });
  const project = await storage.updateProject(Number(req.params.id), parsed.data);
  if (!project) return res.status(404).json({ message: "Project not found" });
  res.json(project);
});

router.delete("/api/projects/:id", async (req, res) => {
  await storage.deleteProject(Number(req.params.id));
  res.status(204).send();
});

export default router;
