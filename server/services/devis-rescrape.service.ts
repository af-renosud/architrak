import { db } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";
import { getDocumentBuffer } from "../storage/object-storage";
import { validateExtraction } from "./extraction-validator";
import { checkLotReferencesAgainstCatalog } from "./lot-reference-validator";
import { roundCurrency } from "../../shared/financial-utils";
import { reconcileAdvisories } from "./advisory-reconciler";
import { triggerDevisTranslation } from "./devis-translation";
import { toSentenceCase } from "../lib/sentence-case";
import { coerceBbox } from "./devis-upload.service";
import {
  devis as devisTable,
  devisLineItems as devisLineItemsTable,
} from "@shared/schema";

export const RESCRAPE_ERROR_CODES = {
  DEVIS_NOT_FOUND: "DEVIS_NOT_FOUND",
  NO_PDF_ON_FILE: "NO_PDF_ON_FILE",
  PDF_DOWNLOAD_FAILED: "PDF_DOWNLOAD_FAILED",
  AI_TRANSIENT: "AI_TRANSIENT",
  PARSE_FAILED: "PARSE_FAILED",
  HAS_INVOICES: "DEVIS_HAS_INVOICES",
  HAS_SITUATIONS: "DEVIS_HAS_SITUATIONS",
  PDF_REPLACED_DURING_RESCRAPE: "PDF_REPLACED_DURING_RESCRAPE",
} as const;

interface RescrapeResult {
  success: boolean;
  status: number;
  data: Record<string, unknown>;
}

/**
 * Re-runs PDF extraction for an existing devis using its currently-stored
 * PDF in object storage. Used when the original extraction came back
 * partial (missing line items, wrong totals, etc.) and the user wants a
 * fresh pass without re-uploading the file.
 *
 * Conservative by design — refreshes ONLY the extraction-derived fields
 * (amounts, validation warnings, ai_extracted_data, ai_confidence,
 * date_sent if previously null, invoicing_mode if previously mode_a and
 * line items now appeared). Identity fields the user may have edited
 * (devisCode, devisNumber, descriptionFr, contractorId, projectId,
 * lotId, marcheId, status, ref2, pvmvRef) are LEFT UNTOUCHED.
 *
 * Hard preconditions (any of these returns 409):
 *   - The devis has invoices already (downstream financial state).
 *   - Any of its line items are referenced by situation_lines (would
 *     either FK-fail on delete or destroy progress-claim history).
 *
 * Atomicity: the row is locked with `SELECT … FOR UPDATE` and the
 * delete/recreate of line items + the devis update happen in a single
 * transaction that rolls back on any error — no partial state, no
 * duplicated line numbers under concurrent submits.
 */
