import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { ARCHITECT_FEE_INVOICE_STATUSES, type ArchitectFeeInvoiceStatus } from "@shared/schema";
import { confirmArchitectFeeInvoice } from "../services/architect-fee-invoice-confirm.service";
import { validateRequest } from "../middleware/validate";

/**
 * Task #425 — review queue for the firm's own outbound honoraires invoices
 * caught by Gmail polling. Read, dismiss, and confirm (Task #426): the
 * confirmation transaction (milestone invoiced + fee entry recording +
 * Pennylane reconciliation) lives in
 * services/architect-fee-invoice-confirm.service.ts. Review-state columns
 * are server-authoritative (dedicated storage write, never a generic PATCH
 * body). Every review decision is audited append-only in
 * architect_fee_invoice_events.
 */
const router = Router();

router.get("/api/architect-fee-invoices", async (req, res) => {
  const raw = typeof req.query.status === "string" ? req.query.status : undefined;
  let status: ArchitectFeeInvoiceStatus | undefined;
  if (raw && raw !== "all") {
    if (!(ARCHITECT_FEE_INVOICE_STATUSES as readonly string[]).includes(raw)) {
      return res.status(400).json({ message: `Invalid status filter: ${raw}` });
    }
    status = raw as ArchitectFeeInvoiceStatus;
  }
  const rows = await storage.listArchitectFeeInvoices(status);
  res.json(rows);
});

router.get("/api/architect-fee-invoices/:id", async (req, res) => {
  const id = z.coerce.number().int().positive().safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ message: "Invalid id" });
  const row = await storage.getArchitectFeeInvoice(id.data);
  if (!row) return res.status(404).json({ message: "Fee invoice not found" });
  res.json(row);
});

router.post("/api/architect-fee-invoices/:id/dismiss", async (req, res) => {
  const id = z.coerce.number().int().positive().safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ message: "Invalid id" });
  const row = await storage.getArchitectFeeInvoice(id.data);
  if (!row) return res.status(404).json({ message: "Fee invoice not found" });
  if (row.status !== "pending_review") {
    return res.status(409).json({ message: `Cannot dismiss a fee invoice in state "${row.status}".` });
  }
  const user = (req as { user?: { email?: string | null } }).user;
  const updated = await storage.setArchitectFeeInvoiceReviewState(id.data, {
    status: "dismissed",
    reviewedBy: user?.email ?? null,
  });
  // Append-only decision audit (Task #426) — every review decision leaves a trace.
  await storage.createArchitectFeeInvoiceEvent({
    architectFeeInvoiceId: id.data,
    action: "dismissed",
    actor: user?.email ?? null,
    note: null,
    details: null,
  });
  res.json(updated);
});

/** Append-only review-decision history for one caught invoice. */
router.get("/api/architect-fee-invoices/:id/events", async (req, res) => {
  const id = z.coerce.number().int().positive().safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ message: "Invalid id" });
  res.json(await storage.listArchitectFeeInvoiceEvents(id.data));
});

const confirmBodySchema = z
  .object({
    projectId: z.number().int().positive(),
    milestoneId: z.number().int().positive(),
  })
  .strict();

/**
 * Task #426 — explicit operator confirmation. Atomically binds the evidence
 * to a project + milestone, records/attaches the fee entry with the
 * EXTRACTED ref/date, and transitions the milestone to `invoiced`
 * (`paid` stays with the Pennylane paid-poller). Idempotent on replay.
 */
router.post(
  "/api/architect-fee-invoices/:id/confirm",
  validateRequest({ body: confirmBodySchema }),
  async (req, res) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ message: "Invalid id" });
    const user = (req as { user?: { email?: string | null } }).user;
    const result = await confirmArchitectFeeInvoice({
      evidenceId: id.data,
      projectId: req.body.projectId,
      milestoneId: req.body.milestoneId,
      actor: user?.email ?? null,
    });
    if (!result.ok) {
      return res.status(result.status).json({ message: result.message, code: result.code, parked: result.parked ?? false });
    }
    res.json({
      evidence: result.evidence,
      feeEntryId: result.feeEntryId,
      milestoneId: result.milestoneId,
      reconciliation: result.reconciliation,
      replayed: result.replayed,
    });
  },
);

export default router;
