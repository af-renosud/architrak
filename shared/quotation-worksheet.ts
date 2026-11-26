import { z } from "zod";

/**
 * Client worksheet calculations — shared by the server (API totals), the
 * worksheet screen and the Excel export so all three agree to the cent.
 *
 * Money is handled in integer cents. Rules (mirrored by the Excel formulas):
 *  - Original line total is the extracted total (authoritative), never a
 *    recomputation.
 *  - Revised total = original total while the client quantity and unit price
 *    are unchanged; otherwise ROUND(qty × price, 2).
 *  - Unpriced lines (no original price, or a client line without price) are
 *    "Not priced" and contribute nothing — they are never shown as €0.
 *  - VAT uses each line's own rate, rounded per rate bucket. Lines with an
 *    unknown rate are excluded from VAT and reported, never defaulted.
 */

export const WORKSHEET_TAGS = {
  cost_saving: "Cost saving",
  value_added: "Value added",
  query_contractor: "To query with contractor",
} as const;
export type WorksheetTag = keyof typeof WORKSHEET_TAGS;
export const MEETING_SECTION_LABEL = "Meeting additions";

export type WorksheetStatus = "Unchanged" | "Modified" | "Removed" | "Added" | "Not priced";
export type WorksheetLineKind = "priced" | "unpriced" | "added";

export interface WorksheetLineData {
  id: number;
  sourceLineItemId: number | null;
  position: number;
  section: "lot" | "meeting";
  lotLabel: string;
  description: string;
  unit: string | null;
  originalQuantity: string | null;
  originalUnitPrice: string | null;
  originalTotal: string | null;
  vatRate: string | null;
  clientQuantity: string | null;
  clientUnitPrice: string | null;
  note: string | null;
  tag: WorksheetTag | null;
}

export interface WorksheetLineResult {
  id: number;
  item: string;
  kind: WorksheetLineKind;
  status: WorksheetStatus;
  originalCents: number | null;
  revisedCents: number | null;
  differenceCents: number | null;
}

export interface WorksheetVatBucket { rate: string; originalVatCents: number; revisedVatCents: number }
export interface WorksheetAmounts { htCents: number; vatCents: number; ttcCents: number; depositCents: number | null }
export interface WorksheetLotSummary {
  label: string;
  section: "lot" | "meeting";
  lineIds: number[];
  originalHtCents: number;
  revisedHtCents: number;
  notPricedCount: number;
}
export interface WorksheetComputation {
  lines: WorksheetLineResult[];
  lots: WorksheetLotSummary[];
  vat: WorksheetVatBucket[];
  original: WorksheetAmounts;
  revised: WorksheetAmounts;
  notPricedCount: number;
  unknownVatLineCount: number;
  counts: Record<WorksheetStatus, number>;
}

const money = /^-?\d{1,10}(?:\.\d{1,2})?$/;
const qty = /^-?\d{1,9}(?:\.\d{1,3})?$/;
const rate = /^\d{1,3}(?:\.\d{1,3})?$/;
export const worksheetMoneySchema = z.string().trim().regex(money, "Use an amount with at most two decimals, e.g. 1250.50.");
export const worksheetQuantitySchema = z.string().trim().regex(qty, "Use a quantity with at most three decimals.").refine(v => Number(v) >= 0, "Quantity cannot be negative.");
export const worksheetVatSchema = z.string().trim().regex(rate, "Enter the VAT rate as a percentage, e.g. 20 or 5.5.").refine(v => Number(v) <= 100, "VAT rate must be 100 or less.");
const optionalText = (max: number) => z.string().max(max).transform(v => v.trim() || null).nullable();

export const worksheetLinePatchSchema = z.object({
  expectedRevision: z.number().int().positive(),
  clientQuantity: worksheetQuantitySchema.nullable().optional(),
  clientUnitPrice: worksheetMoneySchema.nullable().optional(),
  vatRate: worksheetVatSchema.nullable().optional(),
  lotLabel: z.string().trim().min(1, "Enter a lot name.").max(200).optional(),
  description: z.string().trim().min(1, "Enter a description.").max(5000).optional(),
  unit: optionalText(40).optional(),
  note: optionalText(5000).optional(),
  tag: z.enum(["cost_saving", "value_added", "query_contractor"]).nullable().optional(),
  reason: optionalText(1000).optional(),
}).strict();
export const worksheetLineAddSchema = z.object({
  expectedRevision: z.number().int().positive(),
  section: z.enum(["lot", "meeting"]),
  lotLabel: z.string().trim().max(200).optional(),
  description: z.string().trim().min(1, "Enter a description.").max(5000),
  unit: optionalText(40).optional(),
  clientQuantity: worksheetQuantitySchema.nullable(),
  clientUnitPrice: worksheetMoneySchema.nullable(),
  vatRate: worksheetVatSchema.nullable(),
  note: optionalText(5000).optional(),
  tag: z.enum(["cost_saving", "value_added", "query_contractor"]).nullable().optional(),
}).strict();
export const worksheetSettingsSchema = z.object({
  expectedRevision: z.number().int().positive(),
  title: z.string().trim().min(1, "Enter a worksheet name.").max(200).optional(),
  meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  depositPercent: z.string().trim().regex(/^\d{1,3}(?:\.\d{1,2})?$/, "Enter a percentage, e.g. 30.").refine(v => Number(v) <= 100, "Deposit must be 100% or less.").nullable().optional(),
}).strict();
export const worksheetCreateSchema = z.object({
  title: z.string().trim().min(1, "Enter a worksheet name.").max(200),
  meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}).strict();
