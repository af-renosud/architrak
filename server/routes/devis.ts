import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertDevisSchema, insertDevisLineItemSchema, insertAvenantSchema } from "@shared/schema";
import { upload } from "../middleware/upload";
import { processDevisUpload } from "../services/devis-upload.service";
import { confirmDevisAndMirror, assignTagsForInsertedItems } from "../services/benchmark-ingest.service";
import { PdfPasswordProtectedError } from "../gmail/document-parser";
import { getDocumentStream } from "../storage/object-storage";
import { validateExtraction } from "../services/extraction-validator";
import { roundCurrency, calculateTtc } from "../../shared/financial-utils";

const devisConfirmSchema = z.object({
  amountHt: z.coerce.number().nonnegative().optional(),
  tvaRate: z.coerce.number().min(0).max(100).optional(),
  amountTtc: z.coerce.number().nonnegative().optional(),
  devisCode: z.string().min(1).optional(),
  devisNumber: z.string().optional(),
  descriptionFr: z.string().optional(),
  dateSent: z.string().optional(),
}).strict();

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
    if (err instanceof PdfPasswordProtectedError) {
      return res.status(422).json({ message: err.message, code: "PDF_PASSWORD_PROTECTED" });
    }
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

router.post("/api/devis/:id/confirm", async (req, res) => {
  try {
    const devis = await storage.getDevis(Number(req.params.id));
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    if (devis.status !== "draft") return res.status(400).json({ message: "Only draft devis can be confirmed" });

    const parsed = devisConfirmSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ message: "Invalid corrections", errors: parsed.error.flatten() });
    const corrections = parsed.data;
    const updates: Record<string, any> = { status: "pending" };

    if (corrections.amountHt != null) updates.amountHt = String(roundCurrency(corrections.amountHt));
    if (corrections.tvaRate != null) updates.tvaRate = String(roundCurrency(corrections.tvaRate));
    if (corrections.amountTtc != null) {
      updates.amountTtc = String(roundCurrency(Number(corrections.amountTtc)));
    } else if (corrections.amountHt != null || corrections.tvaRate != null) {
      const ht = corrections.amountHt != null ? Number(corrections.amountHt) : Number(devis.amountHt);
      const rate = corrections.tvaRate != null ? Number(corrections.tvaRate) : Number(devis.tvaRate);
      updates.amountTtc = String(calculateTtc(ht, rate));
    }
    if (corrections.devisCode != null) updates.devisCode = corrections.devisCode;
    if (corrections.devisNumber != null) updates.devisNumber = corrections.devisNumber;
    if (corrections.descriptionFr != null) updates.descriptionFr = corrections.descriptionFr;
    if (corrections.dateSent != null) updates.dateSent = corrections.dateSent;

    if (Object.keys(corrections).length > 0) {
      const aiData = (devis.aiExtractedData as any) || {};
      const correctedParsed = { ...aiData, ...corrections };
      const revalidation = validateExtraction(correctedParsed);
      updates.validationWarnings = revalidation.isValid ? null : revalidation.warnings;
      updates.aiConfidence = revalidation.confidenceScore;
    } else {
      updates.validationWarnings = null;
    }

    const { devis: updated, inserted } = await confirmDevisAndMirror(Number(req.params.id), updates);
    if (updated && inserted.length > 0) {
      // Tag assignment is awaited (synchronous before response) so that the
      // mirrored benchmark items are fully tagged and queryable as soon as
      // the devis-confirm call returns. AI tag failures are logged but
      // never block the confirm response.
      await assignTagsForInsertedItems(inserted);
    }
    res.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Confirm failed: ${message}` });
  }
});

export default router;
