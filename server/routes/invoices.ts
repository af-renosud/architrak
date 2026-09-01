import { Router, type Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { db } from "../db";
import { requireAuth } from "../auth/middleware";
import { parsePagination } from "../lib/pagination";
import {
  insertInvoiceSchema,
  invoiceAcompteApplications,
  invoices as invoicesTable,
  type InsertInvoice,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { upload } from "../middleware/upload";
import { processInvoiceUpload } from "../services/invoice-upload.service";
import { PdfPasswordProtectedError } from "../gmail/document-parser";
import { INVOICE_UPLOAD_ERROR_CODES } from "../../shared/invoice-upload-errors";
import { approveInvoice } from "../services/invoice-approval.service";
import { reopenInvoiceDraft } from "../services/draft-reopen.service";
import { getDocumentStream } from "../storage/object-storage";
import {
  generateInvoicePackagePdf,
  ProjectOverviewNotFoundError,
} from "../services/project-overview-pdf.service";
import { validateExtraction, type ValidationWarning } from "../services/extraction-validator";
import type { ParsedDocument } from "../gmail/document-parser";
import { roundCurrency, deriveTvaAmount } from "../../shared/financial-utils";
import {
  reconcileAdvisories,
  getAdvisoriesForInvoice,
  acknowledgeAdvisoryForSubject,
} from "../services/advisory-reconciler";
import { validateRequest } from "../middleware/validate";
import { evaluateAcompteGate, gateInputsFromDevis } from "../services/acompte.service";
import {
  applyInvoiceAcompteDeduction,
  invoiceAcompteProtectedSnapshot,
} from "../services/invoice-acompte-application.service";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const devisIdParams = z.object({ devisId: z.coerce.number().int().positive() });
const advisoryAckParams = z.object({
  id: z.coerce.number().int().positive(),
  advisoryId: z.coerce.number().int().positive(),
});
const createInvoiceBodySchema = insertInvoiceSchema.omit({ devisId: true });
const updateInvoiceSchema = insertInvoiceSchema.partial();

const invoiceConfirmSchema = z.object({
  amountHt: z.coerce.number().nonnegative().optional(),
  amountTtc: z.coerce.number().nonnegative().optional(),
  invoiceNumber: z.string().min(1).optional(),
  dateIssued: z.string().optional(),
}).strict();
type InvoiceConfirmInput = z.infer<typeof invoiceConfirmSchema>;

// An application is an immutable accounting snapshot of both the invoice
// gross totals and its source/devis relationship.  The generic invoice
// endpoints must not let those live values diverge after that snapshot exists.
const applicationProtectedInvoiceFields = new Set([
  "amountHt",
  "tvaAmount",
  "amountTtc",
  "devisId",
  "projectId",
  "contractorId",
  "sourceIntakeDocumentId",
  "pdfPath",
  "aiExtractedData",
]);

function changesApplicationProtectedInvoiceField(data: Record<string, unknown>): boolean {
  return Object.keys(data).some((key) => applicationProtectedInvoiceFields.has(key));
}

function immutableApplicationResponse(res: Response) {
  return res.status(409).json({
    code: "invoice_acompte_application_immutable",
    message:
      "This invoice has an applied opening-deposit snapshot. Its totals and source relationship can no longer be changed or deleted.",
  });
}

router.get("/api/devis/:devisId/invoices", async (req, res) => {
  const invoices = await storage.getInvoicesByDevis(Number(req.params.devisId));
  res.json(invoices);
});

router.post(
  "/api/devis/:devisId/invoices/upload",
  upload.single("file"),
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    try {
      const devisId = Number(req.params.devisId);
      const file = req.file;
      if (!file) {
        return res
          .status(400)
          .json({ message: "No file provided", code: INVOICE_UPLOAD_ERROR_CODES.NO_FILE_PROVIDED });
      }

      const result = await processInvoiceUpload(devisId, file);
      res.status(result.status).json(result.data);
    } catch (err: unknown) {
      if (err instanceof PdfPasswordProtectedError) {
        return res
          .status(422)
          .json({ message: err.message, code: INVOICE_UPLOAD_ERROR_CODES.PDF_PASSWORD_PROTECTED });
      }
      const message = err instanceof Error ? err.message : String(err);
      // assertPdfMagic and similar guards attach a numeric `.status` (e.g. 415)
      // on the thrown Error. Preserve it so the client sees the right HTTP
      // status and stable code instead of a collapsed 500.
      const statusFromErr =
        err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
          ? (err as { status: number }).status
          : null;
      if (statusFromErr === 415) {
        return res
          .status(415)
          .json({ message, code: INVOICE_UPLOAD_ERROR_CODES.PDF_INVALID_MAGIC });
      }
      console.error("[Invoice Upload] Error:", message);
      res
        .status(statusFromErr ?? 500)
        .json({
          message: `Invoice upload/parse failed: ${message}`,
          code: INVOICE_UPLOAD_ERROR_CODES.INVOICE_UPLOAD_FAILED,
        });
    }
  },
);

router.post(
  "/api/devis/:devisId/invoices",
  validateRequest({ params: devisIdParams, body: createInvoiceBodySchema }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    // Task #215 — gate generic invoice creation. The dedicated facture
    // d'acompte path (POST /api/devis/:id/acompte/link-invoice) is
    // exempt by design: it links an *already-created* invoice.
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    const decision = evaluateAcompteGate(gateInputsFromDevis(devis));
    if (decision.blocked) {
      return res.status(409).json({
        message: decision.message,
        code: decision.code,
        acompteState: decision.state,
      });
    }
    const invoice = await storage.createInvoice({ ...req.body, devisId });
    // Lifecycle-bound auto-revoke: this invoice may have just pushed the
    // devis to fully-invoiced. Cheap no-op when it hasn't.
    await storage.revokeDevisCheckTokenIfFullyInvoiced(devisId);
    res.status(201).json(invoice);
  },
);

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

// Task #413 — combined client package: the stored invoice PDF followed by a
// freshly generated one-page project financial overview. Never cached.
router.get(
  "/api/invoices/:id/pdf-with-overview",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const { pdfBuffer, invoiceNumber } = await generateInvoicePackagePdf(Number(req.params.id));
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="facture-${invoiceNumber}-avec-situation.pdf"`,
      );
      res.setHeader("Content-Length", String(pdfBuffer.length));
      res.send(pdfBuffer);
    } catch (err: unknown) {
      if (err instanceof ProjectOverviewNotFoundError) {
        return res.status(404).json({ message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Invoice package failed: ${message}` });
    }
  },
);

