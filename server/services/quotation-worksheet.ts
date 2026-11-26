import type pg from "pg";
import { pool } from "../db";
import { draftFrom } from "./architect-quotation-correction";
import {
  MEETING_SECTION_LABEL, WORKSHEET_TAGS, computeWorksheet, detectLotHeading, lineKind,
  worksheetCreateSchema, worksheetLineAddSchema, worksheetLinePatchSchema, worksheetSettingsSchema,
  type WorksheetComputation, type WorksheetLineData, type WorksheetTag,
} from "../../shared/quotation-worksheet";

/**
 * Client worksheets: architect-only working copies of a quotation for client
 * meetings. Reads the devis and its extracted lines; never writes to them.
 */
export class WorksheetError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

export interface WorksheetSummary {
  id: number; devisId: number; title: string; meetingDate: string | null; revision: number;
  duplicatedFromId: number | null; createdAt: string; updatedAt: string; createdBy: string | null;
}
export interface WorksheetAuditEntry {
  id: number; action: string; actor: string; at: string; reason: string | null; lineId: number | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
}
export interface WorksheetDetail {
  worksheet: WorksheetSummary & { depositPercent: string | null };
  quotation: { id: number; code: string; number: string | null; date: string | null; projectId: number;
    projectName: string; projectCode: string | null; clientName: string | null; contractorName: string;
    amountHt: string; amountTtc: string };
  lines: WorksheetLineData[];
  computed: WorksheetComputation;
  readOnlyReason: string | null;
  history: WorksheetAuditEntry[];
}

type Client = pg.PoolClient | pg.Pool;
const actorSql = "COALESCE(NULLIF(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email)";
const LINE_COLUMNS = `id, source_line_item_id, position, section, lot_label, description, unit,
  original_quantity, original_unit_price, original_total, vat_rate, client_quantity, client_unit_price, note, tag`;

function toLine(r: any): WorksheetLineData {
  return {
    id: r.id, sourceLineItemId: r.source_line_item_id, position: r.position, section: r.section, lotLabel: r.lot_label,
    description: r.description, unit: r.unit, originalQuantity: r.original_quantity, originalUnitPrice: r.original_unit_price,
    originalTotal: r.original_total, vatRate: r.vat_rate == null ? null : String(Number(r.vat_rate)),
    clientQuantity: r.client_quantity, clientUnitPrice: r.client_unit_price, note: r.note, tag: r.tag,
  };
}
const iso = (v: any) => (v instanceof Date ? v.toISOString() : String(v));
const dateOnly = (v: any) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
function toSummary(r: any): WorksheetSummary & { depositPercent: string | null } {
  return { id: r.id, devisId: r.devis_id, title: r.title, meetingDate: dateOnly(r.meeting_date), revision: r.revision,
    duplicatedFromId: r.duplicated_from_id, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    createdBy: r.created_by ?? null, depositPercent: r.deposit_percent == null ? null : String(Number(r.deposit_percent)) };
}

