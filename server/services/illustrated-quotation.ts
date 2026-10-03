import type { ParsedDocument } from "../gmail/document-parser";

export interface IllustratedPriceRow {
  unitPrice: number;
  quantity: number;
  total: number;
  page: number;
  reference?: string;
}
const number = (s: string) => Number(s.replace(/[\s\u00a0\u202f]/g, "").replace(",", "."));
const adjustments = /(?:^|[^a-zà-ÿ])(?:options?|variantes?|remises?|rabais|ristournes?|escompte|discount|alternative|moins[- ]value|plus[- ]value)(?=$|[^a-zà-ÿ])/i;
const cents = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : null;

export interface IllustratedEvidence {
  detected: boolean;
  rows: IllustratedPriceRow[];
  reason: string;
}

/** Reference-led product cards with explicit HT labels, never a generic
 * table/total-difference heuristic. A continuation must name the current item.
 * Mixed, incomplete or adjusted layouts remain review-only. */
export function illustratedEvidence(texts: Array<string | null>): IllustratedEvidence {
  const text = texts.join("\n");
  const legacySignal = (text.match(/fourniture et pose.*:/gi)?.length ?? 0) >= 3;
  const refLabel = /^\s*(?:rep[èe]re|r[ée]f[ée]rence produit)\s*:/i;
  const illustration = /(?:dessin technique|sch[ée]ma|vue (?:int[ée]rieure|ext[ée]rieure|de face))/i;
  const detected = legacySignal || (text.split("\n").some(l => refLabel.test(l)) && illustration.test(text));
  const reject = (reason: string): IllustratedEvidence => ({ detected, rows: [], reason });
  if (!detected) return reject("");
  if (texts.some(t => !t?.trim())) return reject("Missing source-page text; review product identities against the original PDF.");
  if (adjustments.test(text)) return reject("Options or discounts require review; the original rows and financial treatment are preserved.");
  if (legacySignal) {
    const rows = legacyPriceRows(texts);
    return { detected, rows, reason: rows.length ? "" : "Incomplete supply/install price evidence; review the original PDF." };
  }
  const rows: IllustratedPriceRow[] = [];
  let printedHt: number | undefined;
  const seen = new Set<string>();
  let current: { reference: string; illustrated: boolean; row?: IllustratedPriceRow } | undefined;
  const finish = () => {
    if (!current?.illustrated || !current.row) return false;
    rows.push(current.row);
    return true;
  };
  const money = "([\\d\\s\\u00a0\\u202f]+[,.]\\d{2})";
  const qty = "(\\d+(?:[,.]\\d+)?)";
  const quantityFirst = new RegExp(`^\\s*(?:Quantité|Qté)\\s*:\\s*${qty}\\s+(?:Prix unitaire HT|P\\.U\\. HT)\\s*:\\s*${money}\\s+(?:Total HT|Montant HT)\\s*:\\s*${money}\\s*$`, "i");
  const priceFirst = new RegExp(`^\\s*(?:Prix unitaire HT|P\\.U\\. HT)\\s*:\\s*${money}\\s+(?:Quantité|Qté)\\s*:\\s*${qty}\\s+(?:Total HT|Montant HT)\\s*:\\s*${money}\\s*$`, "i");
  for (let page = 0; page < texts.length; page++) {
    const pageText = texts[page];
    for (const line of pageText!.split("\n")) {
      if (refLabel.test(line)) {
        const match = line.match(/^\s*(?:rep[èe]re|r[ée]f[ée]rence produit)\s*:\s*([A-Z0-9][A-Z0-9_-]{1,39})(\s+\(suite\))?\s*$/i);
        if (!match) return reject("Ambiguous product reference; review required.");
        const reference = match[1].toUpperCase();
        if (match[2]) {
          if (current?.reference !== reference) return reject("Unmatched continuation reference; review required.");
          continue;
        }
        if ((current && !finish()) || seen.has(reference)) return reject("Missing or repeated product evidence; review required.");
        seen.add(reference);
        current = { reference, illustrated: false };
        continue;
      }
      if (current && illustration.test(line)) current.illustrated = true;
      const q = line.match(quantityFirst);
      const p = line.match(priceFirst);
      const sourceTotal = line.match(/^\s*TOTAL GENERAL HT\s*:\s*([\d\s]+[,.]\d{2})\s*$/i);
      if (/TOTAL GENERAL HT/i.test(line)) {
        if (printedHt !== undefined || !sourceTotal) return reject("Multiple or unreadable printed HT totals; review required.");
        printedHt = number(sourceTotal[1]);
        if (!Number.isFinite(printedHt)) return reject("Invalid printed HT total; review required.");
        continue;
      }
      if (q || p) {
        if (!current || current.row) return reject("Multiple or unassigned prices; review required.");
        const unitPrice = number(q ? q[2] : p![1]);
        const quantity = number(q ? q[1] : p![2]);
        const total = number((q ?? p)![3]);
        if (![unitPrice, quantity, total].every(Number.isFinite) || quantity <= 0 || unitPrice < 0
          || Math.abs(unitPrice * quantity - total) > 0.011) return reject("Unreconciled product price evidence; review required.");
        current.row = { unitPrice, quantity, total, reference: current.reference, page: page + 1 };
      } else if ((/\d/.test(line)
        && !/^\s*(?:dessin technique|sch[ée]ma|vue (?:int[ée]rieure|ext[ée]rieure|de face))\s*-\s*dimensions\s+\d+\s*x\s*\d+\s*mm\s*$/i.test(line))
        || /(?:^|[^a-zà-ÿ])(?:livraison|avoir|cr[ée]dit|frais|suppl[ée]ment|transport|port)(?=$|[^a-zà-ÿ])/i.test(line)) {
        // Unknown numbers are not assumed to be non-financial specifications.
        // Fail closed without a fee vocabulary: integer adjustments can cancel.
        return reject("Unrecognized monetary row; review required.");
      }
    }
  }
  if (!finish() || rows.length < 3) return reject("Incomplete illustrated product evidence; review required.");
  if (printedHt === undefined || cents(printedHt) !== cents(rows.reduce((sum, row) => sum + row.total, 0))) {
    return reject("Printed source HT is missing or does not match every product row; review required.");
  }
  return { detected, rows, reason: "" };
}

