import { db, pool } from "../db";
import { createHash } from "node:crypto";
import { verifyQuotationManifest } from "./quotation-source-manifest";
import type { ParsedDocument } from "../gmail/document-parser";
import { recordExtractionEvent } from "./quotation-extraction-events";
import { hasSignedOrClosedEvidence } from "./quotation-source-guards";
import { quotationWorkingVersion } from "./quotation-working-version";
import { hasArchitectCorrection, hasQuotationSourceBaseline } from "./architect-quotation-correction";
import { sql } from "drizzle-orm";
import { storage } from "../storage";
import { getDocumentBuffer } from "../storage/object-storage";
import { validateExtraction } from "./extraction-validator";
import { findBlockingCompletenessWarnings } from "./extraction-completeness";
import { checkLotReferencesAgainstCatalog } from "./lot-reference-validator";
import { roundCurrency } from "../../shared/financial-utils";
import { reconcileAdvisories } from "./advisory-reconciler";
import { triggerDevisTranslation } from "./devis-translation";
import { enqueueDriveUpload } from "./drive/upload-queue.service";
import { safeExtractIban, safeExtractBic } from "../../shared/iban";
import { toSentenceCase } from "../lib/sentence-case";
import { coerceBbox } from "./devis-upload.service";
import { deleteContextAssetObjects } from "./devis-line-context";
import { recoverPlanningTotalsBoxLines } from "./planning-totals-recovery.service";
import {
  devis as devisTable,
  devisLineItems as devisLineItemsTable,
  devisTranslations,
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
  EXTRACTION_INCOMPLETE: "EXTRACTION_INCOMPLETE",
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
export async function rescrapeDevis(devisId: number, approval?: { attemptId: number; actorId: number; reason: string }): Promise<RescrapeResult> {
  try { return await runRescrape(devisId, approval); }
  catch (error) {
    await recordExtractionEvent(devisId, "attempt", "failed", { category: "unavailable" });
    throw error;
  }
}

async function runRescrape(devisId: number, approval?: { attemptId: number; actorId: number; reason: string }): Promise<RescrapeResult> {
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
  if (await hasArchitectCorrection(devisId) || await hasQuotationSourceBaseline(devisId)) return { success: false, status: 409,
    data: { message: "Architect corrections are protected. Re-scraping cannot replace this working version; use the correction editor." } };
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

  if (hasSignedOrClosedEvidence(initial) || initial.archisignEnvelopeId
    || !["pending", "draft", "confirmed", "received", "analyzed"].includes(initial.status)
    || (initial.signOffStage && !["received", "checked_internal", "client_rejected"].includes(initial.signOffStage))) {
    return { success: false, status: 409, data: { message: "Issued, signed or closed quotations cannot be re-scraped." } };
  }
  await recordExtractionEvent(devisId, "attempt", "started");
  const initialLines = await storage.getDevisLineItems(devisId);
  const initialTranslation = await storage.getDevisTranslation(devisId);
  let beforeFingerprint = quotationWorkingVersion(initial, initialLines, initialTranslation);

  let buffer: Buffer;
  try {
    buffer = await getDocumentBuffer(initial.pdfStorageKey);
  } catch (err: unknown) {
    await recordExtractionEvent(devisId, "attempt", "failed", { category: "source_unavailable" });
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
  let parsed: ParsedDocument;
  if (approval) {
    const { rows } = await pool.query(`SELECT snapshot FROM quotation_extraction_events
      WHERE id=$1 AND devis_id=$2 AND kind='attempt' AND outcome='failed'`,
    [approval.attemptId, devisId]);
    const candidate = rows[0]?.snapshot?.extraction as ParsedDocument | undefined;
    const preparedFingerprint = rows[0]?.snapshot?.preparedFingerprint;
    if (typeof preparedFingerprint !== "string" || preparedFingerprint !== beforeFingerprint) {
      return { success: false, status: 409, data: { message: "This proposal was prepared for an older working version. Re-scrape the current quotation before approving it." } };
    }
    beforeFingerprint = preparedFingerprint;
    const evidence = candidate?.quotationVerification;
    if (!candidate || !evidence?.manifest || !evidence.proposedLineItems
      || evidence.sourceDigest !== createHash("sha256").update(buffer).digest("hex")
      || !approval.reason.trim()) {
      return { success: false, status: 409, data: { message: "Candidate evidence is unavailable or belongs to a different source PDF." } };
    }
    candidate.lineItems = evidence.proposedLineItems;
    const sourceRows = evidence.manifest.sections.map(s => ({ page: s.priceRegion.page,
      reference: s.reference, quantity: s.quantity, unitPrice: s.unitPrice, total: s.total }));
    const check = verifyQuotationManifest(evidence.manifest, sourceRows, candidate,
      candidate.extractionCoverage?.pdfPageCount ?? 0);
    if (!check.verified) return { success: false, status: 409,
      data: { message: "Independent source coverage still has unresolved findings. It cannot be approved.", verification: check } };
    // This explicit human classification applies ONLY to differing initial OCR.
    // It cannot waive an uncertain source region or change source prices.
    evidence.verified = true;
    evidence.failures = [];
    parsed = candidate;
  } else {
    parsed = await parseDocument(buffer, fileName);
  }

  if (
    parsed.documentType === "unknown" &&
    !parsed.amountHt &&
    !parsed.contractorName &&
    !parsed.lineItems?.length
  ) {
    const transient = isTransientParseFailure(parsed);
    const reason = getParseFailureMessage(parsed);
    await recordExtractionEvent(devisId, "attempt", "failed", { category: "extraction_unavailable" });
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

  let validation = validateExtraction(parsed);
  ({ parsed, validation } = await recoverPlanningTotalsBoxLines({
    pdfBuffer: buffer,
    fileName,
    parsed,
    validation,
  }));

  // Task #350 — completeness hard gate, mirrored from the upload path: never
  // overwrite existing line items with a demonstrably partial extraction.
  const blockingCompleteness = [
    ...findBlockingCompletenessWarnings(validation.warnings),
    ...validation.warnings.filter(w => w.field === "quotationContentCoverage" && w.severity === "error"),
  ];
  if (blockingCompleteness.length > 0) {
    await recordExtractionEvent(devisId, "attempt", "failed", { warnings: blockingCompleteness, extraction: parsed, preparedFingerprint: beforeFingerprint });
    return {
      success: false,
      status: 422,
      data: {
        message: `Extraction appears incomplete: ${blockingCompleteness.map((w) => w.message).join(" ")}`,
        code: RESCRAPE_ERROR_CODES.EXTRACTION_INCOMPLETE,
        extraction: parsed,
      },
    };
  }

  const lotWarnings = await checkLotReferencesAgainstCatalog(parsed);
  const corrected = { ...parsed, ...validation.correctedValues };
  const allWarnings = [...validation.warnings, ...lotWarnings];

  // ----- Phase 2: serialised mutation in a transaction. -----
  type TxResult =
    | { kind: "ok"; lineItemsCreated: number; lineItemsRemoved: number }
    | { kind: "blocked"; status: number; data: Record<string, unknown> };

  // Context-asset rows cascade away with the line delete inside the
  // transaction; this snapshot (taken under the row lock) keeps their
  // storage keys so phase 3 can clean the stored objects post-commit.
  let contextAssetsToClean: Awaited<ReturnType<typeof storage.getDevisLineContextAssetsByDevis>> = [];

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
    await tx.execute(sql`SELECT 1 FROM projects WHERE id=${locked.projectId} FOR SHARE`);
    await tx.execute(sql`SELECT id FROM devis_line_items WHERE devis_id=${devisId} FOR UPDATE`);
    await tx.execute(sql`SELECT devis_id FROM devis_translations WHERE devis_id=${devisId} FOR UPDATE`);
    const currentLines = await tx.select().from(devisLineItemsTable)
      .where(sql`${devisLineItemsTable.devisId}=${devisId}`).orderBy(devisLineItemsTable.lineNumber);
    const [currentTranslation] = await tx.select().from(devisTranslations)
      .where(sql`${devisTranslations.devisId}=${devisId}`);
    if (quotationWorkingVersion(locked, currentLines, currentTranslation) !== beforeFingerprint) {
      return { kind: "blocked", status: 409, data: { message: "Quotation changed while extraction was running. No rows were replaced." } };
    }
    if (hasSignedOrClosedEvidence(locked) || locked.archisignEnvelopeId
      || !["pending", "draft", "confirmed", "received", "analyzed"].includes(locked.status)
      || (locked.signOffStage && !["received", "checked_internal", "client_rejected"].includes(locked.signOffStage))) {
      return { kind: "blocked", status: 409, data: { message: "Quotation was issued, signed or closed during extraction." } };
    }
    const protection = await tx.execute<{ present: boolean }>(sql`
      SELECT EXISTS(SELECT 1 FROM projects WHERE id=${locked.projectId} AND archived_at IS NOT NULL)
      OR EXISTS(SELECT 1 FROM devis_translations WHERE devis_id=${devisId}
        AND (status IN ('edited','finalised','processing')
          OR line_translations::text LIKE '%"edited": true%'))
      OR EXISTS(SELECT 1 FROM duplicate_extraction_audit WHERE devis_id=${devisId})
      OR EXISTS(SELECT 1 FROM extraction_row_corrections WHERE devis_id=${devisId})
      OR EXISTS(SELECT 1 FROM acompte_no_invoice_payments WHERE devis_id=${devisId})
      OR EXISTS(SELECT 1 FROM certificats WHERE project_id=${locked.projectId}
        AND contractor_id=${locked.contractorId} AND status <> 'superseded')
      OR EXISTS(SELECT 1 FROM devis_line_contexts c JOIN devis_line_items l ON l.id=c.devis_line_item_id WHERE l.devis_id=${devisId})
      OR EXISTS(SELECT 1 FROM devis_line_context_assets c JOIN devis_line_items l ON l.id=c.devis_line_item_id WHERE l.devis_id=${devisId})
      OR EXISTS(SELECT 1 FROM devis_checks c JOIN devis_line_items l ON l.id=c.line_item_id WHERE l.devis_id=${devisId})
      OR EXISTS(SELECT 1 FROM client_checks c JOIN devis_line_items l ON l.id=c.devis_line_item_id WHERE l.devis_id=${devisId})
      OR EXISTS(SELECT 1 FROM devis_line_items WHERE devis_id=${devisId}
        AND (check_status <> 'unchecked' OR check_notes IS NOT NULL OR percent_complete <> 0))
      AS present`);
    if ((protection as unknown as { rows: Array<{ present: boolean }> }).rows[0]?.present) {
      return { kind: "blocked", status: 409, data: { message: "Existing translation, correction, review or context evidence prevents destructive replacement. The current quotation has been preserved." } };
    }
    if (approval) {
      const applied = await tx.execute(sql`SELECT 1 FROM quotation_extraction_events WHERE devis_id=${devisId}
        AND kind='replacement' AND snapshot->'humanReview'->>'attemptId'=${String(approval.attemptId)} LIMIT 1`);
      if (applied.rows.length) return { kind: "blocked", status: 409,
        data: { message: "This prepared candidate has already been applied." } };
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
    if (!incomingHasLines) {
      return { kind: "blocked", status: 422, data: { message: "The new extraction contains no rows. Existing content was preserved." } };
    }
    await tx.execute(sql`INSERT INTO quotation_extraction_events(devis_id,kind,outcome,snapshot)
      SELECT ${devisId},'replacement','applied',
        jsonb_build_object('before',to_jsonb(d),'beforeLines',
          (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM devis_line_items l WHERE l.devis_id=${devisId}),
          'beforeTranslation',(SELECT to_jsonb(t) FROM devis_translations t WHERE t.devis_id=${devisId}),
          'candidate',${JSON.stringify(parsed)}::jsonb,
          'humanReview',${JSON.stringify(approval ?? null)}::jsonb,
          'sourceDigest',${createHash("sha256").update(buffer).digest("hex")})
      FROM devis d WHERE d.id=${devisId}`);
    await tx.execute(sql`UPDATE devis_translations SET status='pending',line_translations=NULL,
      translated_pdf_storage_key=NULL,combined_pdf_storage_key=NULL,contexts_version=contexts_version+1,
      approved_at=NULL,approved_by=NULL,approved_by_email=NULL WHERE devis_id=${devisId}`);
    if (approval) {
      await tx.execute(sql`INSERT INTO quotation_extraction_events
        (devis_id,actor_id,kind,outcome,category,reason,snapshot)
        VALUES(${devisId},${approval.actorId},'review','corrected','wrong_association',${approval.reason},
          ${JSON.stringify({ attemptId: approval.attemptId, initialOcrClassifiedAsErroneous: true })}::jsonb)`);
    }

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
        // Task #225 — Re-capture banking on every rescrape; user may have
        // re-uploaded a corrected PDF with the right IBAN.
        extractedIban: safeExtractIban(parsed.iban),
        extractedBic: safeExtractBic(parsed.bic),
      })
      .where(sql`${devisTable.id} = ${devisId}`);

    // Snapshot context-asset storage keys BEFORE the wholesale line delete:
    // the FK cascade removes devis_line_context_assets rows with the lines,
    // after which the stored objects would be unrecoverable orphans. The
    // objects themselves are deleted post-commit (phase 3, best-effort).
    contextAssetsToClean = await storage.getDevisLineContextAssetsByDevis(devisId);

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
          description: parsed.quotationVerification ? li.description : toSentenceCase(li.description || `Line ${i + 1}`) as string,
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
    await tx.execute(sql`INSERT INTO quotation_extraction_events(devis_id,kind,outcome,snapshot)
      SELECT ${devisId},'replacement','committed',
        jsonb_build_object('afterLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_number)
          FROM devis_line_items l WHERE l.devis_id=${devisId}),
          'sourceSections',${JSON.stringify(parsed.quotationVerification?.manifest?.sections ?? [])}::jsonb,
          'sourceDigest',${createHash("sha256").update(buffer).digest("hex")})`);
    }

    return { kind: "ok", lineItemsCreated, lineItemsRemoved };
  });

  if (txResult.kind === "blocked") {
    await recordExtractionEvent(devisId, "attempt", "failed", txResult.data);
    return { success: false, status: txResult.status, data: txResult.data };
  }
  await recordExtractionEvent(devisId, "attempt", "succeeded");

  // ----- Phase 3: best-effort post-commit hooks. -----
  // The line delete cascaded the context-asset rows; remove their stored
  // objects too (best-effort — deleteContextAssetObjects never throws).
  if (contextAssetsToClean.length > 0) {
    void deleteContextAssetObjects(contextAssetsToClean);
  }

  try {
    await reconcileAdvisories({ devisId }, allWarnings, "extractor");
  } catch (advErr) {
    console.warn(`[Devis Rescrape] Failed to persist advisories:`, advErr);
  }

  triggerDevisTranslation(devisId);

  const refreshed = await storage.getDevis(devisId);

  // Task #198 — re-enqueue Drive upload for the (possibly replaced)
  // PDF. The queue is idempotent on (devis, devisId) so a row that
  // already succeeded stays succeeded; this only fires the upload when
  // no Drive copy exists yet (e.g. operator scraped the PDF later).
  if (initial.pdfStorageKey && refreshed) {
    void enqueueDriveUpload({
      docKind: "devis",
      docId: devisId,
      projectId: refreshed.projectId,
      lotId: refreshed.lotId ?? null,
      sourceStorageKey: initial.pdfStorageKey,
      displayName: `${refreshed.devisCode || `devis-${devisId}`}.pdf`,
    });
  }

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
