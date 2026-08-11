import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { ARCHITECT_FEE_INVOICE_STATUSES, type ArchitectFeeInvoiceStatus } from "@shared/schema";

/**
 * Task #425 — review queue for the firm's own outbound honoraires invoices
 * caught by Gmail polling. Read + dismiss only: the confirmation
 * transaction (milestone invoiced + fee entry recording + Pennylane
 * reconciliation) is Task #426 and has NO endpoint here yet — the UI's
 * confirm button is disabled. Review-state columns are server-authoritative
 * (dedicated storage write, never a generic PATCH body).
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
  res.json(updated);
});

export default router;
