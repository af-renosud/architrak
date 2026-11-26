import { z } from "zod";
import {
  WORKSHEET_TAGS, computeWorksheet, formatCents, groupWorksheetLines,
  type WorksheetAmounts, type WorksheetLineData, type WorksheetStatus, type WorksheetTag, type WorksheetVatBucket,
} from "./quotation-worksheet";

/**
 * Agreed worksheets: the sealed client copy (English), the contractor
 * revision request (French) and the comparison with a revised quotation.
 * Pure functions shared by the server and the UI.
 */

// ── Sealed client copy ─────────────────────────────────────────────────────

export interface SharedWorksheetLine {
  item: string;
  description: string;
  /** Contractor's original wording when an approved English translation is shown instead. */
  originalDescription: string | null;
  unit: string | null;
  status: WorksheetStatus;
  originalQuantity: string | null;
  originalUnitPrice: string | null;
  originalCents: number | null;
  revisedQuantity: string | null;
  revisedUnitPrice: string | null;
  revisedCents: number | null;
  differenceCents: number | null;
  note: string | null;
  tag: string | null;
}
export interface SharedWorksheetPayload {
  version: 1;
  title: string;
  meetingDate: string | null;
  projectName: string;
  quotation: { ref: string; documentRef: string | null; contractorName: string; date: string | null };
  lots: Array<{ label: string; section: "lot" | "meeting"; originalHtCents: number; revisedHtCents: number; lines: SharedWorksheetLine[] }>;
  vat: WorksheetVatBucket[];
  original: WorksheetAmounts;
  revised: WorksheetAmounts;
  depositPercent: string | null;
  counts: Record<WorksheetStatus, number>;
  notPricedCount: number;
  unknownVatLineCount: number;
  /** english: every contractor line shown in approved English; partial/original otherwise. */
  language: "english" | "partial" | "original";
}

export function buildSharedWorksheetPayload(input: {
  title: string; meetingDate: string | null; depositPercent: string | null; projectName: string;
  quotation: { ref: string; documentRef: string | null; contractorName: string; date: string | null };
  lines: WorksheetLineData[];
  /** Approved English wording keyed by source line item id. */
  english: Map<number, string>;
}): SharedWorksheetPayload {
  const computed = computeWorksheet(input.lines, input.depositPercent);
  const results = new Map(computed.lines.map(r => [r.id, r]));
  let sourceLines = 0, translated = 0;
  const lots = groupWorksheetLines(input.lines).map((g, gi) => ({
    label: g.label, section: g.section,
    originalHtCents: computed.lots[gi].originalHtCents, revisedHtCents: computed.lots[gi].revisedHtCents,
    lines: g.lines.map(line => {
      const r = results.get(line.id)!;
      const en = line.sourceLineItemId != null ? input.english.get(line.sourceLineItemId)?.trim() : undefined;
      if (line.sourceLineItemId != null) { sourceLines++; if (en) translated++; }
      return {
        item: r.item, description: en || line.description, originalDescription: en ? line.description : null,
        unit: line.unit, status: r.status,
        originalQuantity: line.originalQuantity, originalUnitPrice: line.originalUnitPrice, originalCents: r.originalCents,
        revisedQuantity: line.clientQuantity, revisedUnitPrice: line.clientUnitPrice, revisedCents: r.revisedCents,
        differenceCents: r.differenceCents, note: line.note,
        tag: line.tag ? WORKSHEET_TAGS[line.tag as WorksheetTag] ?? null : null,
      };
    }),
  }));
  return {
    version: 1, title: input.title, meetingDate: input.meetingDate, projectName: input.projectName, quotation: input.quotation,
    lots, vat: computed.vat, original: computed.original, revised: computed.revised, depositPercent: input.depositPercent,
    counts: computed.counts, notPricedCount: computed.notPricedCount, unknownVatLineCount: computed.unknownVatLineCount,
    language: sourceLines === 0 || translated === sourceLines ? "english" : translated === 0 ? "original" : "partial",
  };
}

export const worksheetCommentSchema = z.object({ body: z.string().trim().min(1, "Write a comment first.").max(5000) }).strict();

// ── Contractor revision request ────────────────────────────────────────────

export type RevisionChangeKind = "added" | "removed" | "changed";
export interface RevisionChange {
  kind: RevisionChangeKind;
  item: string;
  lotLabel: string;
  description: string;
  unit: string | null;
  originalQuantity: string | null;
  originalUnitPrice: string | null;
  newQuantity: string | null;
  newUnitPrice: string | null;
  note: string | null;
}

