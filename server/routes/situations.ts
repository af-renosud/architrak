import { Router } from "express";
import { storage } from "../storage";
import { insertSituationSchema, insertSituationLineSchema } from "@shared/schema";

const router = Router();

router.get("/api/devis/:devisId/situations", async (req, res) => {
  const sits = await storage.getSituationsByDevis(Number(req.params.devisId));
  res.json(sits);
});

router.post("/api/devis/:devisId/situations", async (req, res) => {
  const parsed = insertSituationSchema.safeParse({ ...req.body, devisId: Number(req.params.devisId) });
  if (!parsed.success) return res.status(400).json({ message: "Invalid situation data", errors: parsed.error.flatten() });
  const situation = await storage.createSituation(parsed.data);
  res.status(201).json(situation);
});

router.get("/api/situations/:id", async (req, res) => {
  const situation = await storage.getSituation(Number(req.params.id));
  if (!situation) return res.status(404).json({ message: "Situation not found" });
  res.json(situation);
});

router.patch("/api/situations/:id", async (req, res) => {
  const parsed = insertSituationSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid situation data", errors: parsed.error.flatten() });
  const situation = await storage.updateSituation(Number(req.params.id), parsed.data);
  if (!situation) return res.status(404).json({ message: "Situation not found" });
  res.json(situation);
});

router.get("/api/situations/:situationId/lines", async (req, res) => {
  const lines = await storage.getSituationLines(Number(req.params.situationId));
  res.json(lines);
});

router.post("/api/situations/:situationId/lines", async (req, res) => {
  const parsed = insertSituationLineSchema.safeParse({ ...req.body, situationId: Number(req.params.situationId) });
  if (!parsed.success) return res.status(400).json({ message: "Invalid situation line data", errors: parsed.error.flatten() });
  const line = await storage.createSituationLine(parsed.data);
  res.status(201).json(line);
});

export default router;