/** Narrow evidence gate: illustrated supply/install blocks, not arbitrary tables.
 * Price rows introduce the image/specification block that follows them.
 * Reject the entire shape if even one introducing row cannot be transcribed.
 */
export function illustratedPriceRows(texts: Array<string | null>): IllustratedPriceRow[] {
  return illustratedEvidence(texts).rows;
}

function legacyPriceRows(texts: Array<string | null>): IllustratedPriceRow[] {
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
      if (![row.quantity, row.unitPrice, row.total].every(Number.isFinite)
        || row.quantity <= 0 || Math.abs(row.unitPrice * row.quantity - row.total) > 0.011) return [];
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
  if (!rows.length || candidate.documentType !== "quotation" || !lines || lines.length !== rows.length) return null;
  if (baseline.lineItems?.some(l => adjustments.test(l.description))) return null;
  if (cents(baseline.amountHt) === null || cents(candidate.amountHt) !== cents(baseline.amountHt)) return null;
  if (cents(rows.reduce((s, r) => s + r.total, 0)) !== cents(baseline.amountHt)) return null;
  if (!lines.every((line, i) =>
    typeof line.description === "string" && line.description.trim().length > 60
    && !adjustments.test(line.description)
    && (!rows[i].reference || (
      line.description.toUpperCase().split(/[^A-Z0-9_-]+/).includes(rows[i].reference!)
      && !rows.some((r, j) => j !== i && r.reference
        && line.description.toUpperCase().split(/[^A-Z0-9_-]+/).includes(r.reference))
    ))
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

export function sourceRowsReconcile(baseline: ParsedDocument, rows: IllustratedPriceRow[]): boolean {
  return rows.length > 0 && cents(baseline.amountHt) !== null
    && cents(rows.reduce((sum, row) => sum + row.total, 0)) === cents(baseline.amountHt)
    && !baseline.lineItems?.some(line => adjustments.test(line.description));
}