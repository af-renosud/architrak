import { storage } from "../storage";
import { uploadDocument } from "../storage/object-storage";
import { validateExtraction } from "./extraction-validator";
import { roundCurrency, deriveTvaAmount } from "../../shared/financial-utils";
import { reconcileAdvisories } from "./advisory-reconciler";
import { enqueueDriveUpload } from "./drive/upload-queue.service";
import { assertPdfMagic } from "../middleware/upload";
import { INVOICE_UPLOAD_ERROR_CODES } from "../../shared/invoice-upload-errors";
import { evaluateAcompteGate, gateInputsFromDevis, nextAcompteState } from "./acompte.service";

interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

export async function processInvoiceUpload(devisId: number, file: UploadedFile) {
  assertPdfMagic(file.buffer);
  const devis = await storage.getDevis(devisId);
  if (!devis) {
    return {
      success: false,
      status: 404,
      data: { message: "Devis not found", code: INVOICE_UPLOAD_ERROR_CODES.INVOICE_DEVIS_NOT_FOUND },
    };
  }

  const storageKey = await uploadDocument(devis.projectId, file.originalname, file.buffer, file.mimetype);

  await storage.createProjectDocument({
    projectId: devis.projectId,
    fileName: file.originalname,
    storageKey,
    documentType: "invoice",
    uploadedBy: "manual",
    description: `Invoice PDF upload for devis ${devis.devisCode}: ${file.originalname}`,
  });

  const { parseDocument } = await import("../gmail/document-parser");
  const parsed = await parseDocument(file.buffer, file.originalname);

  // Task #215 — apply the acompte gate to manual facture uploads.
  // The deposit invoice itself (documentType="acompte") is exempt
  // so linking the facture d'acompte never deadlocks against its
  // own gate. This mirrors the gate applied at POST
  // /api/devis/:devisId/invoices and /situations.
  const isAcompteInvoice = parsed.documentType === "acompte";
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

  const validation = validateExtraction(parsed);

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
  const invoice = await storage.createInvoice({
    devisId,
    projectId: devis.projectId,
    contractorId: devis.contractorId,
    invoiceNumber: parsed.invoiceNumber || parsed.reference || file.originalname.replace(/\.pdf$/i, ""),
    certificateNumber: null,
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
  });

  try {
    await reconcileAdvisories({ invoiceId: invoice.id }, enrichedWarnings, "extractor");
  } catch (advErr) {
    console.warn(`[Invoice Upload] Failed to persist advisories:`, advErr);
  }

  // Task #215 — when the upload IS the facture d'acompte and the
  // devis is awaiting one, auto-link it and advance the lifecycle.
  // We do this best-effort: if the transition is no longer legal
  // (e.g. another link already happened), silently skip — the
  // operator can still link/mark-paid manually via the dedicated
  // routes.
  if (isAcompteInvoice && devis.acompteRequired && (devis.acompteState === "pending" || devis.acompteState === "invoiced")) {
    const target = nextAcompteState(devis.acompteState, "link_invoice");
    if (target) {
      try {
        await storage.updateDevis(devisId, {
          acompteInvoiceId: invoice.id,
          acompteState: target,
        });
      } catch (linkErr) {
        console.warn(`[Invoice Upload] Acompte auto-link failed for devis ${devisId}:`, linkErr);
      }
    }
  }

  // Task #198 — push the invoice PDF into the same per-lot Drive
  // folder as the devis it's invoicing. Idempotent + no-op when the
  // feature flag is off.
  void enqueueDriveUpload({
    docKind: "invoice",
    docId: invoice.id,
    projectId: invoice.projectId,
    lotId: devis.lotId ?? null,
    sourceStorageKey: storageKey,
    displayName: `${invoice.invoiceNumber || `invoice-${invoice.id}`}.pdf`,
    // Folder name is `{Lot} {project} {devisCode}` — use the parent
    // devis code so the lot folder gets the canonical name even when
    // an invoice lands before any devis has triggered the create.
    seedDevisCode: devis.devisCode,
  });

  // Lifecycle-bound auto-revoke: a freshly-uploaded invoice can push the
  // devis to fully-invoiced. Cheap no-op otherwise.
  await storage.revokeDevisCheckTokenIfFullyInvoiced(devisId);

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
