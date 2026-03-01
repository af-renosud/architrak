import { Router } from "express";
import { storage } from "../storage";
import { insertContractorSchema } from "@shared/schema";

const router = Router();

router.get("/api/contractors", async (_req, res) => {
  const contractors = await storage.getContractors();
  res.json(contractors);
});

router.post("/api/contractors", async (req, res) => {
  const parsed = insertContractorSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid contractor data", errors: parsed.error.flatten() });
  const contractor = await storage.createContractor(parsed.data);
  res.status(201).json(contractor);
});

router.get("/api/contractors/:id", async (req, res) => {
  const contractor = await storage.getContractor(Number(req.params.id));
  if (!contractor) return res.status(404).json({ message: "Contractor not found" });
  res.json(contractor);
});

router.patch("/api/contractors/:id", async (req, res) => {
  const parsed = insertContractorSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid contractor data", errors: parsed.error.flatten() });
  const contractor = await storage.updateContractor(Number(req.params.id), parsed.data);
  if (!contractor) return res.status(404).json({ message: "Contractor not found" });
  res.json(contractor);
});

router.get("/api/contractors/:id/devis", async (req, res) => {
  const devis = await storage.getDevisByContractor(Number(req.params.id));
  res.json(devis);
});

router.get("/api/contractors/:id/invoices", async (req, res) => {
  const invoices = await storage.getInvoicesByContractor(Number(req.params.id));
  res.json(invoices);
});

export default router;
