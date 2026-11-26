// Lot-by-lot check for AI-read quotations.
//
// When no exact table reader recognises a quotation, the model reads it from
// page images and only the grand totals are cross-checked, so two errors in
// different lots can cancel out. The model also reports each printed section
// subtotal ("Sous-total Lot 2") separately from the line items, and tags
// every line with the heading of the innermost section it sits under. This
// module turns that into an auditable list of printed subtotals with the
// line numbers each one covers, and compares them. Nothing is corrected.

import type { ValidationWarning } from "./extraction-validator";

export interface RawSectionSubtotal {
  section: string;
  parentSection?: string | null;
  amount: number;
  page?: number | null;
}

/** Printed subtotal with the lines it covers, persisted with the extraction. */
export interface PrintedSubtotal {
  label: string;
  parentLabel: string | null;
  amount: number;
  page: number | null;
  /** 1-based line numbers whose section is this one or a nested section. */
  lineNumbers: number[];
}

/** Accent-, case- and punctuation-free form without a "Sous-total"/"Total" prefix. */
export function canonicalSectionLabel(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/^\s*(?:s\s*\/\s*total|sous[\s-]*total|total)\b[\s:.\-–—]*/, "")
    .replace(/[^a-z0-9]/g, "");
}
/** Looser form that also drops a leading "Lot"/numbering ("Lot 2 -", "2.1"). */
function looseSectionLabel(value: string): string {
  const stripped = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/^\s*(?:s\s*\/\s*total|sous[\s-]*total|total)\b[\s:.\-–—]*/, "")
    .replace(/^\s*(?:lot\s*)?(?:n[°o]\s*)?[a-z]{0,3}\d+(?:[.\-]\d+)*\b[\s:.\-–—)]*/, "");
  return stripped.replace(/[^a-z0-9]/g, "");
}

const money = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

function sanitize(raw: unknown): RawSectionSubtotal[] {
  if (!Array.isArray(raw)) return [];
  const out: RawSectionSubtotal[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const v = r as Record<string, unknown>;
    const amount = money(v.amount);
    if (typeof v.section !== "string" || !canonicalSectionLabel(v.section) || amount == null) continue;
    out.push({
      section: v.section.trim(), amount,
      parentSection: typeof v.parentSection === "string" && canonicalSectionLabel(v.parentSection) ? v.parentSection.trim() : null,
      page: typeof v.page === "number" && Number.isInteger(v.page) && v.page >= 1 ? v.page : null,
    });
  }
  return out;
}

/**
 * Resolves the model's printed subtotals against the final line items.
 * Returns null when there is nothing to check: no printed subtotals, or the
 * lines carry no section tags (for example rows replaced by a text-layer
 * reader), so behaviour is unchanged for those quotations.
 */
export function resolvePrintedSubtotals(
  lineItems: Array<{ section?: unknown }> | undefined,
  rawSubtotals: unknown,
): PrintedSubtotal[] | null {
  const subtotals = sanitize(rawSubtotals);
  const lines = lineItems ?? [];
  if (!subtotals.length || !lines.some(l => typeof l.section === "string" && l.section.trim())) return null;

  // Identical repeats (same section and amount) are one printed subtotal.
  const unique: RawSectionSubtotal[] = [];
  for (const s of subtotals) {
    if (!unique.some(u => canonicalSectionLabel(u.section) === canonicalSectionLabel(s.section) && u.amount === s.amount)) unique.push(s);
  }
  const strict = unique.map(s => canonicalSectionLabel(s.section));
  const loose = unique.map(s => looseSectionLabel(s.section));
  /** Index of the subtotal a label refers to: exact canonical match, else a unique loose match. */
  const resolve = (label: string): number[] => {
    const c = canonicalSectionLabel(label);
    const exact = strict.flatMap((s, i) => (s === c ? [i] : []));
    if (exact.length) return exact;
    const l = looseSectionLabel(label);
    if (!l) return [];
    const hits = loose.flatMap((s, i) => (s === l ? [i] : []));
    const labels = new Set(hits.map(i => strict[i]));
    return labels.size === 1 ? hits : [];
  };

  const parentOf = unique.map(s => {
    if (!s.parentSection) return [] as number[];
    return resolve(s.parentSection).filter(p => strict[p] !== canonicalSectionLabel(s.section));
  });
  const direct = unique.map(() => [] as number[]);
  lines.forEach((line, index) => {
    if (typeof line.section !== "string" || !line.section.trim()) return;
    const number = typeof (line as { lineNumber?: unknown }).lineNumber === "number" ? (line as { lineNumber: number }).lineNumber : index + 1;
    for (const i of resolve(line.section)) direct[i].push(number);
  });
  // A line counts once toward each enclosing section, never twice.
  const covered = (i: number, seen = new Set<number>()): Set<number> => {
    const out = new Set(direct[i]);
    seen.add(i);
    unique.forEach((_, child) => {
      if (seen.has(child) || !parentOf[child].includes(i)) return;
      covered(child, seen).forEach(n => out.add(n));
    });
    return out;
  };
  return unique.map((s, i) => ({
    label: s.section, parentLabel: s.parentSection ?? null, amount: s.amount, page: s.page ?? null,
    lineNumbers: Array.from(covered(i)).sort((a, b) => a - b),
  }));
}

