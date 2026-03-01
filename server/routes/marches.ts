import { Router } from "express";
import { storage } from "../storage";
import { insertMarcheSchema } from "@shared/schema";

const router = Router();

router.get("/api/projects/:projectId/marches", async (req, res) => {
  const marches = await storage.getMarchesByProject(Number(req.params.projectId));
  res.json(marches);
});

router.post("/api/projects/:projectId/marches", async (req, res) => {
  const parsed = insertMarcheSchema.safeParse({ ...req.body, projectId: Number(req.params.projectId) });
  if (!parsed.success) return res.status(400).json({ message: "Invalid marche data", errors: parsed.error.flatten() });
  const marche = await storage.createMarche(parsed.data);
  res.status(201).json(marche);
});

router.get("/api/marches/:id", async (req, res) => {
  const marche = await storage.getMarche(Number(req.params.id));
  if (!marche) return res.status(404).json({ message: "Marche not found" });
  res.json(marche);
});

router.patch("/api/marches/:id", async (req, res) => {
  const parsed = insertMarcheSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid marche data", errors: parsed.error.flatten() });
  const marche = await storage.updateMarche(Number(req.params.id), parsed.data);
  if (!marche) return res.status(404).json({ message: "Marche not found" });
  res.json(marche);
});

export default router;