/** Seed lines from the quotation's extracted lines, never modifying them. */
export async function seedLinesFromQuotation(client: Client, devisId: number) {
  const quotation = (await client.query("SELECT * FROM devis WHERE id=$1", [devisId])).rows[0];
  if (!quotation) throw new WorksheetError("Quotation not found.", 404);
  const rows = (await client.query("SELECT * FROM devis_line_items WHERE devis_id=$1 ORDER BY line_number,id", [devisId])).rows;
  if (!rows.length) throw new WorksheetError("This quotation has no extracted lines yet. Review the extraction before preparing a client worksheet.", 422);
  const state = (await client.query("SELECT * FROM quotation_architect_state WHERE devis_id=$1", [devisId])).rows[0];
  // Same VAT evidence order as the architect editor: saved per-line rate,
  // then a rate printed on that exact row, then the document's explicit rate.
  const draft = draftFrom({ quotation, lines: rows, translation: undefined, baseline: undefined, state });
  const rates = new Map(draft.lines.map(l => [l.id, l.vatRate]));
  const lotName = quotation.lot_id
    ? (await client.query("SELECT COALESCE(NULLIF(trim(concat_ws(' - ', lot_number, description_fr)), ''), 'Lot') AS name FROM lots WHERE id=$1", [quotation.lot_id])).rows[0]?.name
    : null;
  let current = lotName || "General";
  return rows.map((row, index) => {
    current = detectLotHeading(row.description ?? "") ?? current;
    const total = row.total_ht == null ? null : String(row.total_ht);
    let quantity: string | null = row.quantity == null ? null : String(row.quantity);
    let unitPrice: string | null = row.unit_price_ht == null ? null : String(row.unit_price_ht);
    let unit: string | null = row.unit ?? null;
    // Unpriced: no unit price and nothing charged. Never shown as €0.
    const priced = !(unitPrice == null && Number(total ?? 0) === 0);
    if (priced && quantity == null && unitPrice == null) { quantity = "1"; unitPrice = total; unit = unit ?? "ens"; }
    if (priced && quantity != null && unitPrice == null && Number(quantity) !== 0) unitPrice = (Number(total) / Number(quantity)).toFixed(2);
    if (priced && quantity == null && unitPrice != null) quantity = "1";
    const rate = rates.get(row.id);
    return {
      sourceLineItemId: row.id as number, position: (index + 1) * 10, section: "lot" as const, lotLabel: current,
      description: String(row.description ?? "").trim() || `Line ${row.line_number}`, unit,
      originalQuantity: quantity, originalUnitPrice: priced ? unitPrice : null, originalTotal: priced ? total : null,
      vatRate: rate && rate.trim() ? rate : null,
      clientQuantity: quantity, clientUnitPrice: priced ? unitPrice : null,
    };
  });
}

async function insertLines(client: pg.PoolClient, worksheetId: number, lines: Array<Partial<WorksheetLineData> & { position: number }>) {
  for (const l of lines) {
    await client.query(`INSERT INTO quotation_worksheet_lines(worksheet_id,source_line_item_id,position,section,lot_label,description,unit,
      original_quantity,original_unit_price,original_total,vat_rate,client_quantity,client_unit_price,note,tag)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [worksheetId, l.sourceLineItemId ?? null, l.position, l.section ?? "lot", l.lotLabel, l.description, l.unit ?? null,
        l.originalQuantity ?? null, l.originalUnitPrice ?? null, l.originalTotal ?? null, l.vatRate ?? null,
        l.clientQuantity ?? null, l.clientUnitPrice ?? null, l.note ?? null, l.tag ?? null]);
  }
}

async function audit(client: pg.PoolClient, w: { id: number; devis_id: number }, actorId: number, action: string,
  data: { lineId?: number | null; reason?: string | null; before?: unknown; after?: unknown } = {}) {
  await client.query(`INSERT INTO quotation_worksheet_audit(worksheet_id,devis_id,line_id,actor_user_id,action,reason,before,after)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [w.id, w.devis_id, data.lineId ?? null, actorId, action, data.reason ?? null,
    data.before == null ? null : JSON.stringify(data.before), data.after == null ? null : JSON.stringify(data.after)]);
}

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new WorksheetError(r.error.issues[0]?.message ?? "Invalid request.", 400);
  return r.data;
}

