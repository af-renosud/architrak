import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertContractorSchema, type InsertContractor } from "@shared/schema";
import { validateRequest } from "../middleware/validate";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const updateContractorSchema = insertContractorSchema.partial();

router.get("/api/contractors", async (_req, res) => {
  const contractors = await storage.getContractors();
  res.json(contractors);
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
  validateRequest({ params: idParams, body: updateContractorSchema }),
  async (req, res) => {
    const contractor = await storage.updateContractor(Number(req.params.id), req.body);
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
