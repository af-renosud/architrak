import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertLotCatalogSchema } from "@shared/schema";
import { validateRequest } from "../middleware/validate";
import { reconcileAdvisories } from "../services/advisory-reconciler";
import type { ValidatorWarningLike } from "@shared/advisory-codes";

const router = Router();

const catalogCodeSchema = insertLotCatalogSchema.shape.code;

const assignSchema = z.object({
  projectId: z.coerce.number().int().positive(),
});
const assignBodySchema = z.object({
  catalogCode: catalogCodeSchema,
  devisId: z.number().int().positive().optional(),
});

router.get("/api/lot-catalog", async (_req, res) => {
  const entries = await storage.getLotCatalog();
  res.json(entries);
});

router.post(
  "/api/lot-catalog",
  validateRequest({ body: insertLotCatalogSchema }),
  async (req, res) => {
    const existing = await storage.getLotCatalogByCode(req.body.code);
    if (existing) {
      return res.status(409).json({ message: `Lot code "${req.body.code}" already exists` });
    }
    const entry = await storage.createLotCatalogEntry(req.body);
    res.status(201).json(entry);
  },
);

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const updateLotCatalogSchema = insertLotCatalogSchema
  .partial()
  .refine((v) => v.code !== undefined || v.descriptionFr !== undefined, {
    message: "Provide a code or description to update",
  });

router.patch(
  "/api/lot-catalog/:id",
  validateRequest({ params: idParamSchema, body: updateLotCatalogSchema }),
  async (req, res) => {
    const id = Number(req.params.id);
    const existing = await storage.getLotCatalogEntry(id);
    if (!existing) {
      return res.status(404).json({ message: "Lot catalog entry not found" });
    }
    const data: { code?: string; descriptionFr?: string } = {};
    if (req.body.code !== undefined) data.code = req.body.code;
    if (req.body.descriptionFr !== undefined) data.descriptionFr = req.body.descriptionFr;
    if (data.code && data.code !== existing.code) {
      const clash = await storage.getLotCatalogByCode(data.code);
      if (clash) {
        return res.status(409).json({ message: `Lot code "${data.code}" already exists` });
      }
    }
    try {
      const updated = await storage.updateLotCatalogEntry(id, data);
      res.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update lot";
      res.status(409).json({ message });
    }
  },
);

router.delete(
  "/api/lot-catalog/:id",
  validateRequest({ params: idParamSchema }),
  async (req, res) => {
    const id = Number(req.params.id);
    const existing = await storage.getLotCatalogEntry(id);
    if (!existing) {
      return res.status(404).json({ message: "Lot catalog entry not found" });
    }
    const usage = await storage.countProjectLotsByCode(existing.code);
    if (usage > 0) {
      return res.status(409).json({
        message: `Cannot delete "${existing.code}" — still used by ${usage} project lot${usage === 1 ? "" : "s"} (and any devis referencing them). Reassign or remove those lots first.`,
      });
    }
    await storage.deleteLotCatalogEntry(id);
    res.status(204).end();
  },
);

router.post(
  "/api/projects/:projectId/lots/assign-from-catalog",
  validateRequest({ params: assignSchema, body: assignBodySchema }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const { catalogCode, devisId } = req.body;

    const project = await storage.getProject(projectId);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    let devis: Awaited<ReturnType<typeof storage.getDevis>> | undefined;
    if (devisId !== undefined) {
      devis = await storage.getDevis(devisId);
      if (!devis) {
        return res.status(404).json({ message: "Devis not found" });
      }
      if (devis.projectId !== projectId) {
        return res.status(400).json({ message: "Devis does not belong to this project" });
      }
    }

    const lot = await storage.ensureProjectLotFromCatalog(projectId, catalogCode);
    if (!lot) {
      return res.status(404).json({ message: `Lot code "${catalogCode}" not found in master list` });
    }
    if (devisId !== undefined && devis) {
      const updates: Record<string, unknown> = { lotId: lot.id };

      // Clear stale "needs new lot" warnings now that a master code is assigned.
      const existingWarnings = (devis.validationWarnings as ValidatorWarningLike[] | null) ?? [];
      const remainingWarnings = existingWarnings.filter((w) => w?.field !== "lotReferences");
      if (remainingWarnings.length !== existingWarnings.length) {
        updates.validationWarnings = remainingWarnings;
      }

      await storage.updateDevis(devisId, updates);

      // Reconcile advisories so any open lotReferences advisory rows get resolved.
      try {
        await reconcileAdvisories({ devisId }, remainingWarnings);
      } catch (err) {
        console.warn("[Assign From Catalog] Advisory reconciliation failed:", err);
      }
    }
    res.json({ lot });
  },
);

export default router;