export function createWorksheetService(deps: { pool: pg.Pool }) {
  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>) {
    const c = await deps.pool.connect();
    try { await c.query("BEGIN"); const v = await fn(c); await c.query("COMMIT"); return v; }
    catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  }
  async function writableQuotation(c: pg.PoolClient, devisId: number) {
    const row = (await c.query(`SELECT d.id,d.project_id,p.archived_at FROM devis d JOIN projects p ON p.id=d.project_id
      WHERE d.id=$1 FOR SHARE OF d,p`, [devisId])).rows[0];
    if (!row) throw new WorksheetError("Quotation not found.", 404);
    if (row.archived_at) throw new WorksheetError("Archived projects are read-only.");
    return row;
  }
  async function lockWorksheet(c: pg.PoolClient, id: number, expectedRevision: number) {
    const w = (await c.query("SELECT * FROM quotation_worksheets WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!w) throw new WorksheetError("Worksheet not found.", 404);
    await writableQuotation(c, w.devis_id);
    if (w.revision !== expectedRevision) throw new WorksheetError("This worksheet was changed in another window. Reload it to see the latest figures.");
    return w;
  }
  async function bump(c: pg.PoolClient, id: number) {
    await c.query("UPDATE quotation_worksheets SET revision=revision+1, updated_at=now() WHERE id=$1", [id]);
  }

  async function list(devisId: number): Promise<WorksheetSummary[]> {
    const rows = (await deps.pool.query(`SELECT w.*, ${actorSql} AS created_by FROM quotation_worksheets w
      LEFT JOIN users u ON u.id=w.created_by_user_id WHERE w.devis_id=$1 ORDER BY w.id DESC`, [devisId])).rows;
    return rows.map(toSummary);
  }

  async function get(id: number, client: Client = deps.pool): Promise<WorksheetDetail> {
    const w = (await client.query(`SELECT w.*, ${actorSql} AS created_by FROM quotation_worksheets w
      LEFT JOIN users u ON u.id=w.created_by_user_id WHERE w.id=$1`, [id])).rows[0];
    if (!w) throw new WorksheetError("Worksheet not found.", 404);
    const q = (await client.query(`SELECT d.id,d.devis_code,d.devis_number,d.amount_ht,d.amount_ttc,d.date_sent,
      d.ai_extracted_data->>'date' AS extracted_date, d.project_id, p.name AS project_name, p.code AS project_code,
      p.client_name, p.archived_at, c.name AS contractor_name
      FROM devis d JOIN projects p ON p.id=d.project_id JOIN contractors c ON c.id=d.contractor_id WHERE d.id=$1`, [w.devis_id])).rows[0];
    if (!q) throw new WorksheetError("Quotation not found.", 404);
    const lines = (await client.query(`SELECT ${LINE_COLUMNS} FROM quotation_worksheet_lines WHERE worksheet_id=$1 ORDER BY position,id`, [id])).rows.map(toLine);
    const summary = toSummary(w);
    const history = (await client.query(`SELECT a.*, ${actorSql} AS actor FROM quotation_worksheet_audit a
      LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.worksheet_id=$1 ORDER BY a.id DESC LIMIT 200`, [id])).rows;
    const date = typeof q.extracted_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(q.extracted_date) ? q.extracted_date.slice(0, 10) : dateOnly(q.date_sent);
    return {
      worksheet: summary,
      quotation: { id: q.id, code: q.devis_code, number: q.devis_number, date, projectId: q.project_id, projectName: q.project_name,
        projectCode: q.project_code, clientName: q.client_name, contractorName: q.contractor_name,
        amountHt: String(q.amount_ht), amountTtc: String(q.amount_ttc) },
      lines,
      computed: computeWorksheet(lines, summary.depositPercent),
      readOnlyReason: q.archived_at ? "Archived projects are read-only." : null,
      history: history.map(h => ({ id: h.id, action: h.action, actor: h.actor ?? "Architect", at: iso(h.created_at),
        reason: h.reason, lineId: h.line_id, before: h.before, after: h.after })),
    };
  }

  async function create(devisId: number, input: unknown, actorId: number) {
    const body = parse(worksheetCreateSchema, input);
    const id = await tx(async c => {
      const q = await writableQuotation(c, devisId);
      const seeded = await seedLinesFromQuotation(c, devisId);
      const deposit = (await c.query("SELECT acompte_percent FROM devis WHERE id=$1", [devisId])).rows[0]?.acompte_percent ?? null;
      const w = (await c.query(`INSERT INTO quotation_worksheets(devis_id,project_id,title,meeting_date,deposit_percent,created_by_user_id)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [devisId, q.project_id, body.title, body.meetingDate ?? null, deposit, actorId])).rows[0];
      await insertLines(c, w.id, seeded);
      await audit(c, w, actorId, "create", { after: { title: body.title, lines: seeded.length } });
      return w.id as number;
    });
    return get(id);
  }

  async function duplicate(id: number, input: unknown, actorId: number) {
    const body = parse(worksheetCreateSchema, input);
    const newId = await tx(async c => {
      const src = (await c.query("SELECT * FROM quotation_worksheets WHERE id=$1 FOR SHARE", [id])).rows[0];
      if (!src) throw new WorksheetError("Worksheet not found.", 404);
      await writableQuotation(c, src.devis_id);
      const w = (await c.query(`INSERT INTO quotation_worksheets(devis_id,project_id,title,meeting_date,deposit_percent,duplicated_from_id,created_by_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [src.devis_id, src.project_id, body.title, body.meetingDate ?? null, src.deposit_percent, src.id, actorId])).rows[0];
      const lines = (await c.query(`SELECT ${LINE_COLUMNS} FROM quotation_worksheet_lines WHERE worksheet_id=$1 ORDER BY position,id`, [id])).rows.map(toLine);
      await insertLines(c, w.id, lines);
      await audit(c, w, actorId, "duplicate", { after: { title: body.title, fromWorksheetId: src.id, fromTitle: src.title } });
      return w.id as number;
    });
    return get(newId);
  }

  async function updateSettings(id: number, input: unknown, actorId: number) {
    const body = parse(worksheetSettingsSchema, input);
    await tx(async c => {
      const w = await lockWorksheet(c, id, body.expectedRevision);
      const before = { title: w.title, meetingDate: dateOnly(w.meeting_date), depositPercent: w.deposit_percent };
      const after = {
        title: body.title ?? w.title,
        meetingDate: body.meetingDate === undefined ? dateOnly(w.meeting_date) : body.meetingDate,
        depositPercent: body.depositPercent === undefined ? w.deposit_percent : body.depositPercent,
      };
      await c.query("UPDATE quotation_worksheets SET title=$2, meeting_date=$3, deposit_percent=$4 WHERE id=$1",
        [id, after.title, after.meetingDate, after.depositPercent]);
      await bump(c, id);
      await audit(c, w, actorId, "update_settings", { before, after });
    });
    return get(id);
  }

  async function updateLine(id: number, lineId: number, input: unknown, actorId: number) {
    const body = parse(worksheetLinePatchSchema, input);
    await tx(async c => {
      const w = await lockWorksheet(c, id, body.expectedRevision);
      const row = (await c.query(`SELECT ${LINE_COLUMNS} FROM quotation_worksheet_lines WHERE id=$1 AND worksheet_id=$2 FOR UPDATE`, [lineId, id])).rows[0];
      if (!row) throw new WorksheetError("Line not found.", 404);
      const line = toLine(row);
      const kind = lineKind(line);
      const next: WorksheetLineData = { ...line };
      if (body.clientQuantity !== undefined) next.clientQuantity = body.clientQuantity;
      if (body.clientUnitPrice !== undefined) next.clientUnitPrice = body.clientUnitPrice;
      if (body.vatRate !== undefined) next.vatRate = body.vatRate;
      if (body.note !== undefined) next.note = body.note;
      if (body.tag !== undefined) next.tag = body.tag as WorksheetTag | null;
      if (body.lotLabel !== undefined) {
        if (line.section === "meeting") throw new WorksheetError("Meeting additions stay in their own section.", 400);
        next.lotLabel = body.lotLabel;
      }
      if (body.description !== undefined || body.unit !== undefined) {
        if (kind !== "added") throw new WorksheetError("The contractor's wording is kept as quoted. Add a note to explain the change instead.", 400);
        if (body.description !== undefined) next.description = body.description;
        if (body.unit !== undefined) next.unit = body.unit;
      }
      if (kind === "priced" && (next.clientQuantity == null || next.clientUnitPrice == null))
        throw new WorksheetError("Enter a quantity and a unit price. To remove the line, set the quantity to 0.", 400);
      const changed = (Object.keys(next) as Array<keyof WorksheetLineData>).filter(k => next[k] !== line[k]);
      if (!changed.length) return;
      await c.query(`UPDATE quotation_worksheet_lines SET client_quantity=$2, client_unit_price=$3, vat_rate=$4, note=$5, tag=$6,
        lot_label=$7, description=$8, unit=$9 WHERE id=$1`, [lineId, next.clientQuantity, next.clientUnitPrice, next.vatRate,
        next.note, next.tag, next.lotLabel, next.description, next.unit]);
      await bump(c, id);
      const removed = kind !== "added" && next.clientQuantity != null && Number(next.clientQuantity) === 0 && Number(line.clientQuantity ?? 1) !== 0;
      const restored = kind !== "added" && Number(line.clientQuantity ?? 1) === 0 && next.clientQuantity != null && Number(next.clientQuantity) !== 0;
      const pick = (l: WorksheetLineData) => Object.fromEntries(changed.map(k => [k, l[k]]));
      await audit(c, w, actorId, removed ? "remove_line" : restored ? "restore_line" : "update_line",
        { lineId, reason: body.reason ?? next.note ?? null, before: pick(line), after: pick(next) });
    });
    return get(id);
  }

  async function addLine(id: number, input: unknown, actorId: number) {
    const body = parse(worksheetLineAddSchema, input);
    await tx(async c => {
      const w = await lockWorksheet(c, id, body.expectedRevision);
      let lotLabel = MEETING_SECTION_LABEL;
      let position: number;
      if (body.section === "lot") {
        if (!body.lotLabel) throw new WorksheetError("Choose the lot for this line.", 400);
        lotLabel = body.lotLabel;
        const last = (await c.query("SELECT max(position) AS p FROM quotation_worksheet_lines WHERE worksheet_id=$1 AND section='lot' AND lot_label=$2", [id, lotLabel])).rows[0]?.p;
        if (last == null) throw new WorksheetError("That lot is not on this worksheet.", 400);
        // Make room directly after the lot's last line.
        await c.query("UPDATE quotation_worksheet_lines SET position=position+1 WHERE worksheet_id=$1 AND position>$2", [id, last]);
        position = Number(last) + 1;
      } else {
        position = Number((await c.query("SELECT COALESCE(max(position),0) AS p FROM quotation_worksheet_lines WHERE worksheet_id=$1", [id])).rows[0].p) + 10;
      }
      const inserted = (await c.query(`INSERT INTO quotation_worksheet_lines(worksheet_id,position,section,lot_label,description,unit,vat_rate,client_quantity,client_unit_price,note,tag)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [id, position, body.section, lotLabel, body.description, body.unit ?? null,
        body.vatRate, body.clientQuantity, body.clientUnitPrice, body.note ?? null, body.tag ?? null])).rows[0];
      await bump(c, id);
      await audit(c, w, actorId, "add_line", { lineId: inserted.id, reason: body.note ?? null,
        after: { section: body.section, lotLabel, description: body.description, unit: body.unit ?? null, clientQuantity: body.clientQuantity,
          clientUnitPrice: body.clientUnitPrice, vatRate: body.vatRate, tag: body.tag ?? null } });
    });
    return get(id);
  }

  async function deleteAddedLine(id: number, lineId: number, input: unknown, actorId: number) {
    const expectedRevision = Number((input as any)?.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) throw new WorksheetError("Reload the worksheet and try again.", 400);
    await tx(async c => {
      const w = await lockWorksheet(c, id, expectedRevision);
      const row = (await c.query(`SELECT ${LINE_COLUMNS} FROM quotation_worksheet_lines WHERE id=$1 AND worksheet_id=$2 FOR UPDATE`, [lineId, id])).rows[0];
      if (!row) throw new WorksheetError("Line not found.", 404);
      const line = toLine(row);
      if (lineKind(line) !== "added") throw new WorksheetError("Lines from the contractor's quotation are removed by setting the quantity to 0, so the original stays visible.", 400);
      await c.query("DELETE FROM quotation_worksheet_lines WHERE id=$1", [lineId]);
      await bump(c, id);
      await audit(c, w, actorId, "delete_line", { lineId, before: line });
    });
    return get(id);
  }

  return { list, get, create, duplicate, updateSettings, updateLine, addLine, deleteAddedLine };
}

let service: ReturnType<typeof createWorksheetService> | null = null;
export const worksheetService = () => (service ??= createWorksheetService({ pool }));
export { WORKSHEET_TAGS };
