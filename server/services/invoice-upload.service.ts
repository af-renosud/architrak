import { storage } from "../storage";
import { uploadDocument } from "../storage/object-storage";
import { validateExtraction } from "./extraction-validator";
import { roundCurrency, calculateTtc, calculateTva } from "../../shared/financial-utils";
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
  const effectiveTvaAmount = validation.correctedValues.tvaAmount ?? parsed.tvaAmount;

  const tvaRate = parsed.tvaRate != null ? parsed.tvaRate : parseFloat(devis.tvaRate) || 20;

  const amountHt = effectiveHt != null
    ? String(roundCurrency(effectiveHt))
    : "0.00";

  const amountTtc = effectiveTtc != null
    ? String(roundCurrency(effectiveTtc))
    : (effectiveHt != null ? String(calculateTtc(effectiveHt, tvaRate)) : "0.00");

  const tvaAmount = effectiveTvaAmount != null
    ? String(roundCurrency(effectiveTvaAmount))
    : (effectiveHt != null ? String(calculateTva(effectiveHt, tvaRate)) : "0.00");

  const invoice = await storage.createInvoice({
    devisId,
    projectId: devis.projectId,
    contractorId: devis.contractorId,
    invoiceNumber: parsed.invoiceNumber || parsed.reference || file.originalname.replace(/\.pdf$/i, ""),
    certificateNumber: null,
    amountHt,
    tvaRate: String(roundCurrency(tvaRate)),
    tvaAmount,
    amountTtc,
    status: "draft",
    dateIssued: parsed.date || null,
    datePaid: null,
    pdfPath: storageKey,
    notes: null,
    validationWarnings: validation.warnings,
    aiExtractedData: parsed,
    aiConfidence: validation.confidenceScore,
  });

  try {
    await reconcileAdvisories({ invoiceId: invoice.id }, validation.warnings, "extractor");
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
        isValid: validation.isValid,
        warnings: validation.warnings,
        confidenceScore: validation.confidenceScore,
        correctedValues: validation.correctedValues,
      },
      storageKey,
      fileName: file.originalname,
    },
  };
}
