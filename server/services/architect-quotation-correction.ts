import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type pg from "pg";
import { pool } from "../db";
import { getDocumentBuffer } from "../storage/object-storage";
import { stableQuotationDigest } from "./quotation-working-version";
import { hasSignedOrClosedEvidence } from "./quotation-source-guards";
import { architectBaselineConfirmationSchema, architectCorrectionSaveSchema, correctionCents, financialProjection, previewCorrectionTotals } from "../../shared/architect-quotation";
import type { ArchitectCorrectionDraft, ArchitectCorrectionLine, ArchitectCorrectionSnapshot } from "../../shared/architect-quotation";

export class ArchitectCorrectionError extends Error {
  constructor(message: string, public status = 409, public code = "ARCHITECT_CORRECTION_CONFLICT") { super(message); }
}
type Reader = Pick<pg.PoolClient, "query">;
interface State { quotation: any; lines: any[]; translation: any; baseline: any; state: any; archived: boolean; financial: boolean }
async function load(client: Reader, devisId: number, lock = false): Promise<State> {
  const quotation = (await client.query(`SELECT * FROM devis WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [devisId])).rows[0];
  if (!quotation) throw new ArchitectCorrectionError("Quotation not found.", 404);
  const project = (await client.query(`SELECT archived_at FROM projects WHERE id=$1${lock ? " FOR SHARE" : ""}`, [quotation.project_id])).rows[0];
  if (!project) throw new ArchitectCorrectionError("Project not found.", 404);
  const lines = (await client.query(`SELECT * FROM devis_line_items WHERE devis_id=$1 ORDER BY line_number,id${lock ? " FOR UPDATE" : ""}`, [devisId])).rows;
  const translation = (await client.query(`SELECT * FROM devis_translations WHERE devis_id=$1${lock ? " FOR UPDATE" : ""}`, [devisId])).rows[0];
  const baseline = (await client.query("SELECT * FROM quotation_source_baselines WHERE devis_id=$1", [devisId])).rows[0];
  const state = (await client.query("SELECT * FROM quotation_architect_state WHERE devis_id=$1", [devisId])).rows[0];
  const financial = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM invoices WHERE devis_id=$1)
    OR EXISTS(SELECT 1 FROM situations WHERE devis_id=$1)
    OR EXISTS(SELECT 1 FROM acompte_no_invoice_payments WHERE devis_id=$1)
    OR EXISTS(SELECT 1 FROM certificats WHERE project_id=$2 AND contractor_id=$3 AND status <> 'superseded')
    OR EXISTS(SELECT 1 FROM situation_lines sl JOIN devis_line_items l ON l.id=sl.devis_line_item_id WHERE l.devis_id=$1)
    AS present`, [devisId, quotation.project_id, quotation.contractor_id])).rows[0]?.present;
  return { quotation, lines, translation, baseline, state, archived: !!project.archived_at, financial: !!financial };
}
const version = (s: State) => stableQuotationDigest(s);
const lineKey = (id: number) => `line-${id}`;
function draftFrom(s: State): ArchitectCorrectionDraft {
  const metadata = s.state?.draft as ArchitectCorrectionDraft | undefined;
  const byId = new Map((metadata?.lines ?? []).map(l => [l.id, l]));
  const translations = new Map<number, any>((s.translation?.line_translations ?? []).map((l: any) => [l.lineNumber, l]));
  const header = s.translation?.header_translated ?? {};
  // Only explicit extracted VAT evidence may seed a known rate. Never infer a
  // rate from mutable HT/TTC or default to 20%. A missing rate remains unknown.
  const evidence = s.quotation.ai_extracted_data;
  const explicitRate = evidence?.autoLiquidation === true ? "0"
    : typeof evidence?.tvaRate === "number" && evidence.tvaRate >= 0 && evidence.tvaRate <= 100 ? String(evidence.tvaRate) : "";
  return {
    headerFr: s.quotation.description_fr ?? "", headerEn: header.description ?? "",
    explanationFr: metadata?.explanationFr ?? header.descriptionExplanationFr ?? "",
    explanationEn: header.descriptionExplanation ?? "", summaryEn: header.summary ?? "",
    discountHt: metadata?.discountHt ?? "0.00", vatRounding: metadata?.vatRounding ?? "bucket",
    lines: s.lines.map(row => {
      const saved = byId.get(row.id), t = translations.get(row.line_number);
      return { id: row.id, clientKey: saved?.clientKey ?? lineKey(row.id), kind: saved?.kind ?? "priced",
        descriptionFr: row.description, descriptionEn: t?.translation ?? "",
        explanationFr: saved?.explanationFr ?? t?.explanationFr ?? "", explanationEn: t?.explanation ?? "",
        quantity: row.quantity ?? (saved?.kind === "context" ? "0" : ""), unit: row.unit ?? "",
        unitPriceHt: row.unit_price_ht ?? "", totalHt: row.total_ht,
        vatRate: saved?.vatRate ?? explicitRate, included: saved?.included ?? true };
    }),
  };
}
function protection(s: State) {
  const d = s.quotation;
  const blockedReason = s.archived ? "Archived projects are read-only."
    : ["void", "cancelled"].includes(d.status) || d.accounting_state === "superseded" ? "This quotation has been replaced or cancelled." : null;
  const committed = s.financial || hasSignedOrClosedEvidence(d) || d.archisign_envelope_id
    || !["draft", "pending", "confirmed", "received", "analyzed"].includes(d.status)
    || d.sign_off_stage && !["received", "checked_internal", "client_rejected"].includes(d.sign_off_stage);
  return { blockedReason, financialBlockedReason: committed ? "Issued, signed or financially committed figures are protected. Corrections create a new contextual working version; existing signed documents are unchanged." : null };
}
async function snapshot(client: Reader, s: State): Promise<ArchitectCorrectionSnapshot> {
  const history = (await client.query(`SELECT a.id,a.operation,a.created_at,COALESCE(NULLIF(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email,'Architect') actor
    FROM quotation_architect_audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.devis_id=$1 ORDER BY a.id DESC LIMIT 30`, [s.quotation.id])).rows;
  let actor = "";
  if (s.baseline) actor = (await client.query("SELECT COALESCE(NULLIF(trim(concat_ws(' ',first_name,last_name)),''),email) actor FROM users WHERE id=$1", [s.baseline.actor_id])).rows[0]?.actor ?? "Architect";
  const evidence = s.quotation.ai_extracted_data;
  return { version: version(s), draft: draftFrom(s), ...protection(s),
    workingTotals: { ht: s.quotation.amount_ht ?? "", ttc: s.quotation.amount_ttc ?? "" },
    baseline: s.baseline ? { ttc: s.baseline.ttc, sourceFileName: s.baseline.source_file_name,
      sourceDigest: s.baseline.source_digest, confirmedAt: new Date(s.baseline.created_at).toISOString(), confirmedBy: actor } : null,
    advisoryMessages: evidence?.quotationVerification?.verified === false || evidence?.illustratedRecovery
      ? ["Historical extraction coverage may disagree with this human interpretation. Review the original PDF; these observations do not veto human content approval."] : [],
    history: history.map(r => ({ id: r.id, actor: r.actor, savedAt: new Date(r.created_at).toISOString(),
      summary: r.operation === "baseline" ? "Original PDF TTC confirmed and locked" : "Architect working correction saved" })) };
}
async function pdfReceipt(readPdf: (key: string) => Promise<Buffer>, key: string | null) {
  if (!key) throw new ArchitectCorrectionError("Attach an original contractor PDF before confirming its source TTC.", 422);
  const bytes = await readPdf(key);
  const pdf = await PDFDocument.load(bytes);
  return { digest: createHash("sha256").update(bytes).digest("hex"), pages: pdf.getPageCount() };
}
export function createArchitectCorrectionService(deps: { pool: pg.Pool; readPdf: (key: string) => Promise<Buffer> }) {
  async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>) {
    const client = await deps.pool.connect();
    try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
    catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  }
  async function get(devisId: number) {
    return transaction(async client => { await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); return snapshot(client, await load(client, devisId)); });
  }
  async function confirm(devisId: number, input: unknown, actorId: number) {
    const parsed = architectBaselineConfirmationSchema.safeParse(input);
    if (!parsed.success) throw new ArchitectCorrectionError(parsed.error.issues[0].message, 400);
    const request = parsed.data;
    const initial = await get(devisId);
    const row = (await deps.pool.query("SELECT pdf_storage_key FROM devis WHERE id=$1", [devisId])).rows[0];
    const receipt = await pdfReceipt(deps.readPdf, row?.pdf_storage_key);
    if (request.page > receipt.pages) throw new ArchitectCorrectionError("The confirmation page is outside the original PDF.", 400);
    return transaction(async client => {
      const s = await load(client, devisId, true);
      if (version(s) !== request.expectedVersion || initial.version !== request.expectedVersion || s.quotation.pdf_storage_key !== row.pdf_storage_key)
        throw new ArchitectCorrectionError("Quotation changed. Reopen the source confirmation.");
      if (protection(s).blockedReason) throw new ArchitectCorrectionError(protection(s).blockedReason!);
      if (s.baseline) throw new ArchitectCorrectionError("The PDF-backed source baseline is already locked.");
      await client.query(`INSERT INTO quotation_source_baselines(devis_id,source_storage_key,source_file_name,source_digest,ttc,pdf_page,actor_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [devisId, row.pdf_storage_key, s.quotation.pdf_file_name ?? "contractor.pdf", receipt.digest, request.ttc, request.page, actorId]);
      const after = await load(client, devisId);
      await client.query(`INSERT INTO quotation_architect_audit(devis_id,actor_id,operation,before_snapshot,after_snapshot)
        VALUES($1,$2,'baseline',$3,$4)`, [devisId, actorId, JSON.stringify(s), JSON.stringify(after)]);
      return snapshot(client, after);
    });
  }
  async function save(devisId: number, input: unknown, actorId: number) {
    const parsed = architectCorrectionSaveSchema.safeParse(input);
    if (!parsed.success) throw new ArchitectCorrectionError(parsed.error.issues[0].message, 400);
    const { expectedVersion, ...draft } = parsed.data;
    const initial = await get(devisId);
    let sourceDigest: string | null = null;
    if (initial.baseline) {
      const row = (await deps.pool.query("SELECT source_storage_key FROM quotation_source_baselines WHERE devis_id=$1", [devisId])).rows[0];
      sourceDigest = (await pdfReceipt(deps.readPdf, row.source_storage_key)).digest;
    }
    return transaction(async client => {
      const s = await load(client, devisId, true), beforeDraft = draftFrom(s);
      if (version(s) !== expectedVersion) throw new ArchitectCorrectionError("Quotation changed since you opened the editor. Your draft has not been applied.");
      const protectedState = protection(s);
      if (protectedState.blockedReason) throw new ArchitectCorrectionError(protectedState.blockedReason);
      if (s.translation?.status === "processing") throw new ArchitectCorrectionError("Translation is running. Wait for it to finish before saving.");
      if (s.baseline && (s.baseline.source_digest !== sourceDigest || s.baseline.source_storage_key !== s.quotation.pdf_storage_key))
        throw new ArchitectCorrectionError("Original PDF no longer matches its locked source receipt. No correction was applied.");
      let reconciledHeader: ReturnType<typeof previewCorrectionTotals> | null = null;
      if (s.baseline && !protectedState.financialBlockedReason) {
        try {
          const candidate = previewCorrectionTotals(draft);
          if (correctionCents(candidate.ttc) === correctionCents(s.baseline.ttc)
            && (correctionCents(candidate.ht) !== correctionCents(s.quotation.amount_ht ?? "0")
              || correctionCents(candidate.ttc) !== correctionCents(s.quotation.amount_ttc ?? "0"))) reconciledHeader = candidate;
        } catch { /* Text edits may retain incomplete finances; approval still fails closed. */ }
      }
      const financialChanged = !!reconciledHeader || financialProjection(beforeDraft) !== financialProjection(draft);
      if (financialChanged && protectedState.financialBlockedReason) throw new ArchitectCorrectionError(protectedState.financialBlockedReason);
      const ids = draft.lines.filter(l => l.id !== null).map(l => l.id);
      if (ids.length !== s.lines.length || new Set(ids).size !== ids.length || s.lines.some(l => !ids.includes(l.id)))
        throw new ArchitectCorrectionError("Every existing row ID must be retained exactly once. Existing rows cannot be deleted or reassigned.", 400);
      if (new Set(draft.lines.map(l => l.clientKey)).size !== draft.lines.length)
        throw new ArchitectCorrectionError("Each working row needs a unique identity.", 400);
      for (const line of draft.lines) {
        const old = beforeDraft.lines.find(l => l.id === line.id && line.id !== null);
        if (old && (old.clientKey !== line.clientKey || old.kind !== line.kind))
          throw new ArchitectCorrectionError("Existing row identities and financial/contextual kinds cannot be reassigned.", 400);
        if (line.kind === "context" && (line.unitPriceHt === "" || correctionCents(line.totalHt) !== BigInt(0) || correctionCents(line.unitPriceHt) !== BigInt(0)
          || line.included || Number(line.quantity) !== 0)) throw new ArchitectCorrectionError("Context-only rows cannot carry a charge or quantity.", 400);
      }
      let computed: ReturnType<typeof previewCorrectionTotals> | null = null;
      if (financialChanged) {
        if (!s.baseline) throw new ArchitectCorrectionError("Confirm the final TTC directly from the original PDF before a financial correction.", 422);
        try { computed = previewCorrectionTotals(draft); } catch (e) {
          throw new ArchitectCorrectionError(e instanceof Error ? e.message : "Invalid financial batch.", 422);
        }
        if (correctionCents(computed.ttc) !== correctionCents(s.baseline.ttc))
          throw new ArchitectCorrectionError(`Computed TTC ${computed.ttc} does not match locked source TTC ${s.baseline.ttc}. No part of the batch was saved.`, 422, "TTC_MISMATCH");
      }
      await client.query("SELECT set_config('renosud.architect_correction','on',true)");
      const savedLines: ArchitectCorrectionLine[] = [];
      for (let index = 0; index < draft.lines.length; index++) {
        const line = draft.lines[index];
        const values = [devisId, index + 1, line.descriptionFr, line.quantity || null, line.unit, line.unitPriceHt || null, line.totalHt];
        const result = line.id !== null
          ? await client.query(`UPDATE devis_line_items SET line_number=$2,description=$3,quantity=$4,unit=$5,unit_price_ht=$6,total_ht=$7
            WHERE devis_id=$1 AND id=$8 RETURNING id`, [...values, line.id])
          : await client.query(`INSERT INTO devis_line_items(devis_id,line_number,description,quantity,unit,unit_price_ht,total_ht)
            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, values);
        savedLines.push({ ...line, id: result.rows[0].id });
      }
      const savedDraft = { ...draft, lines: savedLines };
      await client.query(`UPDATE devis SET description_fr=$2,amount_ht=COALESCE($3,amount_ht),amount_ttc=COALESCE($4,amount_ttc),updated_at=now() WHERE id=$1`,
        [devisId, draft.headerFr, computed?.ht ?? null, computed?.ttc ?? null]);
      const translationLines = savedLines.map((l, i) => ({ lineNumber: i + 1, originalDescription: l.descriptionFr,
        translation: l.descriptionEn, explanation: l.explanationEn, explanationFr: l.explanationFr, edited: true,
        kind: l.kind, included: l.included, vatRate: l.vatRate }));
      const header = { description: draft.headerEn, descriptionExplanation: draft.explanationEn,
        descriptionExplanationFr: draft.explanationFr, summary: draft.summaryEn, humanReviewed: true,
        workingDiscountHt: draft.discountHt, workingVatRounding: draft.vatRounding ?? "bucket" };
      await client.query(`INSERT INTO devis_translations(devis_id,status,header_translated,line_translations,contexts_version)
        VALUES($1,'edited',$2,$3,1) ON CONFLICT(devis_id) DO UPDATE SET status='edited',
        header_translated=EXCLUDED.header_translated,line_translations=EXCLUDED.line_translations,contexts_version=devis_translations.contexts_version+1,
        approved_at=NULL,approved_by=NULL,approved_by_email=NULL,translated_pdf_storage_key=NULL,combined_pdf_storage_key=NULL,error_message=NULL,updated_at=now()`,
        [devisId, JSON.stringify(header), JSON.stringify(translationLines)]);
      await client.query(`INSERT INTO quotation_architect_state(devis_id,draft) VALUES($1,$2) ON CONFLICT(devis_id)
        DO UPDATE SET draft=EXCLUDED.draft,revision=quotation_architect_state.revision+1,updated_at=now()`, [devisId, JSON.stringify(savedDraft)]);
      const after = await load(client, devisId);
      await client.query(`INSERT INTO quotation_architect_audit(devis_id,actor_id,operation,before_snapshot,after_snapshot)
        VALUES($1,$2,'correction',$3,$4)`, [devisId, actorId, JSON.stringify(s), JSON.stringify(after)]);
      return snapshot(client, after);
    });
  }
  return { get, confirm, save };
}
// Do not construct runtime dependencies while importing pure guard helpers or
// unrelated routes. Some consumers deliberately isolate storage/DB in tests;
// the real dependencies are still required (and fail closed) when invoked.
const defaultService = () => createArchitectCorrectionService({ pool, readPdf: getDocumentBuffer });
export const architectCorrectionService: ReturnType<typeof createArchitectCorrectionService> = {
  get: (...args) => defaultService().get(...args),
  confirm: (...args) => defaultService().confirm(...args),
  save: (...args) => defaultService().save(...args),
};
export async function hasArchitectCorrection(devisId: number) {
  return !!(await pool.query("SELECT 1 FROM quotation_architect_state WHERE devis_id=$1", [devisId])).rows.length;
}
export async function hasQuotationSourceBaseline(devisId: number) {
  return !!(await pool.query("SELECT 1 FROM quotation_source_baselines WHERE devis_id=$1", [devisId])).rows.length;
}
export function correctedFinancialBlocker(draft: ArchitectCorrectionDraft, baseline: { ttc: string } | null, workingTotals?: { ht: string; ttc: string }) {
  if (!baseline) return "Confirm the source TTC directly from the original PDF before approving or sharing the corrected quotation.";
  try {
    const totals = previewCorrectionTotals(draft);
    if (workingTotals && (correctionCents(totals.ht) !== correctionCents(workingTotals.ht) || correctionCents(totals.ttc) !== correctionCents(workingTotals.ttc)))
      return "Working header totals differ from the corrected row/VAT/discount calculation. Reconcile the financial batch before approval or sharing.";
    return correctionCents(totals.ttc) === correctionCents(baseline.ttc) ? null
      : "Working TTC differs from the locked source TTC. Reconcile the complete financial batch before approval or sharing.";
  } catch (e) { return `Complete the actual VAT/discount treatment before approval: ${e instanceof Error ? e.message : "Invalid figures."}`; }
}
export async function architectFinancialBoundary(devisId: number) {
  if (!await hasArchitectCorrection(devisId)) return null;
  const snapshot = await architectCorrectionService.get(devisId);
  if (snapshot.baseline) {
    const receipt = (await pool.query("SELECT source_storage_key FROM quotation_source_baselines WHERE devis_id=$1", [devisId])).rows[0];
    try {
      const digest = (await pdfReceipt(getDocumentBuffer, receipt.source_storage_key)).digest;
      if (digest !== snapshot.baseline.sourceDigest) return "Original PDF bytes no longer match the locked source receipt. Approval and sharing are blocked.";
    } catch { return "The original PDF receipt cannot currently be verified. Restore source access and retry; no content was approved."; }
  }
  return correctedFinancialBlocker(snapshot.draft, snapshot.baseline, snapshot.workingTotals);
}
export async function assertOriginalReceiptBytes(devisId: number, storageKey: string, bytes: Buffer) {
  const row = (await pool.query("SELECT source_storage_key,source_digest FROM quotation_source_baselines WHERE devis_id=$1", [devisId])).rows[0];
  if (row && (row.source_storage_key !== storageKey || row.source_digest !== createHash("sha256").update(bytes).digest("hex")))
    throw new ArchitectCorrectionError("Original PDF does not match its immutable source receipt. A contractual package cannot be generated.");
}
