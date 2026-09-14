import {
  storage,
  INTAKE_INVOICE_ROUTE_ACOMPTE_GATE_BLOCKED,
} from "../storage";
import { uploadDocument } from "../storage/object-storage";
import { validateExtraction } from "./extraction-validator";
import { findBlockingCompletenessWarnings } from "./extraction-completeness";
import { roundCurrency, deriveTvaAmount } from "../../shared/financial-utils";
import { reconcileAdvisories } from "./advisory-reconciler";
import { enqueueDriveUpload } from "./drive/upload-queue.service";
import { assertPdfMagic } from "../middleware/upload";
import { INVOICE_UPLOAD_ERROR_CODES } from "../../shared/invoice-upload-errors";
import { evaluateAcompteGate, gateInputsFromDevis, linkAcompteInvoiceTx } from "./acompte.service";
import {
  applyInvoiceAcompteDeduction,
  reconcilePaidAcompteFromCertificatLedger,
} from "./invoice-acompte-application.service";
import { safeExtractIban, safeExtractBic } from "../../shared/iban";
import type { ValidatorWarningLike } from "@shared/advisory-codes";
import type { Invoice, ServerInsertInvoice } from "@shared/schema";
import type { ParsedDocument } from "../gmail/document-parser";

interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

type InvoiceFinancialCompletion =
  | { outcome: "complete" }
  | { outcome: "needs_review"; code: string; message: string }
  | { outcome: "retry"; message: string };

/**
 * Finish the financial work which is intentionally outside the source/invoice
 * persistence transaction. Keep this exported so recovery can replay precisely
 * this function from the durable source-keyed invoice after a process dies
 * between invoice persistence and financial completion.
 *
 * It is important that this does not manufacture payment evidence.  The
 * application service accepts only its ledger/audit proof and the acompte link
 * service reads the invoice's stored `datePaid` while holding the devis lock.
 */
