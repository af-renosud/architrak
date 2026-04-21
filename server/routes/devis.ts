import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import {
  insertDevisSchema,
  insertDevisLineItemSchema,
  insertAvenantSchema,
  type InsertDevis,
  type InsertDevisLineItem,
  type InsertAvenant,
} from "@shared/schema";
import { upload } from "../middleware/upload";
import { processDevisUpload } from "../services/devis-upload.service";
import { confirmDevisAndMirror, assignTagsForInsertedItems } from "../services/benchmark-ingest.service";
import { PdfPasswordProtectedError } from "../gmail/document-parser";
import { getDocumentStream } from "../storage/object-storage";
import { validateExtraction, type ValidationWarning } from "../services/extraction-validator";
import { checkLotReferencesAgainstCatalog } from "../services/lot-reference-validator";
import type { ParsedDocument } from "../gmail/document-parser";
import { roundCurrency, calculateTtc } from "../../shared/financial-utils";
import {
  reconcileAdvisories,
  getAdvisoriesForDevis,
  acknowledgeAdvisoryForSubject,
} from "../services/advisory-reconciler";
import { validateRequest } from "../middleware/validate";

const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const devisIdParams = z.object({ devisId: z.coerce.number().int().positive() });
const advisoryAckParams = z.object({
  id: z.coerce.number().int().positive(),
  advisoryId: z.coerce.number().int().positive(),
});

const createDevisBodySchema = insertDevisSchema.omit({ projectId: true });
const updateDevisSchema = insertDevisSchema.partial();
const createLineItemBodySchema = insertDevisLineItemSchema.omit({ devisId: true });
const updateLineItemSchema = insertDevisLineItemSchema.partial();
const createAvenantBodySchema = insertAvenantSchema.omit({ devisId: true });
const updateAvenantSchema = insertAvenantSchema.partial();

const devisConfirmSchema = z.object({
  amountHt: z.coerce.number().nonnegative().optional(),
  tvaRate: z.coerce.number().min(0).max(100).optional(),
  amountTtc: z.coerce.number().nonnegative().optional(),
  devisCode: z.string().min(1).optional(),
  devisNumber: z.string().optional(),
  descriptionFr: z.string().optional(),
  dateSent: z.string().optional(),
}).strict();
type DevisConfirmInput = z.infer<typeof devisConfirmSchema>;

router.get("/api/projects/:projectId/devis", async (req, res) => {
  const devisList = await storage.getDevisByProject(Number(req.params.projectId));
  res.json(devisList);
});

router.post(
  "/api/projects/:projectId/devis",
  validateRequest({ params: projectIdParams, body: createDevisBodySchema }),
  async (req, res) => {
    const d = await storage.createDevis({ ...req.body, projectId: Number(req.params.projectId) });
    res.status(201).json(d);
  },
);

router.post(
  "/api/projects/:projectId/devis/upload",
  upload.single("file"),
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
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
  },
);

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

router.patch(
  "/api/devis/:id",
  validateRequest({ params: idParams, body: updateDevisSchema }),
  async (req, res) => {
    const d = await storage.updateDevis(Number(req.params.id), req.body);
    if (!d) return res.status(404).json({ message: "Devis not found" });
    res.json(d);
  },
);

router.get("/api/devis/:devisId/line-items", async (req, res) => {
  const items = await storage.getDevisLineItems(Number(req.params.devisId));
  res.json(items);
});

router.post(
  "/api/devis/:devisId/line-items",
  validateRequest({ params: devisIdParams, body: createLineItemBodySchema }),
  async (req, res) => {
    const item = await storage.createDevisLineItem({ ...req.body, devisId: Number(req.params.devisId) });
    res.status(201).json(item);
  },
);

router.patch(
  "/api/line-items/:id",
  validateRequest({ params: idParams, body: updateLineItemSchema }),
  async (req, res) => {
    const item = await storage.updateDevisLineItem(Number(req.params.id), req.body);
    if (!item) return res.status(404).json({ message: "Line item not found" });
    res.json(item);
  },
);

