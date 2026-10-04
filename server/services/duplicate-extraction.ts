import { createHash } from "node:crypto";
import { pool } from "../db";
import type { PoolClient } from "pg";
import { validateExtraction } from "./extraction-validator";
import { hasSignedOrClosedEvidence } from "./quotation-source-guards";
import type { DuplicateExtractionHistoryEntry } from "@shared/schema";

export async function getDuplicateCorrectionHistory(devisId: number): Promise<DuplicateExtractionHistoryEntry[]> {
  const quotation = await pool.query("SELECT id FROM devis WHERE id=$1", [devisId]);
  if (!quotation.rows.length) throw new CorrectionError("Quotation not found", 404);
  // Project only reviewed display fields in SQL: raw snapshots never leave this read path.
  // Use historical line evidence, not live rows (which may have been removed or re-extracted).
  const { rows } = await pool.query(`SELECT a.id, a.created_at, a.actor_id, a.reason,
    NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), '') AS actor_name,
    a.removed_line_id, a.retained_line_id,
    a.snapshot #>> '{preview,removeLine,lineNumber}' AS removed_number,
    a.snapshot #>> '{preview,removeLine,description}' AS removed_description,
    a.snapshot #>> '{preview,removeLine,totalHt}' AS removed_total,
    a.snapshot #>> '{preview,retainLine,lineNumber}' AS retained_number,
    a.snapshot #>> '{preview,retainLine,description}' AS retained_description,
    a.snapshot #>> '{preview,retainLine,totalHt}' AS retained_total,
    a.snapshot #>> '{preview,sourceTotalHt}' AS source_total,
    a.snapshot #>> '{preview,beforeSumHt}' AS before_sum,
    a.snapshot #>> '{preview,afterSumHt}' AS after_sum,
    a.snapshot #>> '{preview,discrepancyBeforeHt}' AS before_discrepancy,
    a.snapshot #>> '{preview,discrepancyAfterHt}' AS after_discrepancy
    FROM duplicate_extraction_audit a LEFT JOIN users u ON u.id=a.actor_id
    WHERE a.devis_id=$1 ORDER BY a.created_at DESC, a.id DESC`, [devisId]);
  return rows.map(row => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    actor: { id: row.actor_id, name: row.actor_name || `User #${row.actor_id}` },
    reason: row.reason,
    removedLine: { id: row.removed_line_id, lineNumber: Number(row.removed_number),
      description: row.removed_description, totalHt: row.removed_total },
    retainedLine: { id: row.retained_line_id, lineNumber: Number(row.retained_number),
      description: row.retained_description, totalHt: row.retained_total },
    reconciliation: { sourceTotalHt: row.source_total, beforeSumHt: row.before_sum,
      afterSumHt: row.after_sum, discrepancyBeforeHt: row.before_discrepancy,
      discrepancyAfterHt: row.after_discrepancy },
  }));
}

export class CorrectionError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
const money = (value: string) => Math.round(Number(value) * 100);
const display = (cents: number) => (cents / 100).toFixed(2);

async function inspect(client: PoolClient, devisId: number, removeId: number, retainId: number) {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [devisId]);
  const { rows: [devis] } = await client.query("SELECT * FROM devis WHERE id=$1 FOR UPDATE", [devisId]);
  if (!devis) throw new CorrectionError("Quotation not found", 404);
  const { rows: [project] } = await client.query("SELECT archived_at FROM projects WHERE id=$1 FOR UPDATE", [devis.project_id]);
  const { rows: lines } = await client.query("SELECT * FROM devis_line_items WHERE devis_id=$1 ORDER BY id FOR UPDATE", [devisId]);
  const remove = lines.find(l => l.id === removeId);
  const retain = lines.find(l => l.id === retainId);
  if (!remove || !retain || removeId === retainId) throw new CorrectionError("Select two different lines from this quotation", 400);
  const { rows: [translation] } = await client.query("SELECT * FROM devis_translations WHERE devis_id=$1 FOR UPDATE", [devisId]);
  const { rows: draftChecks } = await client.query("SELECT * FROM devis_checks WHERE line_item_id=$1 FOR UPDATE", [removeId]);
  let blockedReason: string | null = null;
  if (!devis.pdf_storage_key) blockedReason = "An original contractor PDF is required for this correction.";
  if (hasSignedOrClosedEvidence(devis))
    blockedReason = "Signed or legally closed quotation evidence is immutable, regardless of the current workflow stage.";
  if (["superseded", "cancelled", "void"].includes(devis.accounting_state))
    blockedReason = "A superseded or cancelled quotation cannot be corrected.";
  if (devis.sign_off_stage && devis.sign_off_stage !== "received")
    blockedReason = "This quotation has entered sign-off. Correction requires a separate reviewed revision.";
  if (project?.archived_at) blockedReason = "Archived projects are read-only.";
  if (!["pending", "draft", "received", "analyzed"].includes(devis.status) || devis.archisign_envelope_id)
    blockedReason = "This quotation has progressed beyond draft review. Its issued or committed evidence cannot be changed here.";
  if (translation && ["processing", "finalised"].includes(translation.status))
    blockedReason = "Wait for translation processing to finish, or unlock the finalised translation for review first.";
  if (lines.filter(l => l.line_number === remove.line_number).length !== 1)
    blockedReason = "Duplicate line numbering prevents a safe translation correction. Review the imported line identities first.";
  const { rows: [linked] } = await client.query(`SELECT
    EXISTS(SELECT 1 FROM invoices WHERE devis_id=$1) OR
    EXISTS(SELECT 1 FROM situation_lines WHERE devis_line_item_id=ANY($2::int[])) OR
    EXISTS(SELECT 1 FROM certificats c JOIN devis d ON d.project_id=c.project_id AND d.contractor_id=c.contractor_id
      WHERE d.id=$1 AND c.status <> 'superseded') AS protected`,
    [devisId, lines.map(l => l.id)]);
  if (linked.protected) blockedReason = "Invoices, certificates or progress claims protect this quotation. Financial history cannot be removed.";
  // Refuse rather than silently detach or cascade away human evidence.
  const { rows: [evidence] } = await client.query(`SELECT
    EXISTS(SELECT 1 FROM devis_checks c WHERE c.line_item_id=$1 AND
      (c.status <> 'open' OR EXISTS(SELECT 1 FROM devis_check_messages m WHERE m.check_id=c.id))) OR
    EXISTS(SELECT 1 FROM client_checks WHERE devis_line_item_id=$1) OR
    EXISTS(SELECT 1 FROM devis_line_contexts WHERE devis_line_item_id=$1) OR
    EXISTS(SELECT 1 FROM devis_line_context_assets WHERE devis_line_item_id=$1) AS present`, [removeId]);
  if (evidence.present) blockedReason = "This line has linked comments or context. Removal is blocked to preserve that evidence.";
  const before = lines.reduce((sum, line) => sum + money(line.total_ht), 0);
  const after = before - money(remove.total_ht);
  const source = money(devis.amount_ht);
  const fingerprint = createHash("sha256").update(JSON.stringify({ devis, lines, translation, draftChecks })).digest("hex");
  const line = (l: typeof remove) => ({ id: l.id, lineNumber: l.line_number, description: l.description, totalHt: l.total_ht });
  return { devis, lines, translation, draftChecks, remove, retain, preview: {
    removeLine: line(remove), retainLine: line(retain), beforeSumHt: display(before), afterSumHt: display(after),
    sourceTotalHt: display(source), discrepancyBeforeHt: display(before-source), discrepancyAfterHt: display(after-source),
    fingerprint, blockedReason,
  } };
}

