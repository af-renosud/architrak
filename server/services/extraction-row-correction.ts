import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { pool } from "../db";
import { getDocumentStream } from "../storage/object-storage";
import { CorrectionError } from "./duplicate-extraction";
import { hasSignedOrClosedEvidence } from "./quotation-source-guards";
import { extractionCorrectionSchema, type ExtractionCorrection } from "../../shared/extraction-row-correction";
import { validateExtraction } from "./extraction-validator";
import { corroborateCorrectionEvidence } from "./correction-pdf-evidence";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cents = (value: string) => Math.round(Number(value) * 100);
const amount = (value: number) => (value / 100).toFixed(2);
const rowView = (row: any) => ({
  lineNumber: row.line_number, description: row.description, quantity: row.quantity,
  unit: row.unit, unitPriceHt: row.unit_price_ht, totalHt: row.total_ht,
});

export async function extractionRowCorrection(devisId: number, input: ExtractionCorrection,
  confirmation?: { actorId: number; fingerprint: string; confirmed: true }) {
  const request = extractionCorrectionSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [devisId]);
    if (confirmation) {
      const { rows: [prior] } = await client.query("SELECT * FROM extraction_row_corrections WHERE fingerprint=$1", [confirmation.fingerprint]);
      if (prior) {
        if (prior.devis_id !== devisId || prior.actor_id !== confirmation.actorId || hash(prior.snapshot.request) !== hash(request))
          throw new CorrectionError("This preview has already been used differently.");
        await client.query("COMMIT");
        return { corrected: true };
      }
    }
    const { rows: [devis] } = await client.query("SELECT * FROM devis WHERE id=$1 FOR UPDATE", [devisId]);
    if (!devis) throw new CorrectionError("Quotation not found", 404);
    const { rows: [project] } = await client.query("SELECT archived_at FROM projects WHERE id=$1 FOR UPDATE", [devis.project_id]);
    const { rows: lines } = await client.query("SELECT * FROM devis_line_items WHERE devis_id=$1 ORDER BY id FOR UPDATE", [devisId]);
    const { rows: [translation] } = await client.query("SELECT * FROM devis_translations WHERE devis_id=$1 FOR UPDATE", [devisId]);
    const before = request.kind === "misread" ? lines.find(l => l.id === request.lineId) : null;
    if (request.kind === "misread" && !before) throw new CorrectionError("Line does not belong to this quotation.", 400);
    if (!devis.pdf_storage_key) throw new CorrectionError("An original contractor PDF is required.");
    let blockedReason: string | null = null;
    if (hasSignedOrClosedEvidence(devis) || devis.archisign_envelope_id ||
      !["pending", "draft", "received", "analyzed"].includes(devis.status) ||
      (devis.sign_off_stage && devis.sign_off_stage !== "received") ||
      ["superseded", "cancelled", "void"].includes(devis.accounting_state))
      blockedReason = "Issued, signed, closed or committed quotations cannot be corrected here.";
    if (project?.archived_at) blockedReason = "Archived projects are read-only.";
    if (translation && ["processing", "finalised"].includes(translation.status))
      blockedReason = "Translation must be unlocked and not processing before correction.";
    if (lines.some(l => l.id !== before?.id && l.line_number === request.row.lineNumber))
      blockedReason = "Line number already exists. Select the misread row or use an unused line number.";
    if (before && before.line_number !== request.row.lineNumber)
      blockedReason = "A misread correction cannot change line identity.";
    const { rows: [linked] } = await client.query(`SELECT
      EXISTS(SELECT 1 FROM invoices WHERE devis_id=$1) OR
      EXISTS(SELECT 1 FROM situation_lines WHERE devis_line_item_id=ANY($2::int[])) OR
      EXISTS(SELECT 1 FROM certificats c WHERE c.project_id=$3 AND c.contractor_id=$4 AND c.status<>'superseded') AS protected`,
    [devisId, lines.map(l => l.id), devis.project_id, devis.contractor_id]);
    if (linked.protected) blockedReason = "Invoices, certificates or progress claims protect this quotation.";
    if (before) {
      const { rows: [linkedLine] } = await client.query(`SELECT
        EXISTS(SELECT 1 FROM devis_checks WHERE line_item_id=$1) OR
        EXISTS(SELECT 1 FROM client_checks WHERE devis_line_item_id=$1) OR
        EXISTS(SELECT 1 FROM devis_line_contexts WHERE devis_line_item_id=$1) OR
        EXISTS(SELECT 1 FROM devis_line_context_assets WHERE devis_line_item_id=$1) AS present`, [before.id]);
      if (linkedLine.present || Number(before.percent_complete) !== 0 || before.check_status !== "unchecked" || before.check_notes)
        blockedReason = "This row has review, context or progress evidence. Correction is blocked.";
    }
    // Read the actual immutable source, not a caller-provided file or source URL.
    const { stream } = await getDocumentStream(devis.pdf_storage_key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const pdf = Buffer.concat(chunks);
    const sourceDigest = createHash("sha256").update(pdf).digest("hex");
    const pages = (await PDFDocument.load(pdf)).getPageCount();
    if (request.evidence.page > pages) throw new CorrectionError("Evidence page is outside the original PDF.", 400);
    const corroboration = await corroborateCorrectionEvidence(pdf, request);
    const beforeSum = lines.reduce((sum, l) => sum + cents(l.total_ht), 0);
    const afterSum = beforeSum - (before ? cents(before.total_ht) : 0) + cents(request.row.totalHt);
    const source = cents(devis.amount_ht);
    const preview = {
      fingerprint: hash({ devis, lines, translation, request, sourceDigest }),
      blockedReason, before: before ? rowView(before) : null, after: request.row,
      beforeSumHt: amount(beforeSum), afterSumHt: amount(afterSum),
      sourceTotalHt: devis.amount_ht, sourceTotalTtc: devis.amount_ttc,
      discrepancyBeforeHt: amount(beforeSum - source), discrepancyAfterHt: amount(afterSum - source),
    };
    if (confirmation) {
      if (confirmation.confirmed !== true) throw new CorrectionError("Human source confirmation is required.", 400);
      if (blockedReason) throw new CorrectionError(blockedReason);
      if (confirmation.fingerprint !== preview.fingerprint) throw new CorrectionError("Quotation or source changed. Review a fresh preview.");
      const r = request.row;
      const values = [r.lineNumber, r.description, r.quantity, r.unit, r.unitPriceHt, r.totalHt, request.evidence.page];
      const { rows: [corrected] } = before
        ? await client.query(`UPDATE devis_line_items SET line_number=$1,description=$2,quantity=$3,unit=$4,
          unit_price_ht=$5,total_ht=$6,pdf_page_hint=$7,pdf_bbox=NULL WHERE id=$8 RETURNING *`, [...values, before.id])
        : await client.query(`INSERT INTO devis_line_items
          (line_number,description,quantity,unit,unit_price_ht,total_ht,pdf_page_hint,devis_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [...values, devisId]);
      await client.query(`INSERT INTO extraction_row_corrections(devis_id,line_id,actor_id,reason,fingerprint,snapshot)
        VALUES($1,$2,$3,$4,$5,$6)`, [devisId, corrected.id, confirmation.actorId, request.reason, preview.fingerprint,
        JSON.stringify({ request, preview, originalRow: before, correctedRow: corrected,
          source: { storageKey: devis.pdf_storage_key, sha256: sourceDigest, pages,
            corroboration, rawExtraction: devis.ai_extracted_data },
          confirmed: true })]);
      // Changed text and prices need fresh translation/review, not an old generated PDF.
      await client.query(`UPDATE devis_translations SET line_translations=(
        SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(line_translations,'[]'::jsonb))
        WHERE (value->>'lineNumber')::int <> $2), approved_at=NULL,approved_by=NULL,approved_by_email=NULL,
        contexts_version=contexts_version+1,translated_pdf_storage_key=NULL,combined_pdf_storage_key=NULL,
        updated_at=now() WHERE devis_id=$1`, [devisId, r.lineNumber]);
      const workingLines = [...lines.filter(l => l.id !== before?.id), corrected];
      const validation = validateExtraction({
        ...(devis.ai_extracted_data ?? {}), amountHt: Number(devis.amount_ht), amountTtc: Number(devis.amount_ttc),
        lineItems: workingLines.map(l => ({ lineNumber: l.line_number, description: l.description,
          quantity: Number(l.quantity), unit: l.unit, unitPrice: Number(l.unit_price_ht), total: Number(l.total_ht) })),
      });
      const previous = Array.isArray(devis.validation_warnings) ? devis.validation_warnings : [];
      await client.query("UPDATE devis SET validation_warnings=$2 WHERE id=$1", [devisId,
        JSON.stringify([...previous.filter((w: any) => w.field !== "lineItems" && !w.lines),
          ...validation.warnings.filter(w => w.field === "lineItems" || w.lines)])]);
    }
    await client.query("COMMIT");
    return confirmation ? { corrected: true } : preview;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}