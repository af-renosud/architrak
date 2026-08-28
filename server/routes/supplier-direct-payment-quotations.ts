import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { archidocPaymentSupplierSyncState } from "@shared/schema";
import { requireArchitectOperator } from "../auth/architect-operator";
import { upload } from "../middleware/upload";
import { db } from "../db";
import {
  DrizzleSupplierQuotationRepository,
  SupplierQuotationError,
  confirmPaymentSupplierAppointment,
  ingestSupplierQuotation,
} from "../services/payment-supplier-appointment";
import {
  DrizzlePaymentSupplierMirrorStore,
  PAYMENT_SUPPLIER_STREAM,
  syncPaymentSupplierReadiness,
} from "../archidoc/payment-supplier-mirror-service";

const router = Router();
const quotations = new DrizzleSupplierQuotationRepository();

const ingestFields = z.object({
  projectId: z.coerce.number().int().positive(),
  archidocProjectId: z.string().trim().min(1).max(255),
  sourceDocumentId: z.string().trim().min(1).max(500),
  extractedSupplierName: z.string().max(500).optional(),
  extractedSupplierSiret: z.string().max(40).optional(),
  paymentSupplierId: z.string().max(255).optional(),
});

const confirmFields = z.object({
  paymentSupplierId: z.string().trim().min(1).max(255),
});

function id(value: string | string[]): number | null {
  if (Array.isArray(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sendError(res: any, error: unknown) {
  if (error instanceof SupplierQuotationError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  throw error;
}

router.post(
  "/api/supplier-direct-payment-quotations",
  requireArchitectOperator,
  upload.single("file"),
  async (req, res) => {
    try {
      const fields = ingestFields.safeParse(req.body);
      if (!fields.success) {
        return res.status(400).json({
          code: "invalid_metadata",
          message: fields.error.errors[0]?.message ?? "Invalid quotation metadata",
        });
      }
      if (!req.file) {
        return res.status(400).json({ code: "missing_pdf", message: "A PDF file is required" });
      }
      const quotation = await ingestSupplierQuotation(quotations, {
        ...fields.data,
        fileName: req.file.originalname,
        pdf: req.file.buffer,
        extractedPaymentSupplierId: fields.data.paymentSupplierId,
      });
      return res.status(201).json({ quotation: withoutPdf(quotation) });
    } catch (error) {
      return sendError(res, error);
    }
  },
);

router.get("/api/supplier-direct-payment-quotations/:id", requireArchitectOperator, async (req, res) => {
  const quotationId = id(req.params.id);
  if (!quotationId) return res.status(400).json({ message: "Invalid quotation id" });
  const quotation = await quotations.getQuotation(quotationId);
  if (!quotation) return res.status(404).json({ message: "Supplier quotation not found" });
  return res.json({ quotation: withoutPdf(quotation) });
});

router.get("/api/supplier-direct-payment-quotations/:id/preview", requireArchitectOperator, async (req, res) => {
  const quotationId = id(req.params.id);
  if (!quotationId) return res.status(400).json({ message: "Invalid quotation id" });
  const quotation = await quotations.getQuotation(quotationId);
  if (!quotation) return res.status(404).json({ message: "Supplier quotation not found" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(quotation.fileName)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.send(quotation.sourcePdf);
});

router.post("/api/supplier-direct-payment-quotations/:id/confirm", requireArchitectOperator, async (req, res) => {
  try {
    const quotationId = id(req.params.id);
    if (!quotationId) return res.status(400).json({ message: "Invalid quotation id" });
    const fields = confirmFields.safeParse(req.body);
    if (!fields.success) {
      return res.status(400).json({ code: "invalid_supplier", message: "paymentSupplierId is required" });
    }
    const quotation = await confirmPaymentSupplierAppointment(
      quotations,
      quotationId,
      fields.data.paymentSupplierId,
      req.session.userId!,
    );
    return res.json({ quotation: withoutPdf(quotation) });
  } catch (error) {
    return sendError(res, error);
  }
});

// In this single-firm app every authenticated Workspace user is an architect
// operator (see routes/index.ts tenancy assumption). There is no unauthenticated
// sync trigger and no development bypass.
router.get("/api/admin/payment-supplier-readiness/status", requireArchitectOperator, async (_req, res) => {
  const state = (await db.select().from(archidocPaymentSupplierSyncState)
    .where(eq(archidocPaymentSupplierSyncState.stream, PAYMENT_SUPPLIER_STREAM)).limit(1))[0];
  return res.json({
    stream: PAYMENT_SUPPLIER_STREAM,
    sequence: (state?.sequence ?? BigInt(0)).toString(),
    updatedAt: state?.updatedAt ?? null,
  });
});

router.post("/api/admin/payment-supplier-readiness/sync", requireArchitectOperator, async (req, res) => {
  const parsed = z.object({ mode: z.enum(["incremental", "bootstrap"]).default("incremental") })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: "mode must be incremental or bootstrap" });
  const state = (await db.select({ sequence: archidocPaymentSupplierSyncState.sequence })
    .from(archidocPaymentSupplierSyncState)
    .where(eq(archidocPaymentSupplierSyncState.stream, PAYMENT_SUPPLIER_STREAM)).limit(1))[0];
  const request = parsed.data.mode === "bootstrap"
    ? { mode: "bootstrap" as const }
    : { mode: "incremental" as const, afterSequence: state?.sequence ?? BigInt(0) };
  const applied = await syncPaymentSupplierReadiness(new DrizzlePaymentSupplierMirrorStore(), request);
  return res.json({ mode: parsed.data.mode, applied });
});

function withoutPdf<T extends { sourcePdf: Buffer }>(quotation: T): Omit<T, "sourcePdf"> {
  const { sourcePdf: _sourcePdf, ...safe } = quotation;
  return safe;
}

export default router;