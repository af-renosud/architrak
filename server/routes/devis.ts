import { Router } from "express";
import { storage } from "../storage";
import { insertDevisSchema, insertDevisLineItemSchema, insertAvenantSchema } from "@shared/schema";
import { upload } from "../middleware/upload";
import { processDevisUpload } from "../services/devis-upload.service";
import { getDocumentStream } from "../storage/object-storage";

const router = Router();

router.get("/api/projects/:projectId/devis", async (req, res) => {
  const devisList = await storage.getDevisByProject(Number(req.params.projectId));
  res.json(devisList);
});

router.post("/api/projects/:projectId/devis", async (req, res) => {
  const parsed = insertDevisSchema.safeParse({ ...req.body, projectId: Number(req.params.projectId) });
  if (!parsed.success) return res.status(400).json({ message: "Invalid devis data", errors: parsed.error.flatten() });
  const d = await storage.createDevis(parsed.data);
  res.status(201).json(d);
});

router.post("/api/projects/:projectId/devis/upload", upload.single("file"), async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    const file = req.file;
    if (!file) return res.status(400).json({ message: "No file provided" });

    const result = await processDevisUpload(projectId, file);
    res.status(result.status).json(result.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Devis Upload] Error:", message);
    res.status(500).json({ message: `Upload/parse failed: ${message}` });
  }
});

router.get("/api/devis/:id", async (req, res) => {
  const d = await storage.getDevis(Number(req.params.id));
  if (!d) return res.status(404).json({ message: "Devis not found" });
  res.json(d);
});

router.get("/api/devis/:id/pdf", async (req, res) => {
  try {
    const d = await storage.getDevis(Number(req.params.id));
    if (!d || !d.pdfStorageKey) return res.status(404).json({ message: "No PDF attached to this devis" });
    const { stream, contentType, size } = await getDocumentStream(d.pdfStorageKey);
    res.setHeader("Content-Type", contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${d.pdfFileName || "devis.pdf"}"`);
    if (size) res.setHeader("Content-Length", String(size));
    stream.pipe(res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `PDF view failed: ${message}` });
  }
});

router.patch("/api/devis/:id", async (req, res) => {
  const parsed = insertDevisSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid devis data", errors: parsed.error.flatten() });
  const d = await storage.updateDevis(Number(req.params.id), parsed.data);
  if (!d) return res.status(404).json({ message: "Devis not found" });
  res.json(d);
});

router.get("/api/devis/:devisId/line-items", async (req, res) => {
  const items = await storage.getDevisLineItems(Number(req.params.devisId));
  res.json(items);
});

router.post("/api/devis/:devisId/line-items", async (req, res) => {
  const parsed = insertDevisLineItemSchema.safeParse({ ...req.body, devisId: Number(req.params.devisId) });
  if (!parsed.success) return res.status(400).json({ message: "Invalid line item data", errors: parsed.error.flatten() });
  const item = await storage.createDevisLineItem(parsed.data);
  res.status(201).json(item);
});

router.patch("/api/line-items/:id", async (req, res) => {
  const parsed = insertDevisLineItemSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid line item data", errors: parsed.error.flatten() });
  const item = await storage.updateDevisLineItem(Number(req.params.id), parsed.data);
  if (!item) return res.status(404).json({ message: "Line item not found" });
  res.json(item);
});

router.delete("/api/line-items/:id", async (req, res) => {
  await storage.deleteDevisLineItem(Number(req.params.id));
  res.status(204).send();
});

router.get("/api/devis/:devisId/avenants", async (req, res) => {
  const avs = await storage.getAvenantsByDevis(Number(req.params.devisId));
  res.json(avs);
});

router.post("/api/devis/:devisId/avenants", async (req, res) => {
  const parsed = insertAvenantSchema.safeParse({ ...req.body, devisId: Number(req.params.devisId) });
  if (!parsed.success) return res.status(400).json({ message: "Invalid avenant data", errors: parsed.error.flatten() });
  const av = await storage.createAvenant(parsed.data);
  res.status(201).json(av);
});

router.patch("/api/avenants/:id", async (req, res) => {
  const parsed = insertAvenantSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid avenant data", errors: parsed.error.flatten() });
  const av = await storage.updateAvenant(Number(req.params.id), parsed.data);
  if (!av) return res.status(404).json({ message: "Avenant not found" });
  res.json(av);
});

export default router;
