import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import {
  insertSituationSchema,
  insertSituationLineSchema,
  type InsertSituation,
  type InsertSituationLine,
} from "@shared/schema";
import { validateRequest } from "../middleware/validate";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const devisIdParams = z.object({ devisId: z.coerce.number().int().positive() });
const situationIdParams = z.object({ situationId: z.coerce.number().int().positive() });

const createSituationBodySchema = insertSituationSchema.omit({ devisId: true });
const updateSituationSchema = insertSituationSchema.partial();
const createLineBodySchema = insertSituationLineSchema.omit({ situationId: true });

router.get("/api/devis/:devisId/situations", async (req, res) => {
  const sits = await storage.getSituationsByDevis(Number(req.params.devisId));
  res.json(sits);
});

router.post(
  "/api/devis/:devisId/situations",
  validateRequest({ params: devisIdParams, body: createSituationBodySchema }),
  async (req, res) => {
    const situation = await storage.createSituation({ ...req.body, devisId: Number(req.params.devisId) });
    res.status(201).json(situation);
  },
);

router.get("/api/situations/:id", async (req, res) => {
  const situation = await storage.getSituation(Number(req.params.id));
  if (!situation) return res.status(404).json({ message: "Situation not found" });
  res.json(situation);
});

router.patch(
  "/api/situations/:id",
  validateRequest({ params: idParams, body: updateSituationSchema }),
  async (req, res) => {
    const situation = await storage.updateSituation(Number(req.params.id), req.body);
    if (!situation) return res.status(404).json({ message: "Situation not found" });
    res.json(situation);
  },
);

router.get("/api/situations/:situationId/lines", async (req, res) => {
  const lines = await storage.getSituationLines(Number(req.params.situationId));
  res.json(lines);
});

router.post(
  "/api/situations/:situationId/lines",
  validateRequest({ params: situationIdParams, body: createLineBodySchema }),
  async (req, res) => {
    const line = await storage.createSituationLine({ ...req.body, situationId: Number(req.params.situationId) });
    res.status(201).json(line);
  },
);

export default router;