router.patch(
  "/api/invoices/:id",
  validateRequest({ params: idParams, body: updateInvoiceSchema }),
  async (req, res) => {
    const invoiceId = Number(req.params.id);
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, invoiceId))
        .for("update");
      if (!existing) return { outcome: "not_found" as const };

      if (changesApplicationProtectedInvoiceField(req.body)) {
        const [application] = await tx
          .select({ id: invoiceAcompteApplications.id })
          .from(invoiceAcompteApplications)
          .where(eq(invoiceAcompteApplications.invoiceId, invoiceId))
          .limit(1);
        if (application) return { outcome: "immutable" as const };
      }

      const [invoice] = await tx
        .update(invoicesTable)
        .set(req.body)
        .where(eq(invoicesTable.id, invoiceId))
        .returning();
      return { outcome: "updated" as const, invoice };
    });
    if (result.outcome === "not_found") return res.status(404).json({ message: "Invoice not found" });
    if (result.outcome === "immutable") return immutableApplicationResponse(res);
    const invoice = result.invoice;
    await storage.revokeDevisCheckTokenIfFullyInvoiced(invoice.devisId);
    res.json(invoice);
  },
);

// Task #346 — reopen a confirmed (pending, not yet approved) invoice for
// another review round. Eligibility + pending→draft transition live in the
// service; approved invoices are refused (commission already calculated).
router.post(
  "/api/invoices/:id/reopen",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const reopenedBy = req.session?.userId ? String(req.session.userId) : null;
      const result = await reopenInvoiceDraft(Number(req.params.id), reopenedBy);
      res.status(result.status).json(result.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Invoice Reopen] Error:", message);
      res.status(500).json({ message: `Reopen failed: ${message}` });
    }
  },
);

