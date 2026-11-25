import type { ParsedDocument } from "../gmail/document-parser";

/**
 * Strict native-text reader for Code / Description / Qté / Unité / P.U. HT /
 * % Rem / Montant HT / TVA tables (e.g. Stimulsoft-rendered EBP-style quotes
 * whose headings are letter-spaced). Every priced row carries its printed VAT
 * rate. Recovery is accepted only when the rows, every LOT subtotal, the
 * per-rate VAT summary and the printed HT/TVA/TTC all reconcile to the cent.
 * Unknown money inside the table refuses the whole recovery.
 */
export const CODED_LOT_TABLE_PARSER = "coded-lot-table-v1" as const;
const amount = String.raw`\d{1,3}(?:[ \u00a0]\d{3})*,\d{2}`;
const qty = String.raw`\d{1,3}(?:[ \u00a0]\d{3})*(?:,\d{1,5})?`;
const header = /^\s*Code\s+Description\s+Qté\s+Unité\s+P\.U\. HT\s+% Rem\s+Montant HT\s+TVA\s*$/i;
const row = new RegExp(String.raw`^(.*?)\s{2,}(${qty})(?:\s{2,}([A-Za-z][A-Za-z0-9²³]{0,5}))?\s{2,}(${amount})\s{2,}(${amount})\s{2,}(\d{1,3},\d{2})\s*$`);
const trailingMoney = new RegExp(String.raw`\s{2,}-?${amount}\s*$`);
const numeric = (s: string) => Number(s.replace(/[ \u00a0]/g, "").replace(",", "."));
const cents = (n: number) => Math.round(n * 100);
/** Letter-spacing, accents and punctuation removed: the identity of printed words. */
export const compactWords = (text: string) => text.toLocaleLowerCase("fr").normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/œ/g, "oe").replace(/[^a-z0-9]/g, "");

export interface CodedLotEvidence {
  pages: number[]; priceText: string; sourceText: string;
  /** Printed first description line, code column excluded where present. */
  heading: string; code: string | null; vatRate: string;
}
export interface CodedLotRecovery {
  rows: NonNullable<ParsedDocument["lineItems"]>;
  evidence: CodedLotEvidence[];
  amountHt: number; amountTtc: number; tvaAmount: number;
  vatSummary: Array<{ rate: string; baseHt: number; vat: number }>;
}

/** The printed money of one evidence row, re-read from its retained text. */
export function readCodedLotPrice(priceText: string) {
  const m = priceText.match(row);
  if (!m) return null;
  return { quantity: numeric(m[2]), unit: m[3] ?? undefined, unitPrice: numeric(m[4]), total: numeric(m[5]), vatRate: rateText(m[6]) };
}
const rateText = (raw: string) => String(numeric(raw));

/** An extracted description belongs to a printed row when it contains the row's printed heading words. */
export function codedLotDescriptionMatches(entry: Pick<CodedLotEvidence, "heading" | "code">, description: string) {
  const target = compactWords(description), heading = compactWords(entry.heading);
  if (heading.length < 3) return false;
  return target.includes(heading) || (!!entry.code && target.includes(compactWords(`${entry.code}${entry.heading}`)));
}

type Row = NonNullable<ParsedDocument["lineItems"]>[number];
/** Why an extracted row does not pair with its printed row, or null when it does. */
export function codedLotRowProblem(entry: CodedLotEvidence, row: Row | undefined) {
  const printed = readCodedLotPrice(entry.priceText);
  if (!printed || !row) return "No matching item was extracted for this printed row.";
  if (printed.quantity !== row.quantity || cents(printed.unitPrice) !== cents(row.unitPrice ?? NaN) || cents(printed.total) !== cents(row.total ?? NaN))
    return "Quantity, unit price or amount differs from the PDF.";
  if (!codedLotDescriptionMatches(entry, row.description)) return "Description does not match the printed row.";
  return null;
}
/** Model rows keep their wording and gain the printed VAT only when every row pairs in order. */
export function alignCodedLotRows(model: Row[], recovery: Pick<CodedLotRecovery, "evidence">): Row[] | null {
  if (model.length !== recovery.evidence.length) return null;
  if (recovery.evidence.some((entry, i) => codedLotRowProblem(entry, model[i]))) return null;
  return model.map((row, i) => ({ ...row, vatRate: recovery.evidence[i].vatRate }));
}

