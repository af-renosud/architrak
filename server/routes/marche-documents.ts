import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import { getDocumentStream } from "../storage/object-storage";

/**
 * Task #449 — marché-level evidence documents (signed Bons de commande).
 * Read/list/download/confirm surfaces only: rows are CREATED exclusively by
 * the intake pipeline (auto-route on an exact unambiguous match) or the
 * reviewed one-click attach flow in server/routes/intake.ts. Confirmation
 * state is server-written; there is no generic PATCH.
 */
const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const devisIdParams = z.object({ devisId: z.coerce.number().int().positive() });

router.get(
  "/api/projects/:projectId/marche-documents",
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    res.json(await storage.getMarcheDocumentsByProject(Number(req.params.projectId)));
  },
);

router.get(
  "/api/devis/:devisId/marche-documents",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    res.json(await storage.getMarcheDocumentsByDevis(Number(req.params.devisId)));
  },
);

router.post(
  "/api/marche-documents/:id/confirm",
  validateRequest({ params: idParams, body: z.object({ confirmedBy: z.string().optional() }) }),
  async (req, res) => {
    const doc = await storage.getMarcheDocument(Number(req.params.id));
    if (!doc) return res.status(404).json({ message: "Document not found" });
    if (doc.status === "confirmed") return res.json(doc);
    const updated = await storage.confirmMarcheDocument(doc.id, req.body.confirmedBy || "operator");
    res.json(updated);
  },
);

router.get(
  "/api/marche-documents/:id/download",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const doc = await storage.getMarcheDocument(Number(req.params.id));
      if (!doc) return res.status(404).json({ message: "Document not found" });
      const { stream, contentType, size } = await getDocumentStream(doc.storageKey);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${doc.fileName}"`);
      if (size) res.setHeader("Content-Length", String(size));
      stream.pipe(res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Download failed: ${message}` });
    }
  },
);

export default router;
