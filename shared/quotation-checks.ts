import { z } from "zod";
import { detectLotHeading } from "./quotation-worksheet";

/**
 * Automatic "points to check" on a contractor quotation.
 *
 * Deterministic rules run on the quotation's current lines every time the
 * list is read, so they always reflect the latest extraction. Each point has
 * a stable key built from its category, the lines involved and the figures
 * that triggered it: dismissing a point records that key, and if the lines
 * change the point comes back as a new one. Nothing here changes the
 * quotation or its figures.
 */

export const CHECK_CATEGORIES = {
  duplicate_scope: "Possible duplicate scope",
  duplicate_equipment: "Possible duplicate item",
  unpriced_line: "Unpriced line",
  vat_mention: "VAT rate mentioned differs",
  arithmetic: "Quantity × price ≠ total",
  ai_annotation: "Contractor annotation",
  ai_overlap: "Overlapping scope",
  ai_other: "Other observation",
} as const;
export type CheckCategory = keyof typeof CHECK_CATEGORIES;
export const AI_CATEGORIES = ["ai_annotation", "ai_overlap", "ai_other"] as const;

export interface CheckLineInput {
  id: number;
  lineNumber: number;
  description: string;
  quantity: string | null;
  unit: string | null;
  unitPriceHt: string | null;
  totalHt: string | null;
  /** The VAT rate the quotation applies to this line, when known. */
  vatRate: string | null;
}
export interface CheckLineRef { id: number; lineNumber: number; lot: string; description: string }
export interface QuotationCheckPoint {
  key: string;
  source: "rule" | "ai";
  category: CheckCategory;
  lines: CheckLineRef[];
  finding: string;
  suggestedAction: string;
}

