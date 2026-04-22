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
  // could disagree with stored HT/TTC. If only one of HT / TTC is present
  // we default the missing side to the known value (effective 0% TVA) so
  // the draft is never auto-grossed-up; the user fixes it from the confirm UI.
  const htNum = effectiveHt != null
    ? roundCurrency(effectiveHt)
    : (effectiveTtc != null ? roundCurrency(effectiveTtc) : 0);
  const ttcNum = effectiveTtc != null
    ? roundCurrency(effectiveTtc)
    : (effectiveHt != null ? roundCurrency(effectiveHt) : 0);

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