const eur = (n: number) => `${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

export interface SectionSubtotalComparison {
  label: string;
  page: number | null;
  printed: number;
  /** Sum of the covered extracted lines; null when none could be matched. */
  extracted: number | null;
  /** extracted − printed; null when unmatched. */
  difference: number | null;
  lineNumbers: number[];
  status: "matches" | "differs" | "unmatched";
}

/**
 * Compares each printed subtotal with the sum of its lines. Lines are matched
 * by their `lineNumber` when present, else by position. A blank price counts
 * as nothing. Rounding up to one cent is tolerated.
 */
export function compareSectionSubtotals(
  printed: PrintedSubtotal[] | null | undefined,
  lineItems: Array<{ total?: number | null; lineNumber?: number }>,
): SectionSubtotalComparison[] {
  if (!Array.isArray(printed) || !printed.length) return [];
  const totals = new Map<number, number>();
  lineItems.forEach((l, index) => {
    const n = typeof l.lineNumber === "number" ? l.lineNumber : index + 1;
    const t = Number(l.total ?? 0);
    totals.set(n, Number.isFinite(t) ? t : 0);
  });
  return printed.map(s => {
    const present = (Array.isArray(s.lineNumbers) ? s.lineNumbers : []).filter(n => totals.has(n));
    const base = { label: s.label, page: s.page ?? null, printed: s.amount, lineNumbers: present };
    if (!present.length) return { ...base, extracted: null, difference: null, status: "unmatched" as const };
    const sumCents = present.reduce((acc, n) => acc + Math.round(totals.get(n)! * 100), 0);
    const diffCents = sumCents - Math.round(s.amount * 100);
    return { ...base, extracted: sumCents / 100, difference: diffCents / 100,
      status: Math.abs(diffCents) <= 1 ? "matches" as const : "differs" as const };
  });
}

/** Review warnings: each mismatch names the lot and the difference. Nothing is corrected. */
export function checkSectionSubtotals(
  printed: PrintedSubtotal[] | null | undefined,
  lineItems: Array<{ total?: number | null; lineNumber?: number }>,
): ValidationWarning[] {
  const rows = compareSectionSubtotals(printed, lineItems);
  const warnings: ValidationWarning[] = [];
  for (const r of rows) {
    if (r.status !== "differs") continue;
    const diff = r.difference!;
    const count = r.lineNumbers.length;
    warnings.push({
      field: "sectionSubtotal",
      key: `sectionSubtotal:${canonicalSectionLabel(r.label)}:${r.printed}`,
      expected: r.printed,
      actual: r.extracted ?? undefined,
      lines: r.lineNumbers,
      ...(r.page ? { pages: [r.page] } : {}),
      message: `Lot "${r.label}": the printed subtotal is ${eur(r.printed)} but its ${count} extracted line${count > 1 ? "s" : ""} (${lineRange(r.lineNumbers)}) add up to ${eur(r.extracted!)}, ${diff > 0 ? "over" : "under"} by ${eur(Math.abs(diff))}. Check this lot's lines against the PDF${r.page ? ` (page ${r.page})` : ""}; nothing has been corrected.`,
      severity: "warning",
    });
  }
  const unmatched = rows.filter(r => r.status === "unmatched").map(r => r.label);
  if (unmatched.length) {
    warnings.push({
      field: "sectionSubtotalUnmatched",
      expected: unmatched.length,
      actual: 0,
      message: `Printed subtotal${unmatched.length > 1 ? "s" : ""} for ${unmatched.map(l => `"${l}"`).join(", ")} could not be matched to extracted lines, so ${unmatched.length > 1 ? "those lots were" : "that lot was"} not checked. Compare ${unmatched.length > 1 ? "them" : "it"} with the PDF.`,
      severity: "warning",
    });
  }
  return warnings;
}

function lineRange(numbers: number[]): string {
  const parts: string[] = [];
  let start = numbers[0], prev = numbers[0];
  for (const n of numbers.slice(1).concat([NaN])) {
    if (n === prev + 1) { prev = n; continue; }
    parts.push(start === prev ? `line ${start}` : `lines ${start}–${prev}`);
    start = prev = n;
  }
  return parts.join(", ");
}
