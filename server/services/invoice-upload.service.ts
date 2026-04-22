import { storage } from "../storage";
import { uploadDocument } from "../storage/object-storage";
import { validateExtraction } from "./extraction-validator";
import { roundCurrency, deriveTvaAmount } from "../../shared/financial-utils";
import { reconcileAdvisories } from "./advisory-reconciler";
import { assertPdfMagic } from "../middleware/upload";

interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

export async function processInvoiceUpload(devisId: number, file: UploadedFile) {
  assertPdfMagic(file.buffer);
  const devis = await storage.getDevis(devisId);
  if (!devis) {
    return { success: false, status: 404, data: { message: "Devis not found" } };
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
