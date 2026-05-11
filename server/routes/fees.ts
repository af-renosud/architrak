import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import {
  insertFeeSchema,
  insertFeeEntrySchema,
  type InsertFee,
  type InsertFeeEntry,
} from "@shared/schema";
import { markFeeEntryInvoiced } from "../services/fee-calculation.service";
import {
  getOutstandingFeesGlobal,
  getOutstandingFeesForProject,
} from "../services/outstanding-fees.service";
import { roundCurrency } from "@shared/financial-utils";
import { validateRequest } from "../middleware/validate";

const router = Router();

router.get("/api/fees/outstanding", async (_req, res) => {
  const summary = await getOutstandingFeesGlobal();
  res.json(summary);
});

router.get("/api/projects/:projectId/fees/outstanding", async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ message: "Invalid project ID" });
  }
  const summary = await getOutstandingFeesForProject(projectId);
  res.json(summary);
});
const idParams = z.object({ id: z.coerce.number().int().positive() });
const feeIdParams = z.object({ feeId: z.coerce.number().int().positive() });
const updateFeeSchema = insertFeeSchema.partial();
const updateFeeEntrySchema = insertFeeEntrySchema.partial();
const createFeeEntryBodySchema = insertFeeEntrySchema.omit({ feeId: true });
const markInvoicedBodySchema = z.object({
  pennylaneInvoiceRef: z.string().trim().min(1).optional(),
}).strict().partial();

router.get("/api/projects/:projectId/fees", async (req, res) => {
  const feesList = await storage.getFeesByProject(Number(req.params.projectId));
  res.json(feesList);
});

router.post(
  "/api/fees",
  validateRequest({ body: insertFeeSchema }),
  async (req, res) => {
    const fee = await storage.createFee(req.body);
    res.status(201).json(fee);
  },
);

router.patch(
  "/api/fees/:id",
  validateRequest({ params: idParams, body: updateFeeSchema }),
  async (req, res) => {
    const fee = await storage.updateFee(Number(req.params.id), req.body);
    if (!fee) return res.status(404).json({ message: "Fee not found" });
    res.json(fee);
  },
);

router.get("/api/projects/:projectId/fee-entries", async (req, res) => {
  const entries = await storage.getFeeEntriesByProject(Number(req.params.projectId));
  res.json(entries);
});

router.get("/api/fees/:feeId/entries", async (req, res) => {
  const entries = await storage.getFeeEntries(Number(req.params.feeId));
  res.json(entries);
});

router.post(
  "/api/fees/:feeId/entries",
  validateRequest({ params: feeIdParams, body: createFeeEntryBodySchema }),
  async (req, res) => {
    const entry = await storage.createFeeEntry({ ...req.body, feeId: Number(req.params.feeId) });
    res.status(201).json(entry);
  },
);

router.patch(
  "/api/fee-entries/:id",
  validateRequest({ params: idParams, body: updateFeeEntrySchema }),
  async (req, res) => {
    const entry = await storage.updateFeeEntry(Number(req.params.id), req.body);
    if (!entry) return res.status(404).json({ message: "Fee entry not found" });
    res.json(entry);
  },
);

router.get("/api/projects/:projectId/fees/by-phase", async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

  const feesList = await storage.getFeesByProject(projectId);

  const phases = ["conception", "chantier", "aor", "unassigned"] as const;
  type Phase = typeof phases[number];
  const grouped: Record<Phase, { phase: Phase; fees: typeof feesList; totalHt: number; totalInvoiced: number; totalRemaining: number }> = {
    conception: { phase: "conception", fees: [], totalHt: 0, totalInvoiced: 0, totalRemaining: 0 },
    chantier: { phase: "chantier", fees: [], totalHt: 0, totalInvoiced: 0, totalRemaining: 0 },
    aor: { phase: "aor", fees: [], totalHt: 0, totalInvoiced: 0, totalRemaining: 0 },
    unassigned: { phase: "unassigned", fees: [], totalHt: 0, totalInvoiced: 0, totalRemaining: 0 },
  };

  let grandTotalHt = 0;
  let grandTotalInvoiced = 0;
  let grandTotalRemaining = 0;

  for (const fee of feesList) {
    const phase: Phase = fee.phase && (phases as readonly string[]).includes(fee.phase)
      ? (fee.phase as Phase)
      : "unassigned";
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
    phases: phases.map((p) => ({
      ...grouped[p],
      totalHt: roundCurrency(grouped[p].totalHt),
      totalInvoiced: roundCurrency(grouped[p].totalInvoiced),
      totalRemaining: roundCurrency(grouped[p].totalRemaining),
    })).filter((g) => g.fees.length > 0),
    grandTotals: {
      totalHt: roundCurrency(grandTotalHt),
      totalInvoiced: roundCurrency(grandTotalInvoiced),
      totalRemaining: roundCurrency(grandTotalRemaining),
    },
  });
});

router.post(
  "/api/fee-entries/:id/mark-invoiced",
  validateRequest({ params: idParams, body: markInvoicedBodySchema }),
  async (req, res) => {
    const result = await markFeeEntryInvoiced(Number(req.params.id), req.body.pennylaneInvoiceRef);
    res.status(result.status).json(result.data);
  },
);

export default router;