const same = (a: string | null, b: string | null) => (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));

/** Added, removed and changed lines, in worksheet order. Unchanged lines are omitted. */
export function worksheetRevisionChanges(lines: WorksheetLineData[]): RevisionChange[] {
  const computed = computeWorksheet(lines, null);
  const results = new Map(computed.lines.map(r => [r.id, r]));
  const out: RevisionChange[] = [];
  for (const g of groupWorksheetLines(lines)) {
    for (const line of g.lines) {
      const r = results.get(line.id)!;
      const base = { item: r.item, lotLabel: g.label, description: line.description, unit: line.unit,
        originalQuantity: line.originalQuantity, originalUnitPrice: line.originalUnitPrice,
        newQuantity: line.clientQuantity, newUnitPrice: line.clientUnitPrice, note: line.note };
      if (r.kind === "added") {
        if (line.clientQuantity != null && Number(line.clientQuantity) === 0) continue;
        out.push({ kind: "added", ...base, originalQuantity: null, originalUnitPrice: null });
      } else if (r.status === "Removed") {
        out.push({ kind: "removed", ...base, newQuantity: "0", newUnitPrice: null });
      } else if (r.status === "Modified") {
        out.push({ kind: "changed", ...base });
      } else if (r.kind === "unpriced" && line.clientQuantity != null && !same(line.clientQuantity, line.originalQuantity)) {
        out.push({ kind: "changed", ...base });
      }
    }
  }
  return out;
}

