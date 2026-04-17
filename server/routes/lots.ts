import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertLotSchema, type InsertLot } from "@shared/schema";
import { validateRequest } from "../middleware/validate";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const createLotBodySchema = insertLotSchema.omit({ projectId: true });
const updateLotSchema = insertLotSchema.partial();

router.get("/api/projects/:projectId/lots", async (req, res) => {
  const lots = await storage.getLotsByProject(Number(req.params.projectId));
  res.json(lots);
});

router.post(
  "/api/projects/:projectId/lots",
  validateRequest({ params: projectIdParams, body: createLotBodySchema }),
  async (req, res) => {
    const lot = await storage.createLot({ ...req.body, projectId: Number(req.params.projectId) });
    res.status(201).json(lot);
  },
);

router.patch(
  "/api/lots/:id",
  validateRequest({ params: idParams, body: updateLotSchema }),
  async (req, res) => {
    const lot = await storage.updateLot(Number(req.params.id), req.body);
    if (!lot) return res.status(404).json({ message: "Lot not found" });
    res.json(lot);
  },
);

router.delete(
  "/api/lots/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    await storage.deleteLot(Number(req.params.id));
    res.status(204).send();
  },
);

export default router;
