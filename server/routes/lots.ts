import { Router } from "express";
import { storage } from "../storage";
import { insertLotSchema } from "@shared/schema";

const router = Router();

router.get("/api/projects/:projectId/lots", async (req, res) => {
  const lots = await storage.getLotsByProject(Number(req.params.projectId));
  res.json(lots);
});

router.post("/api/projects/:projectId/lots", async (req, res) => {
  const parsed = insertLotSchema.safeParse({ ...req.body, projectId: Number(req.params.projectId) });
  if (!parsed.success) return res.status(400).json({ message: "Invalid lot data", errors: parsed.error.flatten() });
  const lot = await storage.createLot(parsed.data);
  res.status(201).json(lot);
});

router.patch("/api/lots/:id", async (req, res) => {
  const parsed = insertLotSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid lot data", errors: parsed.error.flatten() });
  const lot = await storage.updateLot(Number(req.params.id), parsed.data);
  if (!lot) return res.status(404).json({ message: "Lot not found" });
  res.json(lot);
});

router.delete("/api/lots/:id", async (req, res) => {
  await storage.deleteLot(Number(req.params.id));
  res.status(204).send();
});

export default router;
