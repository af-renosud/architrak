import type { ParsedDocument } from "../gmail/document-parser";

export interface IllustratedPriceRow {
  unitPrice: number;
  quantity: number;
  total: number;
  page: number;
}
const number = (s: string) => Number(s.replace(/[\s\u00a0\u202f]/g, "").replace(",", "."));

/** Narrow evidence gate: illustrated supply/install blocks, not arbitrary tables.
 * Price rows introduce the image/specification block that follows them.
 * Reject the entire shape if even one introducing row cannot be transcribed.
 */
export function illustratedPriceRows(texts: Array<string | null>): IllustratedPriceRow[] {
  const rows: IllustratedPriceRow[] = [];
  let introductions = 0;
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index];
    for (const line of (text ?? "").split("\n")) {
      if (!/fourniture et pose.*:/i.test(line)) continue;
      introductions++;
      const tail = line.slice(line.lastIndexOf(":") + 1);
      const m = tail.match(/^\s*([\d\s\u00a0\u202f]+,\d{2})\s+(\d+(?:[,.]\d+)?)\s+([\d\s\u00a0\u202f]+,\d{2})\s+(\d+(?:[,.]\d+)?)\s*$/);
      if (!m) return [];
      const row = { unitPrice: number(m[1]), quantity: number(m[2]), total: number(m[3]), page: index + 1 };
      if (row.quantity <= 0 || Math.abs(row.unitPrice * row.quantity - row.total) > 0.011) return [];
      rows.push(row);
    }
  }
  // Repeated placeholders indicate that substantive descriptions live elsewhere.
  const placeholders = texts.join("\n").match(/compos[ée]\s+de/gi)?.length ?? 0;
  return introductions >= 3 && placeholders >= 3 ? rows : [];
}

export function acceptIllustratedRecovery(
  baseline: ParsedDocument, candidate: ParsedDocument, rows: IllustratedPriceRow[],
): ParsedDocument["lineItems"] | null {
  const lines = candidate.lineItems;
  const cents = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : null;
  if (!rows.length || candidate.documentType !== "quotation" || !lines || lines.length !== rows.length) return null;
  if (cents(baseline.amountHt) === null || cents(candidate.amountHt) !== cents(baseline.amountHt)) return null;
  if (cents(rows.reduce((s, r) => s + r.total, 0)) !== cents(baseline.amountHt)) return null;
  if (!lines.every((line, i) =>
    typeof line.description === "string" && line.description.trim().length > 60
    && cents(line.total) === cents(rows[i].total)
    && cents(line.unitPrice) === cents(rows[i].unitPrice)
    && line.quantity === rows[i].quantity
  )) return null;
  // Prices and page provenance come from exact source rows, not AI page guesses.
  // Native boxes may surround an illustration on a continuation page: discard.
  return lines.map((line, i) => ({
    description: line.description,
    total: rows[i].total, unitPrice: rows[i].unitPrice, quantity: rows[i].quantity,
    unit: line.unit, pageHint: rows[i].page,
  }));
}