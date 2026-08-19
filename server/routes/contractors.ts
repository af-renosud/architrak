import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertContractorSchema } from "@shared/schema";
import { validateRequest } from "../middleware/validate";
import { runContractorAutoSync, getLastContractorAutoSync } from "../archidoc/contractor-auto-sync";
import { sendCommunication } from "../communications/email-sender";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });

const updateContractorSchema = insertContractorSchema.partial();

// Task #463 — the default TVA regime is locally-managed fiscal configuration
// (never part of the ArchiDoc sync payload), so it stays editable even on
// ArchiDoc-linked contractors. Same strict rate validation as the shared
// insert schema.
const linkedContractorUpdateSchema = z
  .object({
    notes: z.string().nullable().optional(),
    defaultTvaRatePercent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, "TVA rate must be a decimal with at most 2 decimal places")
      .refine((v) => { const n = parseFloat(v); return n >= 0 && n <= 100; }, {
        message: "TVA rate must be between 0 and 100",
      })
      .nullable()
      .optional(),
    defaultTvaAutoliquidation: z.boolean().optional(),
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
    if (result.alreadyRunning) {
      return res.status(409).json({ message: "Another ArchiDoc sync is already in progress", ...result });
    }
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
          message: "This contractor is managed in ArchiDoc. Only 'notes' and the default TVA regime can be edited locally.",
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

// Task #521 — bulk-retry all failed certificat_contractor_notice
// communications for a given contractor in one action. Each send goes
// through the strict recipient validation in sendCommunication (which
// refreshes the address from the contractor record), so fixing the
// contractor's email is sufficient before pressing "retry all".
router.post(
  "/api/contractors/:id/retry-failed-notices",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const contractorId = Number(req.params.id);
    const contractor = await storage.getContractor(contractorId);
    if (!contractor) return res.status(404).json({ message: "Contractor not found" });

    const groups = await storage.getFailedContractorNoticeGroups();
    const group = groups.find(g => g.contractorId === contractorId);
    if (!group || group.communicationIds.length === 0) {
      return res.json({ retried: 0, succeeded: 0, failed: 0 });
    }

    const sentByUserId = req.session.userId ?? null;
    const results = await Promise.allSettled(
      group.communicationIds.map(id => sendCommunication(id, { sentByUserId })),
    );

    const succeeded = results.filter(r => r.status === "fulfilled").length;
    const failed = results.filter(r => r.status === "rejected").length;
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;

    res.json({
      retried: group.communicationIds.length,
      succeeded,
      failed,
      firstError: firstError instanceof Error ? firstError.message : firstError ? String(firstError) : undefined,
    });
  },
);

export default router;
