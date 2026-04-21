import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertLotCatalogSchema } from "@shared/schema";
import { validateRequest } from "../middleware/validate";

const router = Router();

const catalogCodeSchema = insertLotCatalogSchema.shape.code;

const assignSchema = z.object({
  projectId: z.coerce.number().int().positive(),
});
const assignBodySchema = z.object({
  catalogCode: catalogCodeSchema,
  devisId: z.number().int().positive().optional(),
});

router.get("/api/lot-catalog", async (_req, res) => {
  const entries = await storage.getLotCatalog();
  res.json(entries);
});

router.post(
  "/api/lot-catalog",
  validateRequest({ body: insertLotCatalogSchema }),
  async (req, res) => {
    const existing = await storage.getLotCatalogByCode(req.body.code);
    if (existing) {
      return res.status(409).json({ message: `Lot code "${req.body.code}" already exists` });
    }
    const entry = await storage.createLotCatalogEntry(req.body);
    res.status(201).json(entry);
  },
);

router.post(
  "/api/projects/:projectId/lots/assign-from-catalog",
  validateRequest({ params: assignSchema, body: assignBodySchema }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const { catalogCode, devisId } = req.body;

    const project = await storage.getProject(projectId);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    if (devisId !== undefined) {
      const devis = await storage.getDevis(devisId);
      if (!devis) {
        return res.status(404).json({ message: "Devis not found" });
      }
      if (devis.projectId !== projectId) {
        return res.status(400).json({ message: "Devis does not belong to this project" });
      }
    }

    const lot = await storage.ensureProjectLotFromCatalog(projectId, catalogCode);
    if (!lot) {
      return res.status(404).json({ message: `Lot code "${catalogCode}" not found in master list` });
    }
    if (devisId !== undefined) {
      await storage.updateDevis(devisId, { lotId: lot.id });
    }
    res.json({ lot });
  },
);

export default router;
