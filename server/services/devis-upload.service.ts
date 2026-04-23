import { storage } from "../storage";
import { uploadDocument } from "../storage/object-storage";
import { validateExtraction } from "./extraction-validator";
import { checkLotReferencesAgainstCatalog } from "./lot-reference-validator";
import { roundCurrency } from "../../shared/financial-utils";
import { reconcileAdvisories } from "./advisory-reconciler";
import { assertPdfMagic } from "../middleware/upload";
import { triggerDevisTranslation } from "./devis-translation";
import { toSentenceCase } from "../lib/sentence-case";

interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

/**
 * Coerce the AI-emitted bbox into a trustworthy normalized rectangle, or
 * null if the input is missing/garbage. See callsite in processDevisUpload
 * for the validation policy (Task #113).
 *
 * Exported for the unit test in devis-upload-page-hint.test.ts which now
 * also covers the bbox path.
 */
export function coerceBbox(raw: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x = r.x;
  const y = r.y;
  const w = r.w;
  const h = r.h;
  if (
    typeof x !== "number" || !Number.isFinite(x) ||
    typeof y !== "number" || !Number.isFinite(y) ||
    typeof w !== "number" || !Number.isFinite(w) ||
    typeof h !== "number" || !Number.isFinite(h)
  ) {
    return null;
  }
  // Reject negatives, zero-area boxes, and rectangles that escape the page.
  // A small epsilon tolerates the AI rounding to e.g. 1.0001.
  const EPS = 0.005;
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return null;
  if (x > 1 + EPS || y > 1 + EPS || x + w > 1 + EPS || y + h > 1 + EPS) return null;
  // Clamp the (possibly slightly-overflowing) values back into [0, 1] so
  // the persisted shape is always a strict in-page rectangle.
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const cx = clamp(x);
  const cy = clamp(y);
  const cw = clamp(Math.min(w, 1 - cx));
  const ch = clamp(Math.min(h, 1 - cy));
  if (cw <= 0 || ch <= 0) return null;
  return { x: cx, y: cy, w: cw, h: ch };
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

  const { parseDocument, matchToProject, isTransientParseFailure, getParseFailureMessage } = await import("../gmail/document-parser");
  const parsed = await parseDocument(file.buffer, file.originalname);

  if (parsed.documentType === "unknown" && !parsed.amountHt && !parsed.contractorName && !parsed.lineItems?.length) {
    const transient = isTransientParseFailure(parsed);
    const reason = getParseFailureMessage(parsed);
    const message = transient
      ? `AI extraction temporarily unavailable${reason ? ` (${reason})` : ""}. Please try again in a moment.`
      : reason
        ? `AI extraction failed: ${reason}`
        : "Could not extract meaningful data from this PDF. Please check the file is a valid quotation/devis.";
    return {
      success: false,
      status: transient ? 503 : 422,
      data: {
        message,
        extraction: parsed,
        storageKey,
        fileName: file.originalname,
      },
    };
  }

  const validation = validateExtraction(parsed);
  const lotWarnings = await checkLotReferencesAgainstCatalog(parsed);

  const corrected = { ...parsed, ...validation.correctedValues };

  const allProjects = await storage.getProjects({ includeArchived: true });
  const allContractors = await storage.getContractors();
  const match = await matchToProject(parsed, allProjects, allContractors);

  const allWarnings = [...validation.warnings, ...lotWarnings, ...match.warnings];

  // Hard requirement: never silently auto-assign an arbitrary contractor.
  // Either matchToProject identified one (by SIRET/SIREN or strict name) or
  // the upload is rejected and the user is asked to fix the contractor first.
  // Auto-picking allContractors[0] here was the bug that let AT TRAVAUX devis
  // get filed under AT PISCINES when AI matching failed.
  const contractorId = match.contractorId;
  if (!contractorId) {
    if (allContractors.length === 0) {
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
    const unknownSiretAdvisory = match.warnings.find((w) => w.field === "unknown_contractor");
    const message = unknownSiretAdvisory
      ? `${unknownSiretAdvisory.message} Once the contractor exists in ArchiTrak, re-upload the devis.`
      : `AI extraction could not confidently identify the contractor for this document${parsed.contractorName ? ` (extracted name: "${parsed.contractorName}")` : ""}. Please verify the contractor exists in ArchiTrak (sync from ArchiDoc if needed), then re-upload, or create the devis manually.`;
    return {
      success: false,
      status: 422,
      data: {
        message,
        extraction: parsed,
        validation: {
          isValid: false,
          warnings: allWarnings,
          confidenceScore: validation.confidenceScore,
          correctedValues: validation.correctedValues,
        },
        matchedFields: match.matchedFields,
        storageKey,
        fileName: file.originalname,
      },
    };
  }

  // TVA-neutral: store HT + TTC as extracted. If only one side is present we
  // default the missing one to the available value (effective 0% TVA); the
  // user is expected to correct it via the draft confirm flow if needed.
  const amountHt = corrected.amountHt != null
    ? String(roundCurrency(corrected.amountHt))
    : (corrected.amountTtc != null ? String(roundCurrency(corrected.amountTtc)) : "0.00");
  const amountTtc = corrected.amountTtc != null
    ? String(roundCurrency(corrected.amountTtc))
    : (corrected.amountHt != null ? String(roundCurrency(corrected.amountHt)) : "0.00");

  // Lot assignment is intentionally NOT derived from extraction. The AI may
  // suggest catalog codes via parsed.lotReferences, but lots can only be
  // attached via the assign-from-catalog flow (see /api/projects/:projectId/
  // lots/assign-from-catalog). This guarantees the extractor can never
  // create or mutate project lots / lot descriptions.
  const devisRecord = await storage.createDevis({
    projectId,
    contractorId,
    lotId: null,
    marcheId: null,
    devisCode: parsed.reference || file.originalname.replace(/\.pdf$/i, ""),
    devisNumber: parsed.devisNumber || parsed.reference || null,
    ref2: null,
    descriptionFr: toSentenceCase(parsed.description || parsed.contractorName || file.originalname) as string,
    descriptionUk: null,
    amountHt,
    amountTtc,
    invoicingMode: (parsed.lineItems && parsed.lineItems.length > 0) ? "mode_b" : "mode_a",
    status: "draft",
    dateSent: parsed.date || null,
    dateSigned: null,
    pvmvRef: null,
    pdfStorageKey: storageKey,
    pdfFileName: file.originalname,
    validationWarnings: allWarnings,
    aiExtractedData: parsed,
    aiConfidence: validation.confidenceScore,
  });

  try {
    await reconcileAdvisories({ devisId: devisRecord.id }, allWarnings, "extractor");
  } catch (advErr) {
    console.warn(`[Devis Upload] Failed to persist advisories:`, advErr);
  }

  let lineItemsCreated = 0;
  if (parsed.lineItems && parsed.lineItems.length > 0) {
    for (let i = 0; i < parsed.lineItems.length; i++) {
      const li = parsed.lineItems[i];
      // Page hint is best-effort — the AI is asked to emit it but may omit
      // or hallucinate. Coerce to a strict positive integer or null so the
      // portal click-to-jump (Task #111) only fires on trustworthy values.
      const rawPageHint: unknown = li.pageHint;
      const pdfPageHint =
        typeof rawPageHint === "number" && Number.isFinite(rawPageHint) && rawPageHint >= 1
          ? Math.floor(rawPageHint)
          : null;
      // Bounding box is best-effort too (Task #113) — the AI may emit
      // garbage, partial, or off-page rectangles. We only persist a bbox if
      // (a) every coordinate is a finite number, (b) all are within [0, 1],
      // (c) the rectangle has positive area, and (d) it stays inside the
      // page (x + w <= 1 and y + h <= 1 within a small tolerance). Anything
      // else degrades to null so the portal falls back to page-level scroll
      // rather than drawing a broken highlight.
      const pdfBbox = coerceBbox(li.bbox);
      try {
        await storage.createDevisLineItem({
          devisId: devisRecord.id,
          lineNumber: i + 1,
          description: toSentenceCase(li.description || `Line ${i + 1}`) as string,
          quantity: String(li.quantity ?? 1),
          unit: "u",
          unitPriceHt: String(roundCurrency(li.unitPrice ?? 0)),
          totalHt: String(roundCurrency(li.total ?? 0)),
          percentComplete: "0",
          pdfPageHint,
          pdfBbox,
        });
        lineItemsCreated++;
      } catch (lineErr) {
        console.warn(`[Devis Upload] Failed to create line item ${i + 1}:`, lineErr);
      }
    }
  }

  triggerDevisTranslation(devisRecord.id);

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
        warnings: allWarnings,
        confidenceScore: validation.confidenceScore,
        correctedValues: validation.correctedValues,
      },
      storageKey,
      fileName: file.originalname,
    },
  };
}