export async function rescrapeDevis(devisId: number): Promise<RescrapeResult> {
  // ----- Phase 1: load + parse OUTSIDE the transaction. -----
  // The Gemini call can take several seconds; we don't want it holding a
  // row lock that long.
  const initial = await storage.getDevis(devisId);
  if (!initial) {
    return {
      success: false,
      status: 404,
      data: { message: "Devis not found", code: RESCRAPE_ERROR_CODES.DEVIS_NOT_FOUND },
    };
  }
  if (!initial.pdfStorageKey) {
    return {
      success: false,
      status: 422,
      data: {
        message: "This devis has no PDF on file to re-scrape.",
        code: RESCRAPE_ERROR_CODES.NO_PDF_ON_FILE,
      },
    };
  }

  let buffer: Buffer;
  try {
    buffer = await getDocumentBuffer(initial.pdfStorageKey);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      status: 500,
      data: {
        message: `Could not download the PDF from object storage: ${message}`,
        code: RESCRAPE_ERROR_CODES.PDF_DOWNLOAD_FAILED,
      },
    };
  }

  const fileName = initial.pdfFileName || `devis-${initial.devisCode}.pdf`;
  const { parseDocument, isTransientParseFailure, getParseFailureMessage } = await import(
    "../gmail/document-parser"
  );
  const parsed = await parseDocument(buffer, fileName);

  if (
    parsed.documentType === "unknown" &&
    !parsed.amountHt &&
    !parsed.contractorName &&
    !parsed.lineItems?.length
  ) {
    const transient = isTransientParseFailure(parsed);
    const reason = getParseFailureMessage(parsed);
    return {
      success: false,
      status: transient ? 503 : 422,
      data: {
        message: transient
          ? `AI extraction temporarily unavailable${reason ? ` (${reason})` : ""}. Please try again in a moment.`
          : reason
            ? `AI extraction failed: ${reason}`
            : "Could not extract meaningful data from this PDF on the second pass either.",
        code: transient ? RESCRAPE_ERROR_CODES.AI_TRANSIENT : RESCRAPE_ERROR_CODES.PARSE_FAILED,
        extraction: parsed,
      },
    };
  }

  const validation = validateExtraction(parsed);
  const lotWarnings = await checkLotReferencesAgainstCatalog(parsed);
  const corrected = { ...parsed, ...validation.correctedValues };
  const allWarnings = [...validation.warnings, ...lotWarnings];

  // ----- Phase 2: serialised mutation in a transaction. -----
  type TxResult =
    | { kind: "ok"; lineItemsCreated: number; lineItemsRemoved: number }
    | { kind: "blocked"; status: number; data: Record<string, unknown> };

  const txResult: TxResult = await db.transaction(async (tx) => {
    // Pessimistic lock on the devis row — serialises concurrent rescrape /
    // confirm / status mutations on the same devis.
    await tx.execute(sql`SELECT 1 FROM devis WHERE id = ${devisId} FOR UPDATE`);

    // Re-read the row INSIDE the lock so we react to anything that
    // changed between phase 1 and the lock acquisition.
    const lockedRows = await tx
      .select()
      .from(devisTable)
      .where(sql`${devisTable.id} = ${devisId}`);
    const locked = lockedRows[0];
    if (!locked) {
      return {
        kind: "blocked",
        status: 404,
        data: { message: "Devis not found", code: RESCRAPE_ERROR_CODES.DEVIS_NOT_FOUND },
      };
    }

    // Freshness guard: if the PDF was replaced (e.g. another user
    // re-uploaded a new file) between the phase-1 parse and lock
    // acquisition, our extraction now refers to the OLD PDF and would
    // commit stale data onto the new one. Reject so the user can retry.
    if (locked.pdfStorageKey !== initial.pdfStorageKey) {
      return {
        kind: "blocked",
        status: 409,
        data: {
          message:
            "The PDF for this devis was replaced while re-scraping. Please try again so the latest file is used.",
          code: RESCRAPE_ERROR_CODES.PDF_REPLACED_DURING_RESCRAPE,
        },
      };
    }

    // Precondition: refuse if invoices already exist for this devis. They
    // capture certified amounts that the user (and the architect)
    // expects to remain stable.
    const invCount = await tx.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM invoices WHERE devis_id = ${devisId}`,
    );
    const invRows = (invCount as unknown as { rows: { count: number }[] }).rows;
    if (invRows && invRows[0] && invRows[0].count > 0) {
      return {
        kind: "blocked",
        status: 409,
        data: {
          message:
            "This devis already has invoices attached, so its line items can't be re-scraped without losing certified history. Delete the invoices first if you really need a fresh extraction.",
          code: RESCRAPE_ERROR_CODES.HAS_INVOICES,
        },
      };
    }

    // Precondition: refuse if any of this devis's line items are
    // referenced by situation_lines. The FK on situation_lines.
    // devis_line_item_id has no ON DELETE action, so a wholesale delete
    // would either fail outright or — with cascading — destroy
    // progress-claim history. Either way, not safe to silently rerun.
    const sitCount = await tx.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count
            FROM situation_lines sl
            JOIN devis_line_items dli ON dli.id = sl.devis_line_item_id
           WHERE dli.devis_id = ${devisId}`,
    );
    const sitRows = (sitCount as unknown as { rows: { count: number }[] }).rows;
    if (sitRows && sitRows[0] && sitRows[0].count > 0) {
      return {
        kind: "blocked",
        status: 409,
        data: {
          message:
            "Some line items on this devis are already referenced by progress claims (situations). Re-scraping would break that history. Detach or delete those situations first.",
          code: RESCRAPE_ERROR_CODES.HAS_SITUATIONS,
        },
      };
    }

    // Apply the refreshed financial fields. Identity fields preserved.
    const amountHt = corrected.amountHt != null
      ? String(roundCurrency(corrected.amountHt))
      : (corrected.amountTtc != null ? String(roundCurrency(corrected.amountTtc)) : locked.amountHt);
    const amountTtc = corrected.amountTtc != null
      ? String(roundCurrency(corrected.amountTtc))
      : (corrected.amountHt != null ? String(roundCurrency(corrected.amountHt)) : locked.amountTtc);
    const incomingHasLines = !!(parsed.lineItems && parsed.lineItems.length > 0);
    const nextInvoicingMode =
      locked.invoicingMode === "mode_a" && incomingHasLines ? "mode_b" : locked.invoicingMode;

    await tx
      .update(devisTable)
      .set({
        amountHt,
        amountTtc,
        invoicingMode: nextInvoicingMode,
        dateSent: locked.dateSent || parsed.date || null,
        validationWarnings: allWarnings,
        aiExtractedData: parsed,
        aiConfidence: validation.confidenceScore,
      })
      .where(sql`${devisTable.id} = ${devisId}`);

    // Replace line items in a single delete + bulk insert. Any error
    // here throws and rolls the whole transaction back.
    const delResult = await tx.execute<{ id: number }>(
      sql`DELETE FROM devis_line_items WHERE devis_id = ${devisId} RETURNING id`,
    );
    const lineItemsRemoved =
      (delResult as unknown as { rowCount?: number; rows?: unknown[] }).rowCount ??
      ((delResult as unknown as { rows?: unknown[] }).rows?.length ?? 0);

    let lineItemsCreated = 0;
    if (incomingHasLines) {
      const inserts = parsed.lineItems!.map((li, i) => {
        const rawPageHint: unknown = li.pageHint;
        const pdfPageHint =
          typeof rawPageHint === "number" && Number.isFinite(rawPageHint) && rawPageHint >= 1
            ? Math.floor(rawPageHint)
            : null;
        return {
          devisId,
          lineNumber: i + 1,
          description: toSentenceCase(li.description || `Line ${i + 1}`) as string,
          quantity: String(li.quantity ?? 1),
          unit: "u",
          unitPriceHt: String(roundCurrency(li.unitPrice ?? 0)),
          totalHt: String(roundCurrency(li.total ?? 0)),
          percentComplete: "0",
          pdfPageHint,
          pdfBbox: coerceBbox(li.bbox),
        };
      });
      if (inserts.length > 0) {
        await tx.insert(devisLineItemsTable).values(inserts);
        lineItemsCreated = inserts.length;
      }
    }

    return { kind: "ok", lineItemsCreated, lineItemsRemoved };
  });

  if (txResult.kind === "blocked") {
    return { success: false, status: txResult.status, data: txResult.data };
  }

  // ----- Phase 3: best-effort post-commit hooks. -----
  try {
    await reconcileAdvisories({ devisId }, allWarnings, "extractor");
  } catch (advErr) {
    console.warn(`[Devis Rescrape] Failed to persist advisories:`, advErr);
  }

  triggerDevisTranslation(devisId);

  const refreshed = await storage.getDevis(devisId);

  return {
    success: true,
    status: 200,
    data: {
      devis: refreshed,
      extraction: {
        documentType: parsed.documentType,
        contractorName: parsed.contractorName,
        lineItemsExtracted: parsed.lineItems?.length ?? 0,
        lineItemsRemoved: txResult.lineItemsRemoved,
        lineItemsCreated: txResult.lineItemsCreated,
      },
      validation: {
        isValid: validation.isValid,
        warnings: allWarnings,
        confidenceScore: validation.confidenceScore,
        correctedValues: validation.correctedValues,
      },
    },
  };
}
