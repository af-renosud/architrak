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
import { evaluateAcompteGate, gateInputsFromDevis } from "../services/acompte.service";
import { getDocumentStream } from "../storage/object-storage";

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
    const devisId = Number(req.params.devisId);
    // Task #215 — block progress invoicing while a required acompte
    // is still pending/invoiced (override: allowProgressBeforeAcompte).
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    const decision = evaluateAcompteGate(gateInputsFromDevis(devis));
    if (decision.blocked) {
      return res.status(409).json({
        message: decision.message,
        code: decision.code,
        acompteState: decision.state,
      });
    }
    const situation = await storage.createSituation({ ...req.body, devisId });
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
    // Task #449 — source-PDF provenance is server-written only. The Zod
    // schema already omits these fields, but delete them from the body
    // outright (belt-and-braces — see the devis state-machine seal).
    const body = { ...req.body };
    for (const k of [
      "sourceStorageKey",
      "sourceFileName",
      "sourceUploadedAt",
      "sourceUploadedBy",
      "sourceConfirmedAt",
      "sourceConfirmedBy",
      "sourceIntakeDocumentId",
    ]) {
      delete (body as Record<string, unknown>)[k];
    }
    const situation = await storage.updateSituation(Number(req.params.id), body);
    if (!situation) return res.status(404).json({ message: "Situation not found" });
    res.json(situation);
  },
);

// Task #449 — operator confirmation of an auto-attached source PDF
// (draft→confirm). Reviewed attachments made through the intake attach
// flow are confirmed at attach time and don't need this.
router.post(
  "/api/situations/:id/confirm-source",
  validateRequest({ params: idParams, body: z.object({ confirmedBy: z.string().optional() }) }),
  async (req, res) => {
    const id = Number(req.params.id);
    const situation = await storage.getSituation(id);
    if (!situation) return res.status(404).json({ message: "Situation not found" });
    if (!situation.sourceStorageKey) {
      return res.status(409).json({ message: "This situation has no source PDF attached." });
    }
    if (situation.sourceConfirmedAt) return res.json(situation);
    const updated = await storage.confirmSituationSourcePdf(id, req.body.confirmedBy || "operator");
    res.json(updated);
  },
);

// Task #449 — download the retained signed Situation PDF.
router.get(
  "/api/situations/:id/source-pdf",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const situation = await storage.getSituation(Number(req.params.id));
      if (!situation) return res.status(404).json({ message: "Situation not found" });
      if (!situation.sourceStorageKey) {
        return res.status(404).json({ message: "This situation has no source PDF attached." });
      }
      const { stream, contentType, size } = await getDocumentStream(situation.sourceStorageKey);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${situation.sourceFileName ?? `situation-${situation.id}.pdf`}"`);
      if (size) res.setHeader("Content-Length", String(size));
      stream.pipe(res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Download failed: ${message}` });
    }
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