router.post(
  "/api/invoices/:id/approve",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const result = await approveInvoice(Number(req.params.id));
      res.status(result.status).json(result.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Invoice Approve] Error:", message);
      res.status(500).json({ message: `Approval failed: ${message}` });
    }
  },
);

router.post(
  "/api/invoices/:id/confirm",
  validateRequest({ params: idParams, body: invoiceConfirmSchema }),
  async (req, res) => {
    try {
      const invoiceId = Number(req.params.id);
      const corrections = req.body;
      const preparation = await db.transaction(async (tx) => {
        // The application service takes this same row lock before creating its
        // snapshot. This serialises corrections against application creation:
        // either the correction lands first and is snapshotted, or the
        // application lands first and the correction is refused.
        const [invoice] = await tx
          .select()
          .from(invoicesTable)
          .where(eq(invoicesTable.id, invoiceId))
          .for("update");
        if (!invoice) return { outcome: "not_found" as const };
        if (invoice.status !== "draft") return { outcome: "not_draft" as const };

        if (changesApplicationProtectedInvoiceField(corrections)) {
          const [application] = await tx
            .select({ id: invoiceAcompteApplications.id })
            .from(invoiceAcompteApplications)
            .where(eq(invoiceAcompteApplications.invoiceId, invoice.id))
            .limit(1);
          if (application) return { outcome: "immutable" as const };
        }

        const updates: Record<string, unknown> = {};
        const finalHt = corrections.amountHt != null
          ? roundCurrency(corrections.amountHt)
          : roundCurrency(Number(invoice.amountHt));
        const finalTtc = corrections.amountTtc != null
          ? roundCurrency(corrections.amountTtc)
          : roundCurrency(Number(invoice.amountTtc));

        if (corrections.amountHt != null) updates.amountHt = String(finalHt);
        if (corrections.amountTtc != null) updates.amountTtc = String(finalTtc);
        if (corrections.amountHt != null || corrections.amountTtc != null) {
          updates.tvaAmount = String(deriveTvaAmount(finalHt, finalTtc));
        }
        if (corrections.invoiceNumber != null) updates.invoiceNumber = corrections.invoiceNumber;
        if (corrections.dateIssued != null) updates.dateIssued = corrections.dateIssued;

        // Revalidate the stored document on every confirm, including an empty
        // corrections body. AI output remains evidence; final invoice values
        // are authoritative.
        const aiData = (invoice.aiExtractedData as Record<string, unknown> | null) ?? {};
        const canonicalParsed = {
          ...aiData,
          amountHt: finalHt,
          amountTtc: finalTtc,
          tvaAmount: deriveTvaAmount(finalHt, finalTtc),
          invoiceNumber: corrections.invoiceNumber ?? invoice.invoiceNumber,
          date: corrections.dateIssued ?? invoice.dateIssued ?? undefined,
        } as ParsedDocument;
        const revalidation = validateExtraction(canonicalParsed);
        const warnings: ValidationWarning[] = revalidation.warnings;
        updates.validationWarnings = warnings;
        updates.aiConfidence = revalidation.confidenceScore;

        const [revalidated] = await tx
          .update(invoicesTable)
          .set(updates as Partial<typeof invoicesTable.$inferInsert>)
          .where(eq(invoicesTable.id, invoice.id))
          .returning();
        return { outcome: "prepared" as const, invoice: revalidated, warnings };
      });

      if (preparation.outcome === "not_found") {
        return res.status(404).json({ message: "Invoice not found" });
      }
      if (preparation.outcome === "not_draft") {
        return res.status(400).json({ message: "Only draft invoices can be confirmed" });
      }
      if (preparation.outcome === "immutable") return immutableApplicationResponse(res);

      const { invoice: revalidated, warnings: nextWarnings } = preparation;
      try {
        await reconcileAdvisories({ invoiceId }, nextWarnings);
      } catch (advErr) {
        const message = advErr instanceof Error ? advErr.message : String(advErr);
        console.error("[Invoice Confirm] Advisory reconciliation failed:", message);
        return res.status(503).json({
          code: "invoice_advisory_reconciliation_failed",
          message: "Invoice validation was saved, but its review advisories could not be reconciled. The invoice remains a draft; retry confirmation.",
          reviewRequired: true,
          invoice: revalidated,
        });
      }

      const blockingWarnings = nextWarnings.filter((warning) => warning.severity === "error");
      if (blockingWarnings.length > 0) {
        return res.status(422).json({
          code: "invoice_validation_failed",
          message: "Invoice validation found blocking errors. Review or correct them before confirming.",
          reviewRequired: true,
          warnings: blockingWarnings,
          invoice: revalidated,
        });
      }

      const preparedProtectedSnapshot = invoiceAcompteProtectedSnapshot(revalidated);
      const acompteApplication = await applyInvoiceAcompteDeduction(
        revalidated.id,
        preparedProtectedSnapshot,
      );
      if (acompteApplication.outcome === "needs_review") {
        return res.status(409).json({
          code: acompteApplication.code,
          message: acompteApplication.message,
          reviewRequired: true,
          invoice: revalidated,
        });
      }

      // Advisory reconciliation and acompte application happen outside the
      // preparation transaction. Re-lock and compare the exact protected facts
      // before draft→pending so a concurrent edit cannot confirm stale input.
      const pendingTransition = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(invoicesTable)
          .where(eq(invoicesTable.id, revalidated.id))
          .for("update");
        if (!current) return { outcome: "not_found" as const };
        if (current.status !== "draft") return { outcome: "changed" as const };
        if (
          JSON.stringify(invoiceAcompteProtectedSnapshot(current))
          !== JSON.stringify(preparedProtectedSnapshot)
        ) {
          return { outcome: "changed" as const };
        }
        const [invoice] = await tx
          .update(invoicesTable)
          .set({ status: "pending" })
          .where(eq(invoicesTable.id, current.id))
          .returning();
        return { outcome: "updated" as const, invoice };
      });
      if (pendingTransition.outcome !== "updated") {
        return res.status(409).json({
          code: "invoice_confirmation_input_changed",
          message: "The invoice changed while confirmation was in progress. Review it and confirm again.",
          reviewRequired: true,
        });
      }
      const updated = pendingTransition.invoice;
      if (updated) await storage.revokeDevisCheckTokenIfFullyInvoiced(updated.devisId);
      res.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Confirm failed: ${message}` });
    }
  },
);

router.delete(
  "/api/invoices/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const invoiceId = Number(req.params.id);
      const deletion = await db.transaction(async (tx) => {
        const [invoice] = await tx
          .select()
          .from(invoicesTable)
          .where(eq(invoicesTable.id, invoiceId))
          .for("update");
        if (!invoice) return { outcome: "not_found" as const };
        if (invoice.status !== "draft") return { outcome: "not_draft" as const };

        const [application] = await tx
          .select({ id: invoiceAcompteApplications.id })
          .from(invoiceAcompteApplications)
          .where(eq(invoiceAcompteApplications.invoiceId, invoice.id))
          .limit(1);
        if (application) return { outcome: "immutable" as const };

        await tx.delete(invoicesTable).where(eq(invoicesTable.id, invoice.id));
        return { outcome: "deleted" as const, devisId: invoice.devisId };
      });
      if (deletion.outcome === "not_found") return res.status(404).json({ message: "Invoice not found" });
      if (deletion.outcome === "not_draft") {
        return res.status(400).json({ message: "Only draft invoices can be deleted" });
      }
      if (deletion.outcome === "immutable") return immutableApplicationResponse(res);
      // A delete can only DECREASE the invoiced total, so no token can flip
      // from active-and-not-yet-fully-invoiced to fully-invoiced as a result.
      // We still call the revoke helper for symmetry: it's a single SQL
      // no-op when the predicate doesn't hold.
      await storage.revokeDevisCheckTokenIfFullyInvoiced(deletion.devisId);
      res.json({ message: "Invoice deleted" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Delete failed: ${message}` });
    }
  },
);

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

router.post(
  "/api/invoices/:id/advisories/:advisoryId/acknowledge",
  requireAuth,
  validateRequest({ params: advisoryAckParams }),
  async (req, res) => {
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
  },
);

export default router;
