import { createHash } from "crypto";
import type pg from "pg";
import { pool } from "../db";
import { draftFrom } from "./architect-quotation-correction";
import { GeminiTimeoutError, generateWithGemini, isGeminiConfigured } from "./gemini";
import {
  aiCheckResponseSchema, checkDismissSchema, checkNoteText, checkReopenSchema, checkToWorksheetSchema,
  computeQuotationChecks, documentVatRate, lotLabelsFor,
  type CheckCategory, type CheckLineInput, type CheckReview, type QuotationCheckPoint, type QuotationChecksResult,
} from "../../shared/quotation-checks";

export class CheckError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
type Client = pg.Pool | pg.PoolClient;
type Generate = (input: { systemPrompt: string; userContent: string }) => Promise<{ text: string; modelId: string }>;

const actorSql = "COALESCE(NULLIF(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email)";
const iso = (v: any) => (v instanceof Date ? v.toISOString() : String(v));
const str = (v: unknown) => (v == null ? null : String(v));

interface Loaded {
  quotation: any;
  archived: boolean;
  lines: CheckLineInput[];
  lotFallback: string;
  fingerprint: string;
}

/** Reads the quotation's current lines with the VAT rate the architect editor applies. */
async function loadQuotation(client: Client, devisId: number): Promise<Loaded> {
  const quotation = (await client.query(`SELECT d.*, p.archived_at FROM devis d JOIN projects p ON p.id=d.project_id WHERE d.id=$1`, [devisId])).rows[0];
  if (!quotation) throw new CheckError("Quotation not found.", 404);
  const rows = (await client.query("SELECT * FROM devis_line_items WHERE devis_id=$1 ORDER BY line_number,id", [devisId])).rows;
  const state = (await client.query("SELECT * FROM quotation_architect_state WHERE devis_id=$1", [devisId])).rows[0];
  const draft = draftFrom({ quotation, lines: rows, translation: undefined, baseline: undefined, state });
  const rates = new Map(draft.lines.map(l => [l.id, l.vatRate]));
  const lotFallback = quotation.lot_id
    ? (await client.query("SELECT COALESCE(NULLIF(trim(concat_ws(' - ', lot_number, description_fr)), ''), 'Lot') AS name FROM lots WHERE id=$1", [quotation.lot_id])).rows[0]?.name ?? "General"
    : "General";
  const lines: CheckLineInput[] = rows.map(r => {
    const rate = rates.get(r.id);
    return { id: r.id, lineNumber: r.line_number, description: String(r.description ?? ""), quantity: str(r.quantity), unit: r.unit ?? null,
      unitPriceHt: str(r.unit_price_ht), totalHt: str(r.total_ht), vatRate: rate && String(rate).trim() ? String(rate) : null };
  });
  const fingerprint = createHash("sha256").update(JSON.stringify(lines)).digest("hex");
  return { quotation, archived: !!quotation.archived_at, lines, lotFallback, fingerprint };
}

function rulePoints(q: Loaded): QuotationCheckPoint[] {
  return computeQuotationChecks(q.lines, { documentVatRate: documentVatRate(str(q.quotation.amount_ht), str(q.quotation.amount_ttc)), lotFallback: q.lotFallback });
}

const AI_CATEGORY: Record<string, CheckCategory> = { annotation: "ai_annotation", overlap: "ai_overlap", other: "ai_other" };
const AI_SYSTEM_PROMPT = `You review French building-works quotations (devis) for an architect preparing a client meeting.
Find points worth raising with the client or contractor that simple arithmetic rules would miss, such as:
- contractor annotations left in the text (ticks ☑ ✓, question marks "?", "à confirmer", "option", "à définir", "sous réserve"),
- scope that overlaps by meaning between lines or lots (the same work described differently),
- anything else genuinely worth asking about (missing quantities for priced work, provisional sums, ambiguous inclusions).
Do NOT repeat the points already found, listed in the input. Do not comment on prices being high or low.
Reply with JSON only, no prose and no code fences, in exactly this shape:
{"points":[{"category":"annotation"|"overlap"|"other","lineNumbers":[<line numbers from the input>],"finding":"<what you found, in English, one or two sentences>","suggestedAction":"<what the architect should ask or check, in English, one sentence>"}]}
Return {"points":[]} when there is nothing worth raising. At most 15 points.`;

