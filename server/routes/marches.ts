import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertMarcheSchema, type InsertMarche } from "@shared/schema";
import { validateRequest } from "../middleware/validate";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const createMarcheBodySchema = insertMarcheSchema.omit({ projectId: true });
const updateMarcheSchema = insertMarcheSchema.partial();

router.get("/api/projects/:projectId/marches", async (req, res) => {
  const marches = await storage.getMarchesByProject(Number(req.params.projectId));
  res.json(marches);
});

router.post(
  "/api/projects/:projectId/marches",
  validateRequest({ params: projectIdParams, body: createMarcheBodySchema }),
  async (req, res) => {
    const marche = await storage.createMarche({ ...req.body, projectId: Number(req.params.projectId) });
    res.status(201).json(marche);
  },
);

router.get("/api/marches/:id", async (req, res) => {
  const marche = await storage.getMarche(Number(req.params.id));
  if (!marche) return res.status(404).json({ message: "Marche not found" });
  res.json(marche);
});

router.patch(
  "/api/marches/:id",
  validateRequest({ params: idParams, body: updateMarcheSchema }),
  async (req, res) => {
    const marche = await storage.updateMarche(Number(req.params.id), req.body);
    if (!marche) return res.status(404).json({ message: "Marche not found" });
    res.json(marche);
  },
);

export default router;
