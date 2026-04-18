import { storage } from "../storage";
import { uploadDocument } from "../storage/object-storage";
import { validateExtraction } from "./extraction-validator";
import { calculateTtc, roundCurrency } from "../../shared/financial-utils";
import { reconcileAdvisories } from "./advisory-reconciler";
import { assertPdfMagic } from "../middleware/upload";

interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

export async function processDevisUpload(projectId: number, file: UploadedFile) {
  assertPdfMagic(file.buffer);
  const storageKey = await uploadDocument(projectId, file.originalname, file.buffer, file.mimetype);

  await storage.createProjectDocument({
    projectId,
    fileName: file.originalname,
    storageKey,
    documentType: "quotation",
    uploadedBy: "manual",
    description: `Devis PDF upload: ${file.originalname}`,
  });

  const { parseDocument, matchToProject } = await import("../gmail/document-parser");
  const parsed = await parseDocument(file.buffer, file.originalname);

  if (parsed.documentType === "unknown" && !parsed.amountHt && !parsed.contractorName && !parsed.lineItems?.length) {
    return {
      success: false,
      status: 422,
      data: {
        message: "Could not extract meaningful data from this PDF. Please check the file is a valid quotation/devis.",
        extraction: parsed,
        storageKey,
        fileName: file.originalname,
      },
    };
  }

  const validation = validateExtraction(parsed);

  const corrected = { ...parsed, ...validation.correctedValues };

  const allProjects = await storage.getProjects({ includeArchived: true });
  const allContractors = await storage.getContractors();
  const match = await matchToProject(parsed, allProjects, allContractors);

  const contractorId = match.contractorId || (allContractors.length > 0 ? allContractors[0].id : null);
  if (!contractorId) {
    return {
      success: false,
      status: 422,
      data: {
        message: "No contractors exist in the database. Please sync from ArchiDoc first before uploading documents.",
        extraction: parsed,
        storageKey,
        fileName: file.originalname,
      },
    };
  }

  const tvaRate = corrected.tvaRate != null ? String(roundCurrency(corrected.tvaRate)) : "20.00";
  const amountHt = corrected.amountHt != null ? String(roundCurrency(corrected.amountHt)) : "0.00";
  const numericTvaRate = corrected.tvaRate != null ? corrected.tvaRate : 20;
  const amountTtc = corrected.amountTtc != null
    ? String(roundCurrency(corrected.amountTtc))
    : (corrected.amountHt != null ? String(calculateTtc(corrected.amountHt, numericTvaRate)) : "0.00");

  const devisRecord = await storage.createDevis({
    projectId,
    contractorId,
    lotId: null,
    marcheId: null,
    devisCode: parsed.reference || file.originalname.replace(/\.pdf$/i, ""),
    devisNumber: parsed.devisNumber || parsed.reference || null,
    ref2: null,
    descriptionFr: parsed.description || parsed.contractorName || file.originalname,
    descriptionUk: null,
    amountHt,
    tvaRate,
    amountTtc,
    invoicingMode: (parsed.lineItems && parsed.lineItems.length > 0) ? "mode_b" : "mode_a",
    status: "draft",
    dateSent: parsed.date || null,
    dateSigned: null,
    pvmvRef: null,
    pdfStorageKey: storageKey,
    pdfFileName: file.originalname,
    validationWarnings: validation.warnings,
    aiExtractedData: parsed,
    aiConfidence: validation.confidenceScore,
  });

  try {
    await reconcileAdvisories({ devisId: devisRecord.id }, validation.warnings, "extractor");
  } catch (advErr) {
    console.warn(`[Devis Upload] Failed to persist advisories:`, advErr);
  }

  let lineItemsCreated = 0;
  if (parsed.lineItems && parsed.lineItems.length > 0) {
    for (let i = 0; i < parsed.lineItems.length; i++) {
      const li = parsed.lineItems[i];
      try {
        await storage.createDevisLineItem({
          devisId: devisRecord.id,
          lineNumber: i + 1,
          description: li.description || `Line ${i + 1}`,
          quantity: String(li.quantity ?? 1),
          unit: "u",
          unitPriceHt: String(roundCurrency(li.unitPrice ?? 0)),
          totalHt: String(roundCurrency(li.total ?? 0)),
          percentComplete: "0",
        });
        lineItemsCreated++;
      } catch (lineErr) {
        console.warn(`[Devis Upload] Failed to create line item ${i + 1}:`, lineErr);
      }
    }
  }

  return {
    success: true,
    status: 201,
    data: {
      devis: devisRecord,
      extraction: {
        documentType: parsed.documentType,
        contractorName: parsed.contractorName,
        matchConfidence: match.confidence,
        matchedFields: match.matchedFields,
        lineItemsExtracted: parsed.lineItems?.length ?? 0,
        lineItemsCreated,
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
