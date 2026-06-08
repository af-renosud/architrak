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

router.get("/api/projects", async (req, res) => {
  const archived = typeof req.query.archived === "string" ? req.query.archived : undefined;
  const options = archived === "true" || archived === "only"
    ? { archivedOnly: true }
    : archived === "all"
      ? { includeArchived: true }
      : undefined;
  const projects = await storage.getProjects(options);
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
    const projectId = Number(req.params.id);

    // Load the current state so we can detect client-contact changes that
    // would leave stale client portal tokens active.
    const before = await storage.getProject(projectId);
    if (!before) return res.status(404).json({ message: "Project not found" });

    const project = await storage.updateProject(projectId, req.body);
    if (!project) return res.status(404).json({ message: "Project not found" });

    // When the client contact email is replaced, revoke all active client
    // check tokens for every devis in this project. The previous recipient
    // must not be able to read or act on live review data via their old link.
    const clientEmailChanged =
      Object.prototype.hasOwnProperty.call(req.body, "clientContactEmail") &&
      (req.body as UpdateProject).clientContactEmail !== before.clientContactEmail;
    if (clientEmailChanged) {
      const devisList = await storage.getDevisByProject(projectId);
      await Promise.all(devisList.map((d) => storage.revokeClientCheckTokensForDevis(d.id)));
    }

    res.json(project);
  },
);

router.post(
  "/api/projects/:id/archive",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const project = await storage.archiveProject(Number(req.params.id));
    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json(project);
  },
);

router.post(
  "/api/projects/:id/unarchive",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const project = await storage.unarchiveProject(Number(req.params.id));
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