export function parseAiPoints(text: string, q: Loaded, runId: number): QuotationCheckPoint[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  const parsed = aiCheckResponseSchema.parse(JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned));
  const byNumber = new Map(q.lines.map(l => [l.lineNumber, l]));
  const lots = lotLabelsFor(q.lines, q.lotFallback);
  const out: QuotationCheckPoint[] = [];
  parsed.points.forEach((p, i) => {
    const lines = Array.from(new Set(p.lineNumbers)).map(n => byNumber.get(n)).filter((l): l is CheckLineInput => !!l);
    if (!lines.length) return; // Points about lines that do not exist are dropped, never guessed.
    out.push({
      key: `ai:${runId}:${i}`, source: "ai", category: AI_CATEGORY[p.category], finding: p.finding, suggestedAction: p.suggestedAction,
      lines: lines.map(l => ({ id: l.id, lineNumber: l.lineNumber, lot: lots.get(l.id)!, description: l.description.replace(/\s+/g, " ").trim().slice(0, 140) })),
    });
  });
  return out;
}

/** Failure categories shown to the architect; provider messages are never echoed. */
export function aiFailure(error: unknown): string {
  if (error instanceof GeminiTimeoutError) return "The AI service did not answer in time. Try again shortly.";
  if (error instanceof SyntaxError || (error as any)?.name === "ZodError") return "The AI service returned an answer that could not be read. Try again.";
  const status = /Gemini API error (\d{3})/.exec(error instanceof Error ? error.message : "")?.[1];
  if (status === "402") return "The AI service account has run out of credit. Top it up in Google AI Studio, then try again.";
  if (status === "429" || status === "503") return "The AI service is busy. Try again shortly.";
  return "The AI service could not be reached. Try again shortly.";
}

