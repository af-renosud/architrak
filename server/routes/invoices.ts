import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { parsePagination } from "../lib/pagination";
import { insertInvoiceSchema } from "@shared/schema";
import { upload } from "../middleware/upload";
import { processInvoiceUpload } from "../services/invoice-upload.service";
import { PdfPasswordProtectedError } from "../gmail/document-parser";
import { approveInvoice } from "../services/invoice-approval.service";
import { getDocumentStream } from "../storage/object-storage";
import { validateExtraction } from "../services/extraction-validator";
import { roundCurrency, calculateTtc } from "../../shared/financial-utils";
import {
  reconcileAdvisories,
  getAdvisoriesForInvoice,
  acknowledgeAdvisoryForSubject,
} from "../services/advisory-reconciler";

const invoiceConfirmSchema = z.object({
  amountHt: z.coerce.number().nonnegative().optional(),
  tvaRate: z.coerce.number().min(0).max(100).optional(),
  amountTtc: z.coerce.number().nonnegative().optional(),
  invoiceNumber: z.string().min(1).optional(),
  dateIssued: z.string().optional(),
}).strict();

const router = Router();

router.get("/api/devis/:devisId/invoices", async (req, res) => {
  const invoices = await storage.getInvoicesByDevis(Number(req.params.devisId));
  res.json(invoices);
});

router.post("/api/devis/:devisId/invoices/upload", upload.single("file"), async (req, res) => {
  try {
    const devisId = Number(req.params.devisId);
    const file = req.file;
    if (!file) return res.status(400).json({ message: "No file provided" });

    const result = await processInvoiceUpload(devisId, file);
    res.status(result.status).json(result.data);
  } catch (err: unknown) {
    if (err instanceof PdfPasswordProtectedError) {
      return res.status(422).json({ message: err.message, code: "PDF_PASSWORD_PROTECTED" });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Invoice Upload] Error:", message);
    res.status(500).json({ message: `Invoice upload/parse failed: ${message}` });
  }
});

router.post("/api/devis/:devisId/invoices", async (req, res) => {
  const parsed = insertInvoiceSchema.safeParse({ ...req.body, devisId: Number(req.params.devisId) });
  if (!parsed.success) return res.status(400).json({ message: "Invalid invoice data", errors: parsed.error.flatten() });
  const invoice = await storage.createInvoice(parsed.data);
  res.status(201).json(invoice);
});

router.get("/api/invoices/:id/pdf", async (req, res) => {
  try {
    const inv = await storage.getInvoice(Number(req.params.id));
    if (!inv || !inv.pdfPath) return res.status(404).json({ message: "No PDF attached to this invoice" });
    const { stream, contentType, size } = await getDocumentStream(inv.pdfPath);
    res.setHeader("Content-Type", contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="invoice-${inv.invoiceNumber}.pdf"`);
    if (size) res.setHeader("Content-Length", String(size));
    stream.pipe(res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `PDF view failed: ${message}` });
  }
});

router.patch("/api/invoices/:id", async (req, res) => {
  const parsed = insertInvoiceSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid invoice data", errors: parsed.error.flatten() });
  const invoice = await storage.updateInvoice(Number(req.params.id), parsed.data);
  if (!invoice) return res.status(404).json({ message: "Invoice not found" });
  res.json(invoice);
});

router.post("/api/invoices/:id/approve", async (req, res) => {
  try {
    const result = await approveInvoice(Number(req.params.id));
    res.status(result.status).json(result.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Invoice Approve] Error:", message);
    res.status(500).json({ message: `Approval failed: ${message}` });
  }
});

router.post("/api/invoices/:id/confirm", async (req, res) => {
  try {
    const invoice = await storage.getInvoice(Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.status !== "draft") return res.status(400).json({ message: "Only draft invoices can be confirmed" });

    const parsed = invoiceConfirmSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ message: "Invalid corrections", errors: parsed.error.flatten() });
    const corrections = parsed.data;
    const updates: Record<string, any> = { status: "pending" };

    if (corrections.amountHt != null) updates.amountHt = String(roundCurrency(corrections.amountHt));
    if (corrections.amountTtc != null) {
      updates.amountTtc = String(roundCurrency(corrections.amountTtc));
    } else if (corrections.amountHt != null || corrections.tvaRate != null) {
      // tvaRate is not persisted on invoices (schema source of truth in shared/schema.ts).
      // Derive the prevailing rate from existing amountHt/tvaAmount when corrections do
      // not supply one, falling back to the project default of 20% for safety.
      const ht = corrections.amountHt != null ? corrections.amountHt : Number(invoice.amountHt);
      const existingHt = Number(invoice.amountHt);
      const existingTva = Number(invoice.tvaAmount);
      const derivedRate = existingHt > 0 ? (existingTva / existingHt) * 100 : 20;
      const rate = corrections.tvaRate != null ? corrections.tvaRate : derivedRate;
      updates.amountTtc = String(calculateTtc(ht, rate));
    }
    if (corrections.invoiceNumber != null) updates.invoiceNumber = corrections.invoiceNumber;
    if (corrections.dateIssued != null) updates.dateIssued = corrections.dateIssued;

    let nextWarnings = (invoice.validationWarnings as any[] | null) ?? [];
    if (Object.keys(corrections).length > 0) {
      const aiData = (invoice.aiExtractedData as any) || {};
      const correctedParsed = { ...aiData, ...corrections };
      const revalidation = validateExtraction(correctedParsed);
      nextWarnings = revalidation.warnings;
      updates.validationWarnings = revalidation.warnings;
      updates.aiConfidence = revalidation.confidenceScore;
    }

    const updated = await storage.updateInvoice(Number(req.params.id), updates);
    try {
      await reconcileAdvisories({ invoiceId: Number(req.params.id) }, nextWarnings);
    } catch (advErr) {
      console.warn("[Invoice Confirm] Advisory reconciliation failed:", advErr);
    }
    res.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Confirm failed: ${message}` });
  }
});

router.delete("/api/invoices/:id", async (req, res) => {
  try {
    const invoice = await storage.getInvoice(Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.status !== "draft") return res.status(400).json({ message: "Only draft invoices can be deleted" });
    await storage.deleteInvoice(Number(req.params.id));
    res.json({ message: "Invoice deleted" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Delete failed: ${message}` });
  }
});

router.get("/api/projects/:projectId/invoices", async (req, res) => {
  const { limit, offset } = parsePagination(req, { defaultLimit: 100, maxLimit: 500 });
  const invs = await storage.getInvoicesByProject(Number(req.params.projectId));
  res.setHeader("X-Total-Count", String(invs.length));
  res.json(invs.slice(offset, offset + limit));
});

router.get("/api/invoices/:id/advisories", async (req, res) => {
  const items = await getAdvisoriesForInvoice(Number(req.params.id));
  res.json(items);
});

router.post("/api/invoices/:id/advisories/:advisoryId/acknowledge", requireAuth, async (req, res) => {
  const invoiceId = Number(req.params.id);
  const advisoryId = Number(req.params.advisoryId);
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ message: "Authentication required" });
  const row = await acknowledgeAdvisoryForSubject(
    advisoryId,
    { invoiceId },
    String(userId),
  );
  if (!row) {
    return res
      .status(404)
      .json({ message: "Advisory not found, already acknowledged, or not on this invoice" });
  }
  res.json(row);
});

export default router;