router.delete(
  "/api/line-items/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    await storage.deleteDevisLineItem(Number(req.params.id));
    res.status(204).send();
  },
);

router.get("/api/devis/:devisId/avenants", async (req, res) => {
  const avs = await storage.getAvenantsByDevis(Number(req.params.devisId));
  res.json(avs);
});

router.post(
  "/api/devis/:devisId/avenants",
  validateRequest({ params: devisIdParams, body: createAvenantBodySchema }),
  async (req, res) => {
    const av = await storage.createAvenant({ ...req.body, devisId: Number(req.params.devisId) });
    res.status(201).json(av);
  },
);

router.patch(
  "/api/avenants/:id",
  validateRequest({ params: idParams, body: updateAvenantSchema }),
  async (req, res) => {
    const av = await storage.updateAvenant(Number(req.params.id), req.body);
    if (!av) return res.status(404).json({ message: "Avenant not found" });
    res.json(av);
  },
);

router.post(
  "/api/devis/:id/confirm",
  validateRequest({ params: idParams, body: devisConfirmSchema }),
  async (req, res) => {
    try {
      const devis = await storage.getDevis(Number(req.params.id));
      if (!devis) return res.status(404).json({ message: "Devis not found" });
      if (devis.status !== "draft") return res.status(400).json({ message: "Only draft devis can be confirmed" });

      const corrections = req.body;
      const updates: Record<string, unknown> = { status: "pending" };

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

      let nextWarnings = (devis.validationWarnings as ValidationWarning[] | null) ?? [];
      const aiData = (devis.aiExtractedData as Record<string, unknown> | null) ?? {};
      if (Object.keys(corrections).length > 0) {
        const correctedParsed = { ...aiData, ...corrections } as ParsedDocument;
        const revalidation = validateExtraction(correctedParsed);
        const lotWarnings = await checkLotReferencesAgainstCatalog(correctedParsed);
        nextWarnings = [...revalidation.warnings, ...lotWarnings];
        updates.validationWarnings = nextWarnings;
        updates.aiConfidence = revalidation.confidenceScore;
      } else {
        const lotWarnings = await checkLotReferencesAgainstCatalog(aiData as unknown as ParsedDocument);
        if (lotWarnings.length > 0) {
          const existingMessages = new Set(nextWarnings.map((w) => w.message));
          const merged = [
            ...nextWarnings,
            ...lotWarnings.filter((w) => !existingMessages.has(w.message)),
          ];
          if (merged.length !== nextWarnings.length) {
            nextWarnings = merged;
            updates.validationWarnings = nextWarnings;
          }
        }
      }

      // Defense-in-depth: the confirm path must never mutate lot assignment
      // or lot descriptions. lotId is only set via the assign-from-catalog
      // flow (server/routes/lot-catalog.ts). The confirm schema already
      // rejects unknown fields like `lotId`, but we strip any leakage here
      // as a hard guard.
      delete (updates as Record<string, unknown>).lotId;

      const { devis: updated, inserted } = await confirmDevisAndMirror(Number(req.params.id), updates);
      try {
        await reconcileAdvisories({ devisId: Number(req.params.id) }, nextWarnings);
      } catch (advErr) {
        console.warn("[Devis Confirm] Advisory reconciliation failed:", advErr);
      }
      if (updated && inserted.length > 0) {
        await assignTagsForInsertedItems(inserted);
      }
      res.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Confirm failed: ${message}` });
    }
  },
);

router.get("/api/devis/:id/advisories", async (req, res) => {
  const items = await getAdvisoriesForDevis(Number(req.params.id));
  res.json(items);
});

router.post(
  "/api/devis/:id/advisories/:advisoryId/acknowledge",
  requireAuth,
  validateRequest({ params: advisoryAckParams }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const advisoryId = Number(req.params.advisoryId);
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const row = await acknowledgeAdvisoryForSubject(
      advisoryId,
      { devisId },
      String(userId),
    );
    if (!row) {
      return res
        .status(404)
        .json({ message: "Advisory not found, already acknowledged, or not on this devis" });
    }
    res.json(row);
  },
);

export default router;