export async function completeInvoiceFinancialEffects(
  invoice: Invoice,
  parsedDocumentType?: ParsedDocument["documentType"],
): Promise<InvoiceFinancialCompletion> {
  // Prefer the persisted extraction on replay.  A retry must not reinterpret a
  // source-bound invoice from a caller's newer/stale parse result.
  const storedDocumentType = (invoice.aiExtractedData as { documentType?: unknown } | null)?.documentType;
  const isAcompteInvoice = storedDocumentType === "acompte" || (
    storedDocumentType == null && parsedDocumentType === "acompte"
  );

  if (isAcompteInvoice) {
    const currentDevis = await storage.getDevis(invoice.devisId);
    if (!currentDevis) {
      return {
        outcome: "needs_review",
        code: "acompte_devis_not_found",
        message: "The opening-deposit invoice's devis no longer exists.",
      };
    }
    if (!currentDevis.acompteRequired) {
      // This is still a real supplier invoice, but it cannot advance a deposit
      // lifecycle which the architect did not configure.
      return { outcome: "complete" };
    }
    if (
      currentDevis.acompteInvoiceId === invoice.id
      && ["invoiced", "paid", "applied"].includes(currentDevis.acompteState)
    ) {
      return { outcome: "complete" };
    }

    try {
      const linked = await linkAcompteInvoiceTx({
        devisId: invoice.devisId,
        invoiceId: invoice.id,
      });
      if (linked.ok) return { outcome: "complete" };
      if (linked.code === "acompte_invalid_transition"
        && currentDevis.acompteInvoiceId === invoice.id
        && ["invoiced", "paid", "applied"].includes(currentDevis.acompteState)) {
        // Another replay completed the same lifecycle while this call waited.
        return { outcome: "complete" };
      }
      return {
        outcome: "needs_review",
        code: linked.code,
        message: linked.code === "acompte_certificat_exists"
          ? `An opening certificat (${linked.certificateRef}) already covers this deposit; do not link a second deposit path.`
          : "The opening-deposit invoice could not be linked to the current devis lifecycle.",
      };
    } catch (error) {
      return {
        outcome: "retry",
        message: `The opening-deposit lifecycle could not be completed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  try {
    // The initial upload gate is deliberately early (before object storage),
    // but its result can be stale by the time this persisted invoice is being
    // finalized. Re-check from the current devis before completing a source
    // route, so a newly-blocking pending/invoiced deposit is never bypassed.
    const currentDevis = await storage.getDevis(invoice.devisId);
    if (
      !currentDevis
      || currentDevis.projectId !== invoice.projectId
      || currentDevis.contractorId !== invoice.contractorId
    ) {
      return {
        outcome: "needs_review",
        code: "acompte_invoice_identity_mismatch",
        message: "The invoice no longer matches its devis, project, and contractor.",
      };
    }
    const currentGate = evaluateAcompteGate(gateInputsFromDevis(currentDevis));
    if (currentGate.blocked) {
      return {
        outcome: "needs_review",
        code: currentGate.code,
        message: currentGate.message,
      };
    }
    const application = await applyInvoiceAcompteDeduction(invoice.id);
    if (application.outcome === "needs_review") {
      return {
        outcome: "needs_review",
        code: application.code,
        message: application.message,
      };
    }
    return { outcome: "complete" };
  } catch (error) {
    return {
      outcome: "retry",
      message: `The opening-deposit deduction could not be completed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function processInvoiceUpload(
  devisId: number,
  file: UploadedFile,
  preParsed?: ParsedDocument,
  opts: {
    sourceIntakeDocumentId?: number;
    /** Verified in the invoice/source transaction for stored recovery only. */
    relationshipGuard?: {
      sourceContentFingerprint: string;
      contractorId: number;
      expectedDevisId: number;
      expectedResolutionKey: string;
      intakeNote: string;
      sourceAnalysisState?: "analyzing" | "analyzed";
      sourceRoutingState?: "unrouted" | "parked";
    };
  } = {},
) {
  assertPdfMagic(file.buffer);
  let devis = await storage.getDevis(devisId);
  if (!devis) {
    return {
      success: false,
      status: 404,
      data: { message: "Devis not found", code: INVOICE_UPLOAD_ERROR_CODES.INVOICE_DEVIS_NOT_FOUND },
    };
  }

  // Task #215 — parse FIRST so we can apply the acompte gate before
  // touching object storage. This avoids leaving an orphaned PDF +
  // project_documents row when the upload is rejected by the gate.
  // The facture d'acompte itself is exempt so linking it never
  // deadlocks against its own gate.
  // Task #230 — background ingest hands a pre-parsed result down so we
  // never re-run Gemini for the same buffer.
  const { parseDocument } = await import("../gmail/document-parser");
  const parsed = preParsed ?? await parseDocument(file.buffer, file.originalname);

  const isAcompteInvoice = parsed.documentType === "acompte";
  if (!isAcompteInvoice && devis.acompteState === "pending") {
    await reconcilePaidAcompteFromCertificatLedger(devis.id);
    devis = await storage.getDevis(devisId) ?? devis;
  }
  const gateDecision = evaluateAcompteGate(gateInputsFromDevis(devis), { isAcompteInvoice });
  if (gateDecision.blocked) {
    return {
      success: false,
      status: 409,
      data: {
        message: gateDecision.message,
        code: gateDecision.code,
        acompteState: gateDecision.state,
      },
    };
  }

  // Task #350 — extraction completeness hard gate, applied BEFORE object
  // storage so no orphaned PDF/document row is left behind: an invoice must
  // never persist when pages were missing from the extraction or a
  // text-evidenced page produced no line items.
  const validation = validateExtraction(parsed);
  const blockingCompleteness = findBlockingCompletenessWarnings(validation.warnings);
  if (blockingCompleteness.length > 0) {
    return {
      success: false,
      status: 422,
      data: {
        message: `Extraction appears incomplete: ${blockingCompleteness.map((w) => w.message).join(" ")}`,
        code: INVOICE_UPLOAD_ERROR_CODES.EXTRACTION_INCOMPLETE,
        extraction: parsed,
      },
    };
  }

  const routeExistingGuardedSource = async (
    invoice: Invoice,
  ): Promise<InvoiceFinancialCompletion> => {
    if (opts.sourceIntakeDocumentId == null || !opts.relationshipGuard) {
      return { outcome: "complete" };
    }
    if (!invoice.pdfPath) {
      return {
        outcome: "retry",
        message: "The saved source invoice has no retained PDF path to reuse for source routing.",
      };
    }
    try {
      const replayInvoiceData: ServerInsertInvoice & { sourceIntakeDocumentId: number } = {
        devisId: invoice.devisId,
        projectId: invoice.projectId,
        sourceIntakeDocumentId: opts.sourceIntakeDocumentId,
        contractorId: invoice.contractorId,
        invoiceNumber: invoice.invoiceNumber,
        amountHt: invoice.amountHt,
        tvaAmount: invoice.tvaAmount,
        amountTtc: invoice.amountTtc,
        status: invoice.status,
        dateIssued: invoice.dateIssued,
        datePaid: invoice.datePaid,
        pdfPath: invoice.pdfPath,
        notes: invoice.notes,
        // These are database-originated JSON values. The storage boundary
        // intentionally exposes selected JSON as unknown, while the insert
        // schema retains Drizzle's Json type.
        validationWarnings: invoice.validationWarnings as ServerInsertInvoice["validationWarnings"],
        aiExtractedData: invoice.aiExtractedData as ServerInsertInvoice["aiExtractedData"],
        aiConfidence: invoice.aiConfidence,
        extractedIban: invoice.extractedIban,
        extractedBic: invoice.extractedBic,
      };
      const promoted = await storage.createIntakeInvoiceWithProjectDocument(replayInvoiceData, {
        projectId: invoice.projectId,
        fileName: file.originalname,
        // The source-keyed invoice and its document were committed together on
        // the initial write. A replay must reuse that object, never create a
        // timestamped replacement before discovering the source conflict.
        storageKey: invoice.pdfPath,
        documentType: "invoice",
        uploadedBy: "manual",
        description: `Invoice PDF upload for devis ${devis.devisCode}: ${file.originalname}`,
      }, opts.relationshipGuard, { routeSource: true });
      if (promoted.invoice.id !== invoice.id) {
        return {
          outcome: "needs_review",
          code: "invoice_source_identity_mismatch",
          message: "The guarded source is associated with a different invoice.",
        };
      }
      return { outcome: "complete" };
    } catch (error) {
      if (error instanceof Error && error.message === INTAKE_INVOICE_ROUTE_ACOMPTE_GATE_BLOCKED) {
        return {
          outcome: "needs_review",
          code: "acompte_unpaid",
          message: error.message,
        };
      }
      return {
        outcome: "retry",
        message: `The invoice was saved but source routing is still pending: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  // Every path after the invoice is durable — fresh upload, a source-key
  // replay, or an insert-conflict loser — must run this same idempotent tail.
  // For guarded intake, source routing is last: a crash/error before it leaves
  // the durable source-owned invoice unrouted so the normal retry can finish
  // financial work, advisory reconciliation, Drive queueing, and token
  // revocation without duplicating any of them.
  const finalizePersistedInvoice = async (
    invoice: Invoice,
    fallbackStorageKey: string | undefined,
    fallbackWarnings: ValidatorWarningLike[],
  ): Promise<InvoiceFinancialCompletion> => {
    let financialCompletion: InvoiceFinancialCompletion;
    try {
      financialCompletion = await completeInvoiceFinancialEffects(invoice, parsed.documentType);
    } catch (error) {
      return {
        outcome: "retry",
        message: `The invoice financial continuation could not be completed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // A transient financial failure must stop here so a later replay can
    // safely retry it first. A determinate review requirement, however, must
    // not skip the durable advisory/Drive/token tail for an already-saved
    // invoice; it only prevents the final source route below.
    if (financialCompletion.outcome === "retry") return financialCompletion;

    const persistedWarnings = Array.isArray(invoice.validationWarnings)
      ? invoice.validationWarnings as ValidatorWarningLike[]
      : fallbackWarnings;
    try {
      await reconcileAdvisories({ invoiceId: invoice.id }, persistedWarnings, "extractor");
    } catch (error) {
      return {
        outcome: "retry",
        message: `The invoice was saved but advisory reconciliation is pending: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const sourceStorageKey = invoice.pdfPath ?? fallbackStorageKey;
    if (!sourceStorageKey) {
      return {
        outcome: "retry",
        message: "The saved invoice has no PDF path for its required post-persistence effects.",
      };
    }
    try {
      await enqueueDriveUpload({
        docKind: "invoice",
        docId: invoice.id,
        projectId: invoice.projectId,
        lotId: devis.lotId ?? null,
        sourceStorageKey,
        displayName: `${invoice.invoiceNumber || `invoice-${invoice.id}`}.pdf`,
        seedDevisCode: devis.devisCode,
      });
      await storage.revokeDevisCheckTokenIfFullyInvoiced(invoice.devisId);
    } catch (error) {
      return {
        outcome: "retry",
        message: `The invoice was saved but required post-persistence effects are pending: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (financialCompletion.outcome === "needs_review") return financialCompletion;
    return routeExistingGuardedSource(invoice);
  };

  const finalizationFailure = (
    completion: Exclude<InvoiceFinancialCompletion, { outcome: "complete" }>,
    invoice: Invoice,
  ) => ({
    success: false as const,
    status: completion.outcome === "needs_review" ? 409 : 503,
    data: {
      message: completion.outcome === "needs_review"
        ? `Opening-deposit financial review required: ${completion.message}`
        : completion.message,
      code: completion.outcome === "needs_review"
        ? completion.code
        : "invoice_financial_continuation_pending",
      invoiceId: invoice.id,
    },
  });

  if (opts.sourceIntakeDocumentId != null) {
    const existing = await storage.getInvoiceBySourceIntakeDocumentId(opts.sourceIntakeDocumentId);
    if (existing) {
      // Do not treat the source-key uniqueness constraint as a relationship
      // proof. Reject a stale/corrupt owner before any upload, while the final
      // guarded transaction below repeats this validation under its locks.
      if (
        existing.sourceIntakeDocumentId !== opts.sourceIntakeDocumentId
        || existing.devisId !== devisId
        || existing.projectId !== devis.projectId
        || existing.contractorId !== devis.contractorId
        || (
          opts.relationshipGuard != null
          && (
            existing.devisId !== opts.relationshipGuard.expectedDevisId
            || existing.contractorId !== opts.relationshipGuard.contractorId
          )
        )
      ) {
        return {
          success: false,
          status: 409,
          data: {
            message: "The existing source invoice does not match the resolved devis, project, and contractor.",
            code: "invoice_source_identity_mismatch",
            invoiceId: existing.id,
          },
        };
      }
      const finalization = await finalizePersistedInvoice(existing, undefined, validation.warnings);
      if (finalization.outcome !== "complete") return finalizationFailure(finalization, existing);
      return {
        success: true,
        status: 200,
        data: { invoice: existing, extraction: parsed, storageKey: existing.pdfPath, fileName: file.originalname },
      };
    }
  }

  const storageKey = await uploadDocument(devis.projectId, file.originalname, file.buffer, file.mimetype);

  const effectiveHt = validation.correctedValues.amountHt ?? parsed.amountHt;
  const effectiveTtc = validation.correctedValues.amountTtc ?? parsed.amountTtc;

  // TVA-neutral: HT + TTC are the source of truth. tvaAmount is ALWAYS
  // derived as TTC − HT — we never persist an extracted tvaAmount that
  // could disagree with stored HT/TTC. If either HT or TTC is missing we
  // surface a draft warning so the user must complete the pair manually
  // in the confirm UI; we do NOT silently mirror or auto-gross-up.
  const enrichedWarnings = [...validation.warnings];
  if (effectiveHt == null || effectiveTtc == null) {
    enrichedWarnings.push({
      field: effectiveHt == null ? "amountHt" : "amountTtc",
      expected: "non-null",
      actual: undefined,
      message:
        "Both HT and TTC must be entered before confirming this invoice (TVA is derived as TTC − HT).",
      severity: "error",
    });
  }
  // If only one side is present, mirror it to the other so the persisted draft
  // satisfies the non-negative TVA constraint (derived TVA = 0). The error
  // warning above forces the user to enter the real value before confirming.
  const htRaw = effectiveHt ?? effectiveTtc ?? 0;
  const ttcRaw = effectiveTtc ?? effectiveHt ?? 0;
  const htNum = roundCurrency(htRaw);
  const ttcNum = roundCurrency(ttcRaw);

  const amountHt = String(htNum);
  const amountTtc = String(ttcNum);
  const tvaAmount = String(deriveTvaAmount(htNum, ttcNum));
  const created = opts.sourceIntakeDocumentId != null
    ? await storage.createIntakeInvoiceWithProjectDocument({
    devisId,
    projectId: devis.projectId,
    sourceIntakeDocumentId: opts.sourceIntakeDocumentId ?? null,
    contractorId: devis.contractorId,
    invoiceNumber: parsed.invoiceNumber || parsed.reference || file.originalname.replace(/\.pdf$/i, ""),
    amountHt,
    tvaAmount,
    amountTtc,
    status: "draft",
    dateIssued: parsed.date || null,
    datePaid: null,
    pdfPath: storageKey,
    notes: null,
    validationWarnings: enrichedWarnings,
    aiExtractedData: parsed,
    aiConfidence: validation.confidenceScore,
    // Task #225 — Anti-fraud banking capture (NULL when invalid/missing).
    extractedIban: safeExtractIban(parsed.iban),
    extractedBic: safeExtractBic(parsed.bic),
  }, {
    projectId: devis.projectId,
    fileName: file.originalname,
    storageKey,
    documentType: "invoice",
    uploadedBy: "manual",
    description: `Invoice PDF upload for devis ${devis.devisCode}: ${file.originalname}`,
  }, opts.relationshipGuard, { routeSource: false })
    : {
      invoice: await storage.createInvoice({
        devisId,
        projectId: devis.projectId,
        contractorId: devis.contractorId,
        invoiceNumber: parsed.invoiceNumber || parsed.reference || file.originalname.replace(/\.pdf$/i, ""),
        amountHt,
        tvaAmount,
        amountTtc,
        status: "draft",
        dateIssued: parsed.date || null,
        datePaid: null,
        pdfPath: storageKey,
        notes: null,
        validationWarnings: enrichedWarnings,
        aiExtractedData: parsed,
        aiConfidence: validation.confidenceScore,
        extractedIban: safeExtractIban(parsed.iban),
        extractedBic: safeExtractBic(parsed.bic),
      }),
      created: true,
    };
  const invoice = created.invoice;
  // The invoice/project-document pair is committed first, but a guarded intake
  // source is deliberately not marked routed until its financial continuation
  // below succeeds.  A crash therefore leaves a source-keyed invoice behind an
  // unrouted intake record which the existing lease/retry workers can replay;
  // it never leaves a completed-looking route with a pending acompte.
  // A concurrent loser receives the committed invoice+project-document winner.
  if (created.created && opts.sourceIntakeDocumentId == null) {
    await storage.createProjectDocument({
      projectId: devis.projectId,
      fileName: file.originalname,
      storageKey,
      documentType: "invoice",
      uploadedBy: "manual",
      description: `Invoice PDF upload for devis ${devis.devisCode}: ${file.originalname}`,
    });
  }

  const finalization = await finalizePersistedInvoice(
    invoice,
    created.created ? storageKey : undefined,
    enrichedWarnings,
  );
  if (finalization.outcome !== "complete") {
    if (opts.sourceIntakeDocumentId == null) {
      // A manual upload has no durable source key to make a browser retry
      // idempotent. The invoice/PDF is already committed at this point, so a
      // 409/503 would invite a duplicate upload. Keep the actual creation
      // successful and make the unfinished follow-up explicit instead; this
      // never claims the deposit was linked, paid, or approved.
      const manualReviewWarning = {
        field: "postPersistence",
        expected: "completed",
        actual: finalization.outcome,
        message: `Invoice saved, but follow-up review is required: ${finalization.message}`,
        severity: "error" as const,
      };
      const existingWarnings = Array.isArray(invoice.validationWarnings)
        ? invoice.validationWarnings as ValidatorWarningLike[]
        : enrichedWarnings;
      let persistedWarningMessage = finalization.message;
      try {
        // The response warning alone is not sufficient: both invoice upload
        // UIs refetch the draft after success, and approval must remain
        // blocked even after a page refresh. Persist this alongside the
        // extractor/AI validation warnings rather than inventing payment
        // evidence or claiming the failed continuation succeeded.
        await storage.updateInvoice(invoice.id, {
          validationWarnings: [...existingWarnings, manualReviewWarning],
          manualIntakeReviewRequired: true,
          manualIntakeReviewedAt: null,
          manualIntakeReviewedByUserId: null,
        });
      } catch (error) {
        persistedWarningMessage = `${finalization.message} The durable review marker could not be saved: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      const postPersistenceWarning = {
        code: finalization.outcome === "needs_review"
          ? finalization.code
          : "invoice_financial_continuation_pending",
        message: persistedWarningMessage,
        reviewRequired: true,
      };
      const manualWarnings = [...enrichedWarnings, manualReviewWarning];
      return {
        success: true,
        status: 201,
        data: {
          invoice,
          extraction: {
            documentType: parsed.documentType,
            contractorName: parsed.contractorName,
            amountHt: parsed.amountHt,
            amountTtc: parsed.amountTtc,
            reference: parsed.reference,
            date: parsed.date,
            confidence: parsed.amountHt != null ? "high" : "low",
          },
          validation: {
            isValid: false,
            warnings: manualWarnings,
            confidenceScore: validation.confidenceScore,
            correctedValues: validation.correctedValues,
          },
          postPersistenceWarning,
          storageKey,
          fileName: file.originalname,
        },
      };
    }
    return finalizationFailure(finalization, invoice);
  }

  if (!created.created) {
    return {
      success: true,
      status: 200,
      data: { invoice, extraction: parsed, storageKey: invoice.pdfPath, fileName: file.originalname },
    };
  }

  return {
    success: true,
    status: 201,
    data: {
      invoice,
      extraction: {
        documentType: parsed.documentType,
        contractorName: parsed.contractorName,
        amountHt: parsed.amountHt,
        amountTtc: parsed.amountTtc,
        reference: parsed.reference,
        date: parsed.date,
        confidence: parsed.amountHt != null ? "high" : "low",
      },
      validation: {
        isValid: !enrichedWarnings.some((w) => w.severity === "error"),
        warnings: enrichedWarnings,
        confidenceScore: validation.confidenceScore,
        correctedValues: validation.correctedValues,
      },
      storageKey,
      fileName: file.originalname,
    },
  };
}