const MAX_DESCRIPTION = 140;
const short = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_DESCRIPTION ? `${t.slice(0, MAX_DESCRIPTION - 1)}…` : t;
};
const num = (v: string | null) => (v == null || v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const fmtQty = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)))).replace(".", ",");
const fmtEur = (v: number) => `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const fmtRate = (v: number) => `${String(Number(v.toFixed(3))).replace(".", ",")} %`;
const normUnit = (u: string | null) => (u ?? "").toLowerCase().replace(/[²2]$/, "2").replace(/[^a-z0-9]/g, "");
/** Units that count pieces/lump sums: small equal counts are too common to flag. */
const COUNT_UNITS = new Set(["", "u", "un", "unite", "ens", "ensemble", "ft", "ff", "forfait", "pce", "piece", "pc", "h", "heure", "j", "jour"]);

/** Assigns each line to the lot heading most recently seen above it. */
export function lotLabelsFor(lines: CheckLineInput[], fallback = "General"): Map<number, string> {
  let current = fallback;
  const seen: string[] = [];
  const out = new Map<number, string>();
  for (const l of lines) {
    const heading = detectLotHeading(l.description);
    if (heading) {
      // A heading cut differently on another row ("REVETEMENT DE SOL (SAUF"
      // vs "…(SAUF MURAL CARRELAGE") is the same lot.
      const key = heading.toLowerCase();
      current = seen.find(s => s.toLowerCase().startsWith(key) || key.startsWith(s.toLowerCase())) ?? heading;
      if (!seen.includes(current)) seen.push(current);
    }
    out.set(l.id, current);
  }
  return out;
}

const STOP = new Set(["les", "des", "une", "pour", "avec", "sur", "dans", "par", "compris", "the", "and", "with", "for", "lot", "aux", "est", "sont", "tout"]);
/** Words of a description without its lot heading, accents or punctuation. */
export function descriptionTokens(description: string): string[] {
  let text = description.trim();
  const heading = detectLotHeading(text);
  if (heading) {
    const m = /^lot\b[\s:.-]*/i.exec(text);
    text = text.slice(m ? m[0].length : 0);
    const words = heading.split(/\s+/).length;
    text = text.split(/\s+/).slice(words).join(" ");
  }
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/(\d)[\s,.](\d)/g, "$1$2").split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w));
}
function similarity(a: string[], b: string[]) {
  const A = new Set(a), B = new Set(b);
  let shared = 0;
  A.forEach(w => { if (B.has(w)) shared++; });
  return shared / Math.max(1, A.size + B.size - shared);
}

const VAT_MENTION = /(?:t\.?v\.?a\.?|vat)[^%\n]{0,25}?(\d{1,2}(?:[.,]\d{1,2})?)\s*%|(\d{1,2}(?:[.,]\d{1,2})?)\s*%[^%\n]{0,12}?(?:t\.?v\.?a\.?|vat)\b/gi;
/** Every VAT rate written in a description ("TVA 5,5 %", "5.5% TVA"). */
export function mentionedVatRates(description: string): number[] {
  const out = new Set<number>();
  for (const m of Array.from(description.matchAll(VAT_MENTION))) {
    const r = Number((m[1] ?? m[2]).replace(",", "."));
    if (Number.isFinite(r) && r > 0 && r <= 30) out.add(r);
  }
  return Array.from(out);
}

export interface CheckContext {
  /** VAT rate implied by the quotation's HT and TTC totals, when they imply a single rate. */
  documentVatRate: number | null;
  lotFallback?: string;
}

/** Computes every deterministic point for a quotation's lines. */
export function computeQuotationChecks(lines: CheckLineInput[], context: CheckContext): QuotationCheckPoint[] {
  const lots = lotLabelsFor(lines, context.lotFallback);
  const ref = (l: CheckLineInput): CheckLineRef => ({ id: l.id, lineNumber: l.lineNumber, lot: lots.get(l.id)!, description: short(l.description) });
  const points: QuotationCheckPoint[] = [];

  // 1. Same quantity and unit repeated in different lots.
  const byQty = new Map<string, CheckLineInput[]>();
  for (const l of lines) {
    const q = num(l.quantity);
    const unit = normUnit(l.unit);
    if (q == null || q <= 0 || q === 1) continue;
    if (COUNT_UNITS.has(unit) && q < 5) continue;
    const k = `${q}|${unit}`;
    byQty.set(k, [...(byQty.get(k) ?? []), l]);
  }
  for (const [k, group] of Array.from(byQty.entries())) {
    const distinctLots = new Set(group.map(l => lots.get(l.id)));
    if (distinctLots.size < 2) continue;
    const q = num(group[0].quantity)!;
    points.push({
      key: `rule:duplicate_scope:${k}:${group.map(l => l.id).join(",")}`, source: "rule", category: "duplicate_scope",
      lines: group.map(ref),
      finding: `The same quantity (${fmtQty(q)}${group[0].unit ? ` ${group[0].unit}` : ""}) appears in ${distinctLots.size} different lots: ${Array.from(distinctLots).join(", ")}.`,
      suggestedAction: "Check with the contractor whether these lines cover the same area or work, and remove any repetition.",
    });
  }

  // 2. Near-identical descriptions (possible duplicate equipment or work).
  const tokens = new Map(lines.map(l => [l.id, descriptionTokens(l.description)]));
  const parent = new Map<number, number>();
  const find = (id: number): number => { const p = parent.get(id) ?? id; return p === id ? id : find(p); };
  for (let i = 0; i < lines.length; i++) {
    const a = tokens.get(lines[i].id)!;
    if (a.length < 3) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const b = tokens.get(lines[j].id)!;
      if (b.length < 3 || similarity(a, b) < 0.8) continue;
      parent.set(find(lines[j].id), find(lines[i].id));
    }
  }
  const clusters = new Map<number, CheckLineInput[]>();
  for (const l of lines) {
    if (!parent.has(l.id) && !Array.from(parent.values()).includes(l.id)) continue;
    const root = find(l.id);
    clusters.set(root, [...(clusters.get(root) ?? []), l]);
  }
  for (const group of Array.from(clusters.values())) {
    if (group.length < 2) continue;
    points.push({
      key: `rule:duplicate_equipment:${group.map(l => `${l.id}=${num(l.totalHt) ?? ""}`).join(",")}`, source: "rule", category: "duplicate_equipment",
      lines: group.map(ref),
      finding: `${group.length} lines have almost the same description${new Set(group.map((l: CheckLineInput) => lots.get(l.id))).size > 1 ? " in different lots" : ""}.`,
      suggestedAction: "Confirm each line is a separate item (for example, two units are really needed) rather than the same item charged twice.",
    });
  }

  for (const l of lines) {
    const q = num(l.quantity), u = num(l.unitPriceHt), t = num(l.totalHt);
    // 3. Unpriced line with a quantity.
    if (q != null && q > 0 && (u == null || u === 0) && (t == null || t === 0)) {
      points.push({
        key: `rule:unpriced_line:${l.id}:${q}`, source: "rule", category: "unpriced_line", lines: [ref(l)],
        finding: `Line ${l.lineNumber} has a quantity of ${fmtQty(q)}${l.unit ? ` ${l.unit}` : ""} but no price.`,
        suggestedAction: "Ask the contractor to price this line, or confirm it is included elsewhere or offered at no charge.",
      });
    }
    // 4. Quantity × unit price ≠ total.
    if (q != null && u != null && u !== 0 && t != null) {
      const expected = Math.round(q * u * 100) / 100;
      const tolerance = Math.max(0.05, Math.abs(expected) * 0.0005);
      if (Math.abs(expected - t) > tolerance) {
        points.push({
          key: `rule:arithmetic:${l.id}:${q}:${u}:${t}`, source: "rule", category: "arithmetic", lines: [ref(l)],
          finding: `${fmtQty(q)} × ${fmtEur(u)} = ${fmtEur(expected)}, but the line total is ${fmtEur(t)} (difference ${fmtEur(Math.round((t - expected) * 100) / 100)}).`,
          suggestedAction: "Ask the contractor which figure is correct and to issue a corrected quotation if needed.",
        });
      }
    }
    // 5. VAT rate written in the description differs from the applied rate.
    const applied = num(l.vatRate) ?? context.documentVatRate;
    if (applied != null) {
      const differing = mentionedVatRates(l.description).filter(r => Math.abs(r - applied) > 0.001);
      if (differing.length) {
        points.push({
          key: `rule:vat_mention:${l.id}:${differing.join("/")}:${applied}`, source: "rule", category: "vat_mention", lines: [ref(l)],
          finding: `The description mentions VAT at ${differing.map(fmtRate).join(" / ")}, but ${fmtRate(applied)} is applied${num(l.vatRate) == null ? " to the quotation total" : " to this line"}.`,
          suggestedAction: "Confirm which VAT rate applies to this work (reduced rates need the client's attestation) and ask for a corrected quotation if the total is wrong.",
        });
      }
    }
  }
  return points;
}

/** VAT rate implied by HT and TTC, only when it matches a standard French rate. */
export function documentVatRate(amountHt: string | null, amountTtc: string | null): number | null {
  const ht = num(amountHt), ttc = num(amountTtc);
  if (ht == null || ttc == null || ht <= 0) return null;
  for (const r of [20, 10, 5.5, 2.1, 0]) if (Math.abs(ht * (1 + r / 100) - ttc) <= Math.max(1, ttc * 0.001)) return r;
  return null;
}

// ---------------------------------------------------------------------------
// Review records (dismiss with reason / sent to worksheet), append-only.

export const CHECK_REVIEW_ACTIONS = ["dismissed", "reopened", "added_to_worksheet"] as const;
export type CheckReviewAction = (typeof CHECK_REVIEW_ACTIONS)[number];

export const checkDismissSchema = z.object({
  key: z.string().min(1).max(2000),
  reason: z.string().trim().min(3, "Give a short reason for dismissing this point.").max(1000),
}).strict();
export const checkReopenSchema = z.object({ key: z.string().min(1).max(2000) }).strict();
export const checkToWorksheetSchema = z.object({
  key: z.string().min(1).max(2000),
  worksheetId: z.number().int().positive(),
}).strict();

export interface CheckReview {
  id: number; key: string; action: CheckReviewAction; reason: string | null; worksheetId: number | null;
  actor: string; at: string; point: QuotationCheckPoint;
}
export interface QuotationChecksResult {
  devisId: number;
  open: QuotationCheckPoint[];
  dismissed: Array<QuotationCheckPoint & { reason: string | null; dismissedBy: string; dismissedAt: string }>;
  /** Points already sent to a worksheet; they stay listed as open but marked. */
  sentToWorksheet: Record<string, { worksheetId: number; at: string }>;
  ai: { status: "none" | "succeeded" | "failed"; at: string | null; error: string | null; stale: boolean; available: boolean };
  history: CheckReview[];
  readOnlyReason: string | null;
}

/** The worksheet note text for a point. */
export function checkNoteText(point: Pick<QuotationCheckPoint, "category" | "finding" | "suggestedAction" | "source">) {
  return `Point to check${point.source === "ai" ? " (AI suggestion)" : ""} — ${CHECK_CATEGORIES[point.category]}: ${point.finding} ${point.suggestedAction}`;
}

// ---------------------------------------------------------------------------
// AI suggestions: strict shape the model must return.

export const aiCheckResponseSchema = z.object({
  points: z.array(z.object({
    category: z.enum(["annotation", "overlap", "other"]),
    lineNumbers: z.array(z.number().int().positive()).min(1).max(12),
    finding: z.string().trim().min(5).max(600),
    suggestedAction: z.string().trim().min(5).max(400),
  })).max(20),
});