export type WorksheetLinePatch = z.infer<typeof worksheetLinePatchSchema>;
export type WorksheetLineAdd = z.infer<typeof worksheetLineAddSchema>;

/** Parse a fixed-point decimal string into an integer scaled by 10^scale. */
export function scaled(value: string, scale: number): number {
  const neg = value.startsWith("-");
  const [i, f = ""] = value.replace("-", "").split(".");
  const n = Number(i) * 10 ** scale + Number((f + "0".repeat(scale)).slice(0, scale) || "0");
  return neg ? -n : n;
}
export const cents = (value: string) => scaled(value, 2);
/** Integer division rounding half away from zero (Excel ROUND semantics). */
function roundDivBig(n: bigint, d: bigint) {
  const neg = n < BigInt(0), a = neg ? -n : n;
  const q = a / d, r = a % d;
  const v = r * BigInt(2) >= d ? q + BigInt(1) : q;
  return Number(neg ? -v : v);
}
export function productCents(quantity: string, unitPrice: string) {
  return roundDivBig(BigInt(scaled(quantity, 3)) * BigInt(scaled(unitPrice, 2)), BigInt(1000));
}
export function percentOfCents(amountCents: number, percent: string) {
  return roundDivBig(BigInt(amountCents) * BigInt(scaled(percent, 3)), BigInt(100000));
}
export function formatCents(value: number) {
  const n = Math.abs(value);
  return `${value < 0 ? "-" : ""}${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}
const sameNumber = (a: string | null, b: string | null) => a != null && b != null && Number(a) === Number(b);

export function lineKind(line: Pick<WorksheetLineData, "sourceLineItemId" | "originalTotal">): WorksheetLineKind {
  if (line.sourceLineItemId == null) return "added";
  return line.originalTotal == null ? "unpriced" : "priced";
}

export function computeLine(line: WorksheetLineData, item: string): WorksheetLineResult {
  const kind = lineKind(line);
  const originalCents = kind === "priced" ? cents(line.originalTotal!) : null;
  let revisedCents: number | null = null;
  if (line.clientQuantity != null && line.clientUnitPrice != null) {
    revisedCents = kind === "priced" && sameNumber(line.clientQuantity, line.originalQuantity) && sameNumber(line.clientUnitPrice, line.originalUnitPrice)
      ? originalCents : productCents(line.clientQuantity, line.clientUnitPrice);
  } else if (kind === "priced") {
    revisedCents = 0; // a priced original with a cleared field counts as removed
  }
  let status: WorksheetStatus;
  if (kind === "priced") {
    status = line.clientQuantity == null || Number(line.clientQuantity) === 0 ? "Removed"
      : sameNumber(line.clientQuantity, line.originalQuantity) && sameNumber(line.clientUnitPrice, line.originalUnitPrice) ? "Unchanged" : "Modified";
  } else if (revisedCents == null) status = "Not priced";
  else if (kind === "added") status = "Added";
  else status = Number(line.clientQuantity) === 0 ? "Removed" : "Modified";
  const differenceCents = kind === "priced" ? revisedCents! - originalCents! : revisedCents;
  return { id: line.id, item, kind, status, originalCents, revisedCents, differenceCents };
}

/** Lots in first-appearance order; meeting additions always last. */
export function groupWorksheetLines<T extends Pick<WorksheetLineData, "section" | "lotLabel" | "position" | "id">>(lines: T[]) {
  const sorted = [...lines].sort((a, b) => a.position - b.position || a.id - b.id);
  const groups: Array<{ label: string; section: "lot" | "meeting"; lines: T[] }> = [];
  const byKey = new Map<string, { label: string; section: "lot" | "meeting"; lines: T[] }>();
  for (const line of sorted) {
    const key = line.section === "meeting" ? "\u0000meeting" : line.lotLabel;
    let g = byKey.get(key);
    if (!g) {
      g = { label: line.section === "meeting" ? MEETING_SECTION_LABEL : line.lotLabel, section: line.section, lines: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.lines.push(line);
  }
  return [...groups.filter(g => g.section === "lot"), ...groups.filter(g => g.section === "meeting")];
}

export function computeWorksheet(lines: WorksheetLineData[], depositPercent: string | null): WorksheetComputation {
  const groups = groupWorksheetLines(lines);
  const results: WorksheetLineResult[] = [];
  const lots: WorksheetLotSummary[] = [];
  const buckets = new Map<string, { o: number; r: number }>();
  const counts: Record<WorksheetStatus, number> = { Unchanged: 0, Modified: 0, Removed: 0, Added: 0, "Not priced": 0 };
  let unknownVatLineCount = 0;
  groups.forEach((g, gi) => {
    const summary: WorksheetLotSummary = { label: g.label, section: g.section, lineIds: [], originalHtCents: 0, revisedHtCents: 0, notPricedCount: 0 };
    g.lines.forEach((line, li) => {
      const r = computeLine(line, `${g.section === "meeting" ? "M" : gi + 1}.${li + 1}`);
      results.push(r);
      summary.lineIds.push(line.id);
      counts[r.status]++;
      summary.originalHtCents += r.originalCents ?? 0;
      summary.revisedHtCents += r.revisedCents ?? 0;
      if (r.status === "Not priced") summary.notPricedCount++;
      if (line.vatRate == null) {
        if ((r.originalCents ?? 0) !== 0 || (r.revisedCents ?? 0) !== 0) unknownVatLineCount++;
      } else {
        const key = String(Number(line.vatRate));
        const b = buckets.get(key) ?? { o: 0, r: 0 };
        b.o += r.originalCents ?? 0; b.r += r.revisedCents ?? 0;
        buckets.set(key, b);
      }
    });
    lots.push(summary);
  });
  const vat = Array.from(buckets.entries()).sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([rateKey, b]) => ({ rate: rateKey, originalVatCents: percentOfCents(b.o, rateKey), revisedVatCents: percentOfCents(b.r, rateKey) }));
  const amounts = (ht: number, vatCents: number): WorksheetAmounts => {
    const ttc = ht + vatCents;
    return { htCents: ht, vatCents, ttcCents: ttc, depositCents: depositPercent == null ? null : percentOfCents(ttc, depositPercent) };
  };
  const sum = (f: (l: WorksheetLotSummary) => number) => lots.reduce((s, l) => s + f(l), 0);
  return {
    lines: results, lots, vat,
    original: amounts(sum(l => l.originalHtCents), vat.reduce((s, v) => s + v.originalVatCents, 0)),
    revised: amounts(sum(l => l.revisedHtCents), vat.reduce((s, v) => s + v.revisedVatCents, 0)),
    notPricedCount: counts["Not priced"], unknownVatLineCount, counts,
  };
}

/**
 * Best-effort lot heading from a contractor line ("LOT GROS OEUVRE MACONNERIE
 * Chainage…", "Lot etude\nréalisation…", "Lot Electricité Prise…").
 * Returns null when the line carries no heading. The architect can rename.
 */
export function detectLotHeading(description: string): string | null {
  const text = description.trim();
  const m = /^lot\b[\s:.-]*/i.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  const firstLine = rest.split(/\r?\n/)[0].trim();
  if (/\r?\n/.test(rest) && firstLine && firstLine.split(/\s+/).length <= 6) return tidy(firstLine);
  const words = rest.split(/\s+/).filter(Boolean);
  const isUpper = (w: string) => /[A-ZÀ-Þ]/.test(w) && w === w.toUpperCase();
  const label: string[] = [];
  if (words[0] && isUpper(words[0])) {
    for (const w of words) {
      if (!isUpper(w)) break;
      label.push(w);
    }
    // Keep the final upper-case word for the description when it starts a sentence (e.g. "DOUBLAGE").
    if (label.length === words.length) return null;
  } else if (words[0]) {
    label.push(words[0]);
    // Only short capitals continue a lower-case heading ("Lot plomberie VMC");
    // longer capitals start the item text ("Lot cloison FOURNITURE ET POSE…").
    for (const w of words.slice(1)) { if (!isUpper(w) || w.length < 2 || w.length > 4) break; label.push(w); }
  }
  return label.length ? tidy(label.join(" ")) : null;
}
function tidy(label: string) {
  const cleaned = label.replace(/[()]+$/g, "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : cleaned;
}