export function createQuotationChecksService(deps: { pool: pg.Pool; generate?: Generate; aiConfigured?: () => boolean }) {
  const generate = deps.generate ?? generateWithGemini;
  const aiConfigured = deps.aiConfigured ?? isGeminiConfigured;

  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>) {
    const c = await deps.pool.connect();
    try { await c.query("BEGIN"); const v = await fn(c); await c.query("COMMIT"); return v; }
    catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  }
  /** Serialises decisions on one quotation's points. */
  const lockDevis = (c: pg.PoolClient, devisId: number) => c.query("SELECT pg_advisory_xact_lock(hashtext('quotation_checks'), $1)", [devisId]);

  async function latestAiRun(client: Client, devisId: number) {
    return (await client.query("SELECT * FROM quotation_check_ai_runs WHERE devis_id=$1 ORDER BY id DESC LIMIT 1", [devisId])).rows[0] ?? null;
  }
  async function latestSuccessfulAi(client: Client, devisId: number) {
    return (await client.query("SELECT * FROM quotation_check_ai_runs WHERE devis_id=$1 AND status='succeeded' ORDER BY id DESC LIMIT 1", [devisId])).rows[0] ?? null;
  }
  async function currentPoints(client: Client, q: Loaded) {
    const ai = await latestSuccessfulAi(client, q.quotation.id);
    return [...rulePoints(q), ...((ai?.points as QuotationCheckPoint[] | null) ?? [])];
  }
  async function reviews(client: Client, devisId: number) {
    return (await client.query(`SELECT r.*, ${actorSql} AS actor FROM quotation_check_reviews r LEFT JOIN users u ON u.id=r.actor_user_id
      WHERE r.devis_id=$1 ORDER BY r.id`, [devisId])).rows;
  }
  /** Latest dismiss/reopen decision per key (sending to a worksheet does not change open/dismissed). */
  function decisions(rows: any[]) {
    const state = new Map<string, any>();
    for (const r of rows) if (r.action !== "added_to_worksheet") state.set(r.point_key, r);
    return state;
  }

  async function get(devisId: number, client: Client = deps.pool): Promise<QuotationChecksResult> {
    const q = await loadQuotation(client, devisId);
    const rules = rulePoints(q);
    const lastRun = await latestAiRun(client, devisId);
    const okRun = lastRun?.status === "succeeded" ? lastRun : await latestSuccessfulAi(client, devisId);
    const aiPoints = (okRun?.points as QuotationCheckPoint[] | null) ?? [];
    const all = [...rules, ...aiPoints];
    const rows = await reviews(client, devisId);
    const decided = decisions(rows);
    const isDismissed = (key: string) => decided.get(key)?.action === "dismissed";
    const sent: QuotationChecksResult["sentToWorksheet"] = {};
    for (const r of rows) if (r.action === "added_to_worksheet") sent[r.point_key] = { worksheetId: r.worksheet_id, at: iso(r.created_at) };
    const dismissed = Array.from(decided.values()).filter(r => r.action === "dismissed").map(r => {
      // Dismissed points stay on record even when the lines have since changed.
      const point = all.find(p => p.key === r.point_key) ?? (r.point as QuotationCheckPoint);
      return { ...point, reason: r.reason, dismissedBy: r.actor ?? "Architect", dismissedAt: iso(r.created_at) };
    });
    const history: CheckReview[] = rows.slice().reverse().slice(0, 200).map(r => ({
      id: r.id, key: r.point_key, action: r.action, reason: r.reason, worksheetId: r.worksheet_id,
      actor: r.actor ?? "Architect", at: iso(r.created_at), point: r.point,
    }));
    return {
      devisId,
      open: all.filter(p => !isDismissed(p.key)),
      dismissed,
      sentToWorksheet: sent,
      ai: {
        status: lastRun ? lastRun.status : "none",
        at: lastRun ? iso(lastRun.created_at) : null,
        error: lastRun?.status === "failed" ? lastRun.error : null,
        stale: !!okRun && okRun.lines_fingerprint !== q.fingerprint,
        available: aiConfigured(),
      },
      history,
      readOnlyReason: q.archived ? "Archived projects are read-only." : null,
    };
  }

  /** Open points only, for the worksheet's Excel export. */
  async function openPoints(devisId: number) {
    return (await get(devisId)).open;
  }

  async function writable(c: pg.PoolClient, devisId: number) {
    await lockDevis(c, devisId);
    const q = await loadQuotation(c, devisId);
    if (q.archived) throw new CheckError("Archived projects are read-only.");
    return q;
  }
  function parse<T>(schema: { safeParse: (v: unknown) => any }, input: unknown): T {
    const r = schema.safeParse(input);
    if (!r.success) throw new CheckError(r.error.issues[0]?.message ?? "Invalid request.", 400);
    return r.data;
  }
  async function record(c: pg.PoolClient, devisId: number, point: QuotationCheckPoint, action: string, actorId: number, extra: { reason?: string | null; worksheetId?: number | null } = {}) {
    await c.query(`INSERT INTO quotation_check_reviews(devis_id,point_key,action,reason,worksheet_id,point,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [devisId, point.key, action, extra.reason ?? null, extra.worksheetId ?? null, JSON.stringify(point), actorId]);
  }

  async function dismiss(devisId: number, input: unknown, actorId: number) {
    const body = parse<{ key: string; reason: string }>(checkDismissSchema, input);
    await tx(async c => {
      const q = await writable(c, devisId);
      const point = (await currentPoints(c, q)).find(p => p.key === body.key);
      if (!point) throw new CheckError("This point no longer applies to the quotation's current lines. Reload the list.");
      if (decisions(await reviews(c, devisId)).get(body.key)?.action === "dismissed") throw new CheckError("This point is already dismissed.");
      await record(c, devisId, point, "dismissed", actorId, { reason: body.reason });
    });
    return get(devisId);
  }

  async function reopen(devisId: number, input: unknown, actorId: number) {
    const body = parse<{ key: string }>(checkReopenSchema, input);
    await tx(async c => {
      await writable(c, devisId);
      const last = decisions(await reviews(c, devisId)).get(body.key);
      if (last?.action !== "dismissed") throw new CheckError("This point is not dismissed.");
      await record(c, devisId, last.point as QuotationCheckPoint, "reopened", actorId);
    });
    return get(devisId);
  }

  /** Appends the point to the notes of the worksheet lines it concerns. */
  async function addToWorksheet(devisId: number, input: unknown, actorId: number) {
    const body = parse<{ key: string; worksheetId: number }>(checkToWorksheetSchema, input);
    await tx(async c => {
      const q = await writable(c, devisId);
      const point = (await currentPoints(c, q)).find(p => p.key === body.key);
      if (!point) throw new CheckError("This point no longer applies to the quotation's current lines. Reload the list.");
      const w = (await c.query("SELECT * FROM quotation_worksheets WHERE id=$1 FOR UPDATE", [body.worksheetId])).rows[0];
      if (!w || w.devis_id !== devisId) throw new CheckError("Worksheet not found for this quotation.", 404);
      const rows = (await c.query(`SELECT id, note FROM quotation_worksheet_lines WHERE worksheet_id=$1 AND source_line_item_id = ANY($2::int[]) ORDER BY position,id FOR UPDATE`,
        [w.id, point.lines.map(l => l.id)])).rows;
      if (!rows.length) throw new CheckError("None of this point's lines are in that worksheet. It may have been prepared before the quotation's lines changed.", 422);
      const text = checkNoteText(point);
      let changed = 0;
      for (const r of rows) {
        if ((r.note ?? "").includes(text)) continue;
        const note = r.note ? `${r.note}\n${text}` : text;
        await c.query("UPDATE quotation_worksheet_lines SET note=$1 WHERE id=$2", [note, r.id]);
        await c.query(`INSERT INTO quotation_worksheet_audit(worksheet_id,devis_id,line_id,actor_user_id,action,reason,before,after)
          VALUES($1,$2,$3,$4,'update_line',$5,$6,$7)`, [w.id, devisId, r.id, actorId, "Added from points to check",
          JSON.stringify({ note: r.note }), JSON.stringify({ note })]);
        changed++;
      }
      if (!changed) throw new CheckError("This point is already in that worksheet's notes.");
      await c.query("UPDATE quotation_worksheets SET revision=revision+1, updated_at=now() WHERE id=$1", [w.id]);
      await record(c, devisId, point, "added_to_worksheet", actorId, { worksheetId: w.id });
    });
    return get(devisId);
  }

  /**
   * Optional AI pass. Any failure is recorded and reported; rule points are
   * always returned, so the list degrades to deterministic-only.
   */
  async function runAi(devisId: number, actorId: number) {
    if (!aiConfigured()) throw new CheckError("AI suggestions are not configured on this server.", 503);
    const q = await loadQuotation(deps.pool, devisId);
    if (q.archived) throw new CheckError("Archived projects are read-only.");
    if (!q.lines.length) throw new CheckError("This quotation has no extracted lines yet.", 422);
    const lots = lotLabelsFor(q.lines, q.lotFallback);
    const known = rulePoints(q).map(p => `- ${p.finding} (lines ${p.lines.map(l => l.lineNumber).join(", ")})`);
    const userContent = [
      `Quotation ${q.quotation.devis_number ?? q.quotation.devis_code} — total HT ${q.quotation.amount_ht}, TTC ${q.quotation.amount_ttc}.`,
      "Lines (number | lot | quantity unit | unit price HT | total HT | description):",
      ...q.lines.map(l => `${l.lineNumber} | ${lots.get(l.id)} | ${l.quantity ?? "-"} ${l.unit ?? ""} | ${l.unitPriceHt ?? "-"} | ${l.totalHt ?? "-"} | ${l.description.replace(/\s+/g, " ").slice(0, 700)}`),
      "", "Points already found (do not repeat):", ...(known.length ? known : ["- none"]),
    ].join("\n");
    const run = (await deps.pool.query(`INSERT INTO quotation_check_ai_runs(devis_id,status,lines_fingerprint,actor_user_id) VALUES($1,'failed',$2,$3) RETURNING id`,
      [devisId, q.fingerprint, actorId])).rows[0];
    try {
      const out = await generate({ systemPrompt: AI_SYSTEM_PROMPT, userContent });
      const points = parseAiPoints(out.text, q, run.id);
      await deps.pool.query("UPDATE quotation_check_ai_runs SET status='succeeded', model_id=$2, points=$3 WHERE id=$1", [run.id, out.modelId, JSON.stringify(points)]);
    } catch (error) {
      console.warn(`[quotation-checks] AI suggestions failed for devis ${devisId}: ${error instanceof Error ? error.name : "unknown"}`);
      await deps.pool.query("UPDATE quotation_check_ai_runs SET error=$2 WHERE id=$1", [run.id, aiFailure(error)]);
    }
    return get(devisId);
  }

  return { get, openPoints, dismiss, reopen, addToWorksheet, runAi };
}

let service: ReturnType<typeof createQuotationChecksService> | null = null;
export const quotationChecksService = () => (service ??= createQuotationChecksService({ pool }));