export function recoverCodedLotTable(pages: Array<string | null>): CodedLotRecovery | null {
  if (!pages.length || pages.length > 80 || pages.some(p => p == null)
    || pages.reduce((n, p) => n + (p?.length ?? 0), 0) > 2_000_000) return null;
  const rows: CodedLotRecovery["rows"] = [];
  const evidence: CodedLotEvidence[] = [];
  const lots: Array<{ label: string; total: number; sum: number; closed: boolean }> = [];
  let openLot: (typeof lots)[number] | null = null;
  let current: (typeof rows)[number] | null = null;
  let afterHeading = false, summaryPage = -1;
  const summary: Array<{ rate: number; base: number; tax: number }> = [];
  const totals: Record<"ht" | "tva" | "ttc", number[]> = { ht: [], tva: [], ttc: [] };
  for (let index = 0; index < pages.length; index++) {
    const lines = pages[index]!.split(/\r?\n/);
    if (summaryPage >= 0) break; // Terms and conditions follow the summary; never item evidence.
    const start = lines.findIndex(line => header.test(line));
    if (start < 0) return null; // A headerless item page could hide charges.
    for (const raw of lines.slice(start + 1)) {
      const text = raw.trim();
      if (!text) continue;
      if (/^Siret\s*:/i.test(text) || /^\d+\s+sur\s+\d+$/.test(text) || /^Document créé par/i.test(text)) break;
      if (/^Devis gratuit|^Taux\s+Base HT/i.test(text) || /Montant HT Net/i.test(text)) { summaryPage = index; break; }
      const m = raw.match(row);
      if (!m) {
        if (trailingMoney.test(raw)) return null; // Unexplained money in the table.
        if (current && !afterHeading) {
          current.description += `\n${text}`;
          const entry = evidence[evidence.length - 1];
          entry.sourceText += `\n${text}`;
          if (!entry.pages.includes(index + 1)) entry.pages.push(index + 1);
        } else if (!afterHeading) return null; // Text before any item cannot be attributed.
        continue;
      }
      const [, left, q, unit, pu, total, vat] = m;
      const codeMatch = /^\S/.test(raw) ? left.match(/^(\S+)\s+(.*)$/) : null;
      const description = (codeMatch ? codeMatch[2] : left).trim();
      const label = compactWords(description);
      const [quantity, unitPrice, lineTotal, rate] = [numeric(q), numeric(pu), numeric(total), numeric(vat)];
      if (!description && [quantity, unitPrice, lineTotal, rate].every(n => n === 0)) { current = null; afterHeading = true; continue; }
      if (!codeMatch && rate === 0 && label.startsWith("totallot")) {
        if (!openLot || openLot.closed || cents(openLot.total) !== cents(lineTotal) || quantity !== 1) return null;
        openLot.closed = true; openLot = null; current = null; afterHeading = true; continue;
      }
      if (!codeMatch && rate === 0 && label.startsWith("lot")) {
        if ((openLot && !openLot.closed) || quantity !== 1 || cents(unitPrice) !== cents(lineTotal)) return null;
        openLot = { label, total: lineTotal, sum: 0, closed: false }; lots.push(openLot);
        current = null; afterHeading = true; continue;
      }
      if (!description || quantity <= 0 || lineTotal <= 0 || rate < 0 || rate > 100
        || Math.abs(quantity * unitPrice - lineTotal) > 0.011) return null;
      if (!codeMatch && rate === 0) return null; // Unlabelled zero-rated money is not an item.
      current = { description, quantity, unit: unit ?? undefined, unitPrice, total: lineTotal, pageHint: index + 1, vatRate: rateText(vat) };
      rows.push(current);
      evidence.push({ pages: [index + 1], priceText: raw.trim(), sourceText: description, heading: description,
        code: codeMatch?.[1] ?? null, vatRate: rateText(vat) });
      if (openLot) openLot.sum += cents(lineTotal);
      afterHeading = false;
    }
  }
  if (summaryPage < 0 || !rows.length || lots.some(lot => !lot.closed || lot.sum !== cents(lot.total))) return null;
  for (const raw of pages[summaryPage]!.split(/\r?\n/)) {
    const tax = raw.match(new RegExp(String.raw`^\s*(\d{1,3},\d{2})\s{2,}(${amount})\s{2,}(${amount})(?:\s{2,}|$)`));
    if (tax) summary.push({ rate: numeric(tax[1]), base: numeric(tax[2]), tax: numeric(tax[3]) });
    for (const [key, label] of [["ht", "Montant HT Net"], ["tva", "Total TVA"], ["ttc", "Total TTC"]] as const) {
      const match = raw.match(new RegExp(String.raw`${label}\s+(${amount})\s*€?\s*$`, "i"));
      if (match) totals[key].push(numeric(match[1]));
    }
  }
  if (totals.ht.length !== 1 || totals.tva.length !== 1 || totals.ttc.length !== 1 || !summary.length) return null;
  const [ht, tva, ttc] = [totals.ht[0], totals.tva[0], totals.ttc[0]];
  const sum = rows.reduce((n, r) => n + cents(r.total!), 0);
  if (sum !== cents(ht) || cents(ht) + cents(tva) !== cents(ttc)) return null;
  const bases = new Map<number, number>();
  for (const r of rows) bases.set(Number(r.vatRate), (bases.get(Number(r.vatRate)) ?? 0) + cents(r.total!));
  if (summary.length !== bases.size || new Set(summary.map(s => s.rate)).size !== summary.length
    || summary.some(s => bases.get(s.rate) !== cents(s.base) || Math.abs(cents(s.base * s.rate / 100) - cents(s.tax)) > 1)
    || summary.reduce((n, s) => n + cents(s.tax), 0) !== cents(tva)) return null;
  return { rows, evidence, amountHt: ht, amountTtc: ttc, tvaAmount: tva,
    vatSummary: summary.map(s => ({ rate: String(s.rate), baseHt: s.base, vat: s.tax })) };
}