export async function duplicateCorrection(devisId: number, removeId: number, retainId: number,
  confirmation?: { actorId: number; reason: string; fingerprint: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [devisId]);
    if (confirmation) {
      const { rows: [prior] } = await client.query("SELECT * FROM duplicate_extraction_audit WHERE removed_line_id=$1", [removeId]);
      if (prior) {
        if (prior.devis_id !== devisId || prior.retained_line_id !== retainId || prior.reason !== confirmation.reason ||
          prior.actor_id !== confirmation.actorId || prior.snapshot.preview.fingerprint !== confirmation.fingerprint)
          throw new CorrectionError("This line has already been corrected differently.");
        await client.query("COMMIT");
        return { corrected: true };
      }
    }
    const state = await inspect(client, devisId, removeId, retainId);
    if (confirmation) {
      if (state.preview.blockedReason) throw new CorrectionError(state.preview.blockedReason);
      if (state.preview.fingerprint !== confirmation.fingerprint) throw new CorrectionError("Quotation changed. Review a fresh preview before confirming.");
      await client.query(`INSERT INTO duplicate_extraction_audit
        (devis_id,removed_line_id,retained_line_id,actor_id,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6)`,
        [devisId, removeId, retainId, confirmation.actorId, confirmation.reason, JSON.stringify(state)]);
      await client.query(`UPDATE devis_translations SET line_translations=(
        SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(line_translations,'[]'::jsonb))
        WHERE (value->>'lineNumber')::int <> $2), approved_at=NULL, approved_by=NULL,
        approved_by_email=NULL, contexts_version=contexts_version+1, translated_pdf_storage_key=NULL,
        combined_pdf_storage_key=NULL, updated_at=now() WHERE devis_id=$1`, [devisId, state.remove.line_number]);
      // Unsent review flags are captured in the audit above, not left as live questions on a removed row.
      await client.query(`UPDATE devis_checks SET status='dropped', line_item_id=NULL, resolved_at=now(),
        resolved_by_user_id=$2 WHERE line_item_id=$1`, [removeId, confirmation.actorId]);
      await client.query("DELETE FROM devis_line_items WHERE id=$1", [removeId]);
      // Revalidate the corrected working representation, never overwrite raw extraction or source totals.
      const working = {
        ...(state.devis.ai_extracted_data ?? {}),
        amountHt: Number(state.devis.amount_ht),
        amountTtc: Number(state.devis.amount_ttc),
        lineItems: state.lines.filter(l => l.id !== removeId).map(l => ({
          lineNumber: l.line_number, description: l.description, quantity: Number(l.quantity),
          unit: l.unit, unitPrice: Number(l.unit_price_ht), total: Number(l.total_ht),
        })),
      };
      const validation = validateExtraction(working);
      // Keep independent source/document warnings; replace line-derived reconciliation findings.
      const previous = Array.isArray(state.devis.validation_warnings) ? state.devis.validation_warnings : [];
      const refreshed = validation.warnings.filter(w => w.field === "lineItems" || w.lines);
      await client.query("UPDATE devis SET validation_warnings=$2 WHERE id=$1", [devisId,
        JSON.stringify([...previous.filter((w: any) => w.field !== "lineItems" && !w.lines), ...refreshed])]);
    }
    await client.query("COMMIT");
    return confirmation ? { corrected: true } : state.preview;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}