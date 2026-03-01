import { Router } from "express";
import { storage } from "../storage";
import { insertFeeSchema, insertFeeEntrySchema } from "@shared/schema";
import { markFeeEntryInvoiced } from "../services/fee-calculation.service";
import { roundCurrency } from "@shared/financial-utils";

const router = Router();

router.get("/api/projects/:projectId/fees", async (req, res) => {
  const feesList = await storage.getFeesByProject(Number(req.params.projectId));
  res.json(feesList);
});

router.post("/api/fees", async (req, res) => {
  const parsed = insertFeeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid fee data", errors: parsed.error.flatten() });
  const fee = await storage.createFee(parsed.data);
  res.status(201).json(fee);
});

router.patch("/api/fees/:id", async (req, res) => {
  const parsed = insertFeeSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid fee data", errors: parsed.error.flatten() });
  const fee = await storage.updateFee(Number(req.params.id), parsed.data);
  if (!fee) return res.status(404).json({ message: "Fee not found" });
  res.json(fee);
});

router.get("/api/projects/:projectId/fee-entries", async (req, res) => {
  const entries = await storage.getFeeEntriesByProject(Number(req.params.projectId));
  res.json(entries);
});

router.get("/api/fees/:feeId/entries", async (req, res) => {
  const entries = await storage.getFeeEntries(Number(req.params.feeId));
  res.json(entries);
});

router.post("/api/fees/:feeId/entries", async (req, res) => {
  const parsed = insertFeeEntrySchema.safeParse({ ...req.body, feeId: Number(req.params.feeId) });
  if (!parsed.success) return res.status(400).json({ message: "Invalid fee entry data", errors: parsed.error.flatten() });
  const entry = await storage.createFeeEntry(parsed.data);
  res.status(201).json(entry);
});

router.patch("/api/fee-entries/:id", async (req, res) => {
  const parsed = insertFeeEntrySchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid fee entry data", errors: parsed.error.flatten() });
  const entry = await storage.updateFeeEntry(Number(req.params.id), parsed.data);
  if (!entry) return res.status(404).json({ message: "Fee entry not found" });
  res.json(entry);
});

router.get("/api/projects/:projectId/fees/by-phase", async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

    const feesList = await storage.getFeesByProject(projectId);

    const phases = ["conception", "chantier", "aor", "unassigned"] as const;
    const grouped: Record<string, { phase: string; fees: typeof feesList; totalHt: number; totalInvoiced: number; totalRemaining: number }> = {};

    for (const phase of phases) {
      grouped[phase] = { phase, fees: [], totalHt: 0, totalInvoiced: 0, totalRemaining: 0 };
    }

    let grandTotalHt = 0;
    let grandTotalInvoiced = 0;
    let grandTotalRemaining = 0;

    for (const fee of feesList) {
      const phase = fee.phase && phases.includes(fee.phase as any) ? fee.phase : "unassigned";
      const ht = parseFloat(fee.feeAmountHt);
      const invoiced = parseFloat(fee.invoicedAmount ?? "0");
      const remaining = roundCurrency(ht - invoiced);

      grouped[phase].fees.push(fee);
      grouped[phase].totalHt += ht;
      grouped[phase].totalInvoiced += invoiced;
      grouped[phase].totalRemaining += remaining;

      grandTotalHt += ht;
      grandTotalInvoiced += invoiced;
      grandTotalRemaining += remaining;
    }

    res.json({
      phases: phases.map(p => ({
        ...grouped[p],
        totalHt: roundCurrency(grouped[p].totalHt),
        totalInvoiced: roundCurrency(grouped[p].totalInvoiced),
        totalRemaining: roundCurrency(grouped[p].totalRemaining),
      })).filter(g => g.fees.length > 0),
      grandTotals: {
        totalHt: roundCurrency(grandTotalHt),
        totalInvoiced: roundCurrency(grandTotalInvoiced),
        totalRemaining: roundCurrency(grandTotalRemaining),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Fee phase summary failed: ${message}` });
  }
});

router.post("/api/fee-entries/:id/mark-invoiced", async (req, res) => {
  try {
    const { pennylaneInvoiceRef } = req.body ?? {};
    const result = await markFeeEntryInvoiced(Number(req.params.id), pennylaneInvoiceRef);
    res.status(result.status).json(result.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Mark invoiced failed: ${message}` });
  }
});

export default router;
