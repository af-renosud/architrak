import { Router } from "express";
import { storage } from "../storage";
import { insertInvoiceSchema } from "@shared/schema";
import { upload } from "../middleware/upload";
import { processInvoiceUpload } from "../services/invoice-upload.service";
import { approveInvoice } from "../services/invoice-approval.service";
import { getDocumentStream } from "../storage/object-storage";

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

router.get("/api/projects/:projectId/invoices", async (req, res) => {
  const invs = await storage.getInvoicesByProject(Number(req.params.projectId));
  res.json(invs);
});

export default router;