/** French number: 1 250,5 (quantities) / 1 250,50 € (money). */
export function frNumber(value: string, decimals?: number) {
  const n = Number(value);
  const fixed = decimals == null ? String(Number(n.toFixed(3))) : n.toFixed(decimals);
  const [i, f] = fixed.replace("-", "").split(".");
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${n < 0 ? "-" : ""}${grouped}${f ? `,${f}` : ""}`;
}
const frMoney = (value: string) => `${frNumber(value, 2)} €`;
const frCents = (cents: number) => frMoney(formatCents(cents));
const qtyUnit = (q: string | null, unit: string | null) => (q == null ? "—" : `${frNumber(q)}${unit ? ` ${unit}` : ""}`);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export const revisionRequestInputSchema = z.object({
  message: z.string().max(3000).optional().nullable(),
  includeNotes: z.boolean().optional(),
});
export const revisionRequestSendSchema = revisionRequestInputSchema.extend({
  expectedRevision: z.number().int().positive(),
  requestId: z.string().uuid(),
}).strict();

export function buildRevisionRequestEmail(input: {
  projectName: string; quotationRef: string; documentRef: string | null; contactName: string | null;
  meetingDate: string | null; changes: RevisionChange[]; originalHtCents: number; revisedHtCents: number;
  message?: string | null; includeNotes?: boolean; requestId?: string;
}) {
  const ref = input.documentRef ? `n° ${input.documentRef} (${input.quotationRef})` : input.quotationRef;
  const meeting = input.meetingDate ? ` du ${input.meetingDate.split("-").reverse().join("/")}` : "";
  const by = (k: RevisionChangeKind) => input.changes.filter(c => k === c.kind);
  const note = (c: RevisionChange) => (input.includeNotes && c.note?.trim() ? `\n    Remarque : ${oneLine(c.note)}` : "");
  const head = (c: RevisionChange) => `- ${c.item} [${oneLine(c.lotLabel)}] ${oneLine(c.description)}`;
  const sections: string[] = [];
  const added = by("added");
  if (added.length) sections.push(`AJOUTS (${added.length})\n` + added.map(c =>
    `${head(c)}\n    Quantité : ${qtyUnit(c.newQuantity, c.unit)}` +
    (c.newUnitPrice != null ? ` — prix unitaire HT envisagé : ${frMoney(c.newUnitPrice)}` : " — prix à chiffrer") + note(c)).join("\n"));
  const removed = by("removed");
  if (removed.length) sections.push(`SUPPRESSIONS (${removed.length})\n` + removed.map(c =>
    `${head(c)}\n    Ligne à retirer (quantité initiale : ${qtyUnit(c.originalQuantity, c.unit)})` + note(c)).join("\n"));
  const changed = by("changed");
  if (changed.length) sections.push(`MODIFICATIONS (${changed.length})\n` + changed.map(c => {
    const parts: string[] = [];
    if (!same(c.originalQuantity, c.newQuantity)) parts.push(`quantité : ${qtyUnit(c.originalQuantity, c.unit)} → ${qtyUnit(c.newQuantity, c.unit)}`);
    if (!same(c.originalUnitPrice, c.newUnitPrice) && c.newUnitPrice != null)
      parts.push(`prix unitaire HT : ${c.originalUnitPrice == null ? "—" : frMoney(c.originalUnitPrice)} → ${frMoney(c.newUnitPrice)}`);
    return `${head(c)}\n    ${parts.join(" ; ") || "à revoir"}` + note(c);
  }).join("\n"));
  const greeting = input.contactName?.trim() ? `Bonjour ${oneLine(input.contactName)},` : "Bonjour,";
  const message = input.message?.trim() ? `\n\n${input.message.trim()}` : "";
  const body = [
    greeting,
    "",
    `Suite à la réunion avec le client${meeting}, nous vous remercions de bien vouloir nous adresser un devis révisé pour le devis ${ref}, en intégrant les modifications ci-dessous.${message}`,
    "",
    sections.join("\n\n"),
    "",
    `Montant HT indicatif après modifications : ${frCents(input.revisedHtCents)} (devis initial : ${frCents(input.originalHtCents)}).`,
    "Ces montants sont indicatifs et calculés à partir de vos prix unitaires ; merci de confirmer vos prix dans le devis révisé et d'y faire apparaître clairement les lignes modifiées.",
    "",
    "Cordialement,",
    "L'équipe Renosud",
  ].join("\n") + (input.requestId ? `\n\nRéférence : AT-RR-${input.requestId}` : "");
  return { subject: `Demande de devis révisé — ${oneLine(input.projectName)} — devis ${input.documentRef ?? input.quotationRef}`, body };
}

// ── Comparison with the revised quotation ─────────────────────────────────

export interface RevisedQuotationLine {
  id: number; lineNumber: number; description: string; unit: string | null;
  quantity: string | null; unitPriceHt: string | null; totalHt: string | null;
}
export type ComparisonStatus =
  | "as_agreed" | "quantity_differs" | "price_differs" | "total_differs" | "missing"
  | "removed_as_agreed" | "still_included" | "not_in_worksheet";
export interface ComparisonRow {
  status: ComparisonStatus;
  item: string | null;
  lotLabel: string | null;
  agreed: { description: string; unit: string | null; quantity: string | null; unitPrice: string | null; totalCents: number | null; status: WorksheetStatus } | null;
  revised: { lineNumber: number; description: string; unit: string | null; quantity: string | null; unitPrice: string | null; totalCents: number | null } | null;
  match: "wording" | "similar" | null;
}
export interface WorksheetComparison {
  rows: ComparisonRow[];
  agreedHtCents: number;
  revisedLinesHtCents: number;
  counts: Record<ComparisonStatus, number>;
}

/** Same compaction as the replacement carry-forward: accents, case, spacing and punctuation ignored. */
export function compactWording(text: string) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function words(text: string) {
  return new Set(text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3));
}
function similarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  a.forEach(w => { if (b.has(w)) common++; });
  return common / (a.size + b.size - common);
}
const toCents = (v: string | null) => (v == null ? null : Math.round(Number(v) * 100));

/**
 * Match agreed lines to the revised quotation: first the same wording that
 * occurs exactly once on each side, then a clearly best similar wording
 * (mutual best, ≥ 50 % shared words). Repeated or ambiguous wording is never
 * matched; it is reported for the architect to check.
 */
export function compareWithRevisedQuotation(agreedLines: WorksheetLineData[], revised: RevisedQuotationLine[]): WorksheetComparison {
  const computed = computeWorksheet(agreedLines, null);
  const results = new Map(computed.lines.map(r => [r.id, r]));
  const ordered = groupWorksheetLines(agreedLines).flatMap(g => g.lines.map(line => ({ line, lotLabel: g.label })));
  const relevant = ordered.filter(({ line }) => {
    const r = results.get(line.id)!;
    return !(r.kind === "added" && line.clientQuantity != null && Number(line.clientQuantity) === 0);
  });
  const key = (s: string) => compactWording(s);
  const count = <T>(rows: T[], get: (r: T) => string, k: string) => rows.filter(r => get(r) === k).length;
  const matchOf = new Map<number, { target: RevisedQuotationLine; kind: "wording" | "similar" }>();
  const taken = new Set<number>();
  for (const { line } of relevant) {
    const k = key(line.description);
    if (k.length < 3 || count(relevant, x => key(x.line.description), k) !== 1 || count(revised, x => key(x.description), k) !== 1) continue;
    const target = revised.find(t => key(t.description) === k)!;
    matchOf.set(line.id, { target, kind: "wording" });
    taken.add(target.id);
  }
  const freeAgreed = relevant.filter(({ line }) => !matchOf.has(line.id));
  const freeRevised = revised.filter(t => !taken.has(t.id));
  const best = <A, B>(from: A, pool: B[], wa: (a: A) => Set<string>, wb: (b: B) => Set<string>) => {
    let top: B | null = null, score = 0, second = 0;
    for (const c of pool) {
      const s = similarity(wa(from), wb(c));
      if (s > score) { second = score; score = s; top = c; } else if (s > second) second = s;
    }
    return top && score >= 0.5 && score - second >= 0.1 ? top : null;
  };
  const wA = (x: { line: WorksheetLineData }) => words(x.line.description);
  const wR = (t: RevisedQuotationLine) => words(t.description);
  for (const a of freeAgreed) {
    const t = best(a, freeRevised.filter(r => !taken.has(r.id)), wA, wR);
    if (!t) continue;
    const back = best(t, freeAgreed.filter(x => !matchOf.has(x.line.id)), wR, wA);
    if (back !== a) continue;
    matchOf.set(a.line.id, { target: t, kind: "similar" });
    taken.add(t.id);
  }

  const rows: ComparisonRow[] = [];
  for (const { line, lotLabel } of relevant) {
    const r = results.get(line.id)!;
    const m = matchOf.get(line.id);
    const agreed = { description: line.description, unit: line.unit, quantity: line.clientQuantity, unitPrice: line.clientUnitPrice,
      totalCents: r.revisedCents, status: r.status };
    const revisedRow = m ? { lineNumber: m.target.lineNumber, description: m.target.description, unit: m.target.unit,
      quantity: m.target.quantity, unitPrice: m.target.unitPriceHt, totalCents: toCents(m.target.totalHt) } : null;
    let status: ComparisonStatus;
    if (r.status === "Removed") status = m && (revisedRow!.totalCents ?? 0) !== 0 ? "still_included" : "removed_as_agreed";
    else if (!m) status = "missing";
    else if (!same(line.clientQuantity, m.target.quantity)) status = "quantity_differs";
    else if (line.clientUnitPrice != null && !same(line.clientUnitPrice, m.target.unitPriceHt)) status = "price_differs";
    else if (r.revisedCents != null && revisedRow!.totalCents != null && Math.abs(r.revisedCents - revisedRow!.totalCents) > 1) status = "total_differs";
    else status = "as_agreed";
    rows.push({ status, item: r.item, lotLabel, agreed, revised: revisedRow, match: m?.kind ?? null });
  }
  for (const t of revised) {
    if (taken.has(t.id)) continue;
    rows.push({ status: "not_in_worksheet", item: null, lotLabel: null, agreed: null, match: null,
      revised: { lineNumber: t.lineNumber, description: t.description, unit: t.unit, quantity: t.quantity, unitPrice: t.unitPriceHt, totalCents: toCents(t.totalHt) } });
  }
  const counts = { as_agreed: 0, quantity_differs: 0, price_differs: 0, total_differs: 0, missing: 0,
    removed_as_agreed: 0, still_included: 0, not_in_worksheet: 0 } as Record<ComparisonStatus, number>;
  rows.forEach(r => { counts[r.status]++; });
  return {
    rows, counts, agreedHtCents: computed.revised.htCents,
    revisedLinesHtCents: revised.reduce((s, t) => s + (toCents(t.totalHt) ?? 0), 0),
  };
}

export const COMPARISON_LABELS: Record<ComparisonStatus, string> = {
  as_agreed: "As agreed",
  quantity_differs: "Quantity differs",
  price_differs: "Unit price differs",
  total_differs: "Total differs",
  missing: "Not found in revision",
  removed_as_agreed: "Removed as agreed",
  still_included: "Still included — should be removed",
  not_in_worksheet: "Not in agreed worksheet",
};
