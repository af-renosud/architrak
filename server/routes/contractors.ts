import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertContractorSchema } from "@shared/schema";
import { validateRequest } from "../middleware/validate";
import { runContractorAutoSync, getLastContractorAutoSync } from "../archidoc/contractor-auto-sync";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });

const updateContractorSchema = insertContractorSchema.partial();

const linkedContractorUpdateSchema = z
  .object({
    notes: z.string().nullable().optional(),
  })
  .strict();

router.get("/api/contractors", async (_req, res) => {
  const contractors = await storage.getContractors();
  res.json(contractors);
});

router.get("/api/contractors/sync-status", async (_req, res) => {
  const status = await getLastContractorAutoSync();
  res.json(status);
});

router.post("/api/contractors/sync", async (_req, res) => {
  try {
    const result = await runContractorAutoSync({ incremental: false });
    if (result.error) {
      return res.status(502).json({ message: result.error, ...result });
    }
    res.json({ message: "Contractor sync completed", ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Contractor sync failed: ${message}` });
  }
});

router.post(
  "/api/contractors",
  validateRequest({ body: insertContractorSchema }),
  async (req, res) => {
    const contractor = await storage.createContractor(req.body);
    res.status(201).json(contractor);
  },
);

router.get("/api/contractors/:id", async (req, res) => {
  const contractor = await storage.getContractor(Number(req.params.id));
  if (!contractor) return res.status(404).json({ message: "Contractor not found" });
  res.json(contractor);
});

router.patch(
  "/api/contractors/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const id = Number(req.params.id);
    const existing = await storage.getContractor(id);
    if (!existing) return res.status(404).json({ message: "Contractor not found" });

    let data: Record<string, unknown>;
    if (existing.archidocId) {
      const parsed = linkedContractorUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "This contractor is managed in ArchiDoc. Only 'notes' can be edited locally.",
          errors: parsed.error.flatten(),
        });
      }
      data = parsed.data;
    } else {
      const parsed = updateContractorSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid contractor data", errors: parsed.error.flatten() });
      }
      data = parsed.data;
    }

    const contractor = await storage.updateContractor(id, data);
    if (!contractor) return res.status(404).json({ message: "Contractor not found" });
    res.json(contractor);
  },
);

router.get("/api/contractors/:id/devis", async (req, res) => {
  const devis = await storage.getDevisByContractor(Number(req.params.id));
  res.json(devis);
});

router.get("/api/contractors/:id/invoices", async (req, res) => {
  const invoices = await storage.getInvoicesByContractor(Number(req.params.id));
  res.json(invoices);
});

export default router;
