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
  enqueueHonorairesPush,
  isPennylaneConfigured,
  isPennylaneDryRun,
  isPennylanePushEnabled,
} from "../services/pennylane/push-queue.service";
import {
  getOutstandingFeesGlobal,
  getOutstandingFeesForProject,
  getFeeEntryCopyText,
} from "../services/outstanding-fees.service";
import { roundCurrency } from "@shared/financial-utils";
import { validateRequest } from "../middleware/validate";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const feeIdParams = z.object({ feeId: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });

router.get("/api/fees/outstanding", async (_req, res) => {
  const summary = await getOutstandingFeesGlobal();
  res.json(summary);
});

router.get(
  "/api/projects/:projectId/fees/outstanding",
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    const summary = await getOutstandingFeesForProject(Number(req.params.projectId));
    res.json(summary);
  },
);

router.get(
  "/api/fee-entries/:id/copy-text",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const text = await getFeeEntryCopyText(Number(req.params.id));
    if (!text) return res.status(404).json({ message: "Fee entry not found" });
    res.json({ text });
  },
);

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

  // Architect fees (honoraires) are invoiced at the standard 20% TVA rate.
  const TVA_RATE = 0.20;

  const phases = ["conception", "chantier", "aor", "unassigned"] as const;
  type Phase = typeof phases[number];
  const grouped: Record<Phase, { phase: Phase; fees: typeof feesList; totalHt: number; totalTtc: number; totalInvoiced: number; totalInvoicedTtc: number; totalRemaining: number; totalRemainingTtc: number }> = {
    conception: { phase: "conception", fees: [], totalHt: 0, totalTtc: 0, totalInvoiced: 0, totalInvoicedTtc: 0, totalRemaining: 0, totalRemainingTtc: 0 },
    chantier: { phase: "chantier", fees: [], totalHt: 0, totalTtc: 0, totalInvoiced: 0, totalInvoicedTtc: 0, totalRemaining: 0, totalRemainingTtc: 0 },
    aor: { phase: "aor", fees: [], totalHt: 0, totalTtc: 0, totalInvoiced: 0, totalInvoicedTtc: 0, totalRemaining: 0, totalRemainingTtc: 0 },
    unassigned: { phase: "unassigned", fees: [], totalHt: 0, totalTtc: 0, totalInvoiced: 0, totalInvoicedTtc: 0, totalRemaining: 0, totalRemainingTtc: 0 },
  };

  let grandTotalHt = 0;
  let grandTotalTtc = 0;
  let grandTotalInvoiced = 0;
  let grandTotalInvoicedTtc = 0;
  let grandTotalRemaining = 0;
  let grandTotalRemainingTtc = 0;

  for (const fee of feesList) {
    const phase: Phase = fee.phase && (phases as readonly string[]).includes(fee.phase)
      ? (fee.phase as Phase)
      : "unassigned";
    const ht = parseFloat(fee.feeAmountHt);
    const ttc = roundCurrency(ht * (1 + TVA_RATE));
    const invoiced = parseFloat(fee.invoicedAmount ?? "0");
    const invoicedTtc = roundCurrency(invoiced * (1 + TVA_RATE));
    const remaining = roundCurrency(ht - invoiced);
    const remainingTtc = roundCurrency(ttc - invoicedTtc);

    grouped[phase].fees.push(fee);
    grouped[phase].totalHt += ht;
    grouped[phase].totalTtc += ttc;
    grouped[phase].totalInvoiced += invoiced;
    grouped[phase].totalInvoicedTtc += invoicedTtc;
    grouped[phase].totalRemaining += remaining;
    grouped[phase].totalRemainingTtc += remainingTtc;

    grandTotalHt += ht;
    grandTotalTtc += ttc;
    grandTotalInvoiced += invoiced;
    grandTotalInvoicedTtc += invoicedTtc;
    grandTotalRemaining += remaining;
    grandTotalRemainingTtc += remainingTtc;
  }

  res.json({
    phases: phases.map((p) => ({
      ...grouped[p],
      totalHt: roundCurrency(grouped[p].totalHt),
      totalTtc: roundCurrency(grouped[p].totalTtc),
      totalInvoiced: roundCurrency(grouped[p].totalInvoiced),
      totalInvoicedTtc: roundCurrency(grouped[p].totalInvoicedTtc),
      totalRemaining: roundCurrency(grouped[p].totalRemaining),
      totalRemainingTtc: roundCurrency(grouped[p].totalRemainingTtc),
    })).filter((g) => g.fees.length > 0),
    grandTotals: {
      totalHt: roundCurrency(grandTotalHt),
      totalTtc: roundCurrency(grandTotalTtc),
      totalInvoiced: roundCurrency(grandTotalInvoiced),
      totalInvoicedTtc: roundCurrency(grandTotalInvoicedTtc),
      totalRemaining: roundCurrency(grandTotalRemaining),
      totalRemainingTtc: roundCurrency(grandTotalRemainingTtc),
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

/**
 * Task #214 — one-click Pennylane push. Enqueues a `customer` + a
 * `customer_invoice` push for this fee entry and fires an inline
 * sweep so the operator sees status move within a second. Returns
 * 409 when the feature flag is off (UI can render a helpful tooltip).
 */
router.post(
  "/api/fees/entries/:id/invoice-now",
  validateRequest({ params: idParams }),
  async (req, res) => {
    if (!isPennylanePushEnabled()) {
      return res.status(409).json({
        message: "Pennylane push is disabled — set PENNYLANE_PUSH_ENABLED=true to enable",
        enabled: false,
      });
    }
    try {
      const row = await enqueueHonorairesPush(Number(req.params.id));
      if (!row) {
        return res.status(409).json({
          message: "Push could not be enqueued — project is not in PENNYLANE_PROJECT_WHITELIST",
          enabled: true,
        });
      }
      res.status(202).json({
        message: "Push enqueued",
        pushId: row.id,
        kind: row.kind,
        state: row.state,
        dryRun: isPennylaneDryRun(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Enqueue failed: ${message}` });
    }
  },
);

/**
 * Lightweight feature-flag probe for the Outstanding Fees UI — does
 * NOT touch Pennylane, just reads env-derived predicates. Safe to
 * call from every page render.
 */
router.get("/api/pennylane/feature-flags", (_req, res) => {
  res.json({
    configured: isPennylaneConfigured(),
    pushEnabled: isPennylanePushEnabled(),
    dryRun: isPennylaneDryRun(),
  });
});

export default router;
