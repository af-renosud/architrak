import type { ParsedDocument } from "../gmail/document-parser";

/**
 * Bounded native-text recovery for Description/Qté/PU HT/Montant HT/TTC/TVA
 * tables whose specifications precede a terminating price. No model output is
 * evidence here. Reject the entire recovery on unaccounted non-zero columns,
 * ambiguous boundaries or an independent printed-total disagreement.
 */
export function recoverPosteTable(pages: Array<string | null>) {
  if (!pages.length || pages.length > 80 || pages.some(p => !p?.trim())
    || pages.reduce((size, page) => size + (page?.length ?? 0), 0) > 2_000_000) return null;
  const rows: NonNullable<ParsedDocument["lineItems"]> = [];
  const evidence: Array<{ pages: number[]; priceText: string; sourceText: string }> = [];
  let pending: string[] = [], pendingPages = new Set<number>();
  let current: typeof rows[number] | null = null;
  let inTable = false, found = false, invalid = false, lotHeading = false;
  let terminalRows = 0;
  const totals: Record<string, number[]> = { ht: [], ttc: [] };
  const number = (s: string) => Number(s.replace(/[ \u00a0]/g, "").replace(",", "."));
  const amount = String.raw`-?\d[\d \u00a0]*,\d{2}`;
  const columns = new RegExp(String.raw`^(.*?)\s{2,}(${amount})\s{2,}(${amount})\s{2,}(${amount})\s{2,}(${amount})\s{2,}(${amount})\s*$`);
  const reference = /^(?:[A-Z]{1,4}\.\s*\d{1,3})(?:\s|[-.])/i;
  const unsupportedMoney = (raw: string) =>
    /\s{2,}[+-]?\d[\d ,.\u00a0]*\s*(?:€|EUR)?\s*$/i.test(raw)
    // A monetary token need not terminate the row: HT/TTC, notes or currency
    // can follow it. Ambiguous decimal prose fails closed in this narrow parser.
    || /(?:^|[^\d])[+\-−]?\(?\d[\d \u00a0]*[,.]\d{2}(?!\d)/.test(raw)
    || /[+\-−]?\d[\d ,.\u00a0]*\s*(?:EUR|HT|TTC)\b/i.test(raw)
    || /(?:€|EUR)\s*[+\-−]?\d/i.test(raw)
    || /[+\-−]?\d[\d ,.\u00a0]*\s*€/.test(raw);
  let taxSummary = false;
  const taxRows: Array<{ rate: number; base: number; tax: number }> = [];
  // Only known, bounded summary/metadata shapes may carry numbers outside the
  // item table. Unknown charges here invalidate recovery just like table rows.
  const safeOutsideMoney = (text: string) => {
    if (/^Siret\s*:/i.test(text)) return /^Siret\s*:\s*[\d ]+\s*-\s*APE\s*:\s*\w+\s*-\s*RCS\s*:\s*[\d ]+\s*-\s*N° TVA intracom\s*:\s*\w+\s*-\s*Capital\s*:\s*[\d ,]+\s*€$/i.test(text);
    let rest = text;
    rest = rest.replace(/^Coordonnées bancaires société\s*:\s+(?=Net à payer\s)/i, "");
    if (taxSummary) {
      const taxRow = rest.match(new RegExp(String.raw`^(${amount})\s{2,}(${amount})\s{2,}(${amount})(?:\s{2,}|$)`));
      if (taxRow) {
        const [rate, base, tax] = taxRow.slice(1).map(number);
        if (rate < 0 || rate > 100 || base < 0 || Math.abs(base * rate / 100 - tax) > 0.011) return false;
        taxRows.push({ rate, base, tax });
        rest = rest.slice(taxRow[0].length).trim();
        if (!rest) return true;
      }
      rest = rest.replace(/^Taux\s+Base HT\s+Montant TVA\s+/i, "");
    }
    if (!found) return false;
    if (new RegExp(String.raw`^(?:Total HT|Total TTC|Total TVA|Net à payer)\s+${amount}\s*€?$`, "i").test(rest)) return true;
    const discount = rest.match(new RegExp(String.raw`^Remise\s+(${amount})%\s+(${amount})$`, "i"));
    return !!discount && number(discount[1]) === 0 && number(discount[2]) === 0;
  };
  const append = (text: string, page: number) => {
    if (!text) return;
    if (current) {
      current.description += `\n${text}`;
      const entry = evidence[evidence.length - 1];
      entry.sourceText += `\n${text}`;
      if (!entry.pages.includes(page)) entry.pages.push(page);
    } else {
      pending.push(text); pendingPages.add(page);
    }
  };
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    // Unsupported headerless pages may contain continuation specifications or
    // cancelling adjustments. Never certify a partially accounted document.
    if (!/Description\s+Qté\s+P\.U\. HT\s+Montant HT\s+Montant TTC\s+TVA/i.test(page!)) return null;
    inTable = false;
    for (const raw of page!.split(/\r?\n/)) {
      const text = raw.trim();
      if (/^Taux\s+Base HT\s+Montant TVA/i.test(text)) taxSummary = true;
      for (const key of ["ht", "ttc"]) {
        const match = text.match(new RegExp(String.raw`\bTotal ${key}\s+(${amount})\s*$`, "i"));
        if (match) totals[key].push(number(match[1]));
      }
      if (/Description\s+Qté\s+P\.U\. HT\s+Montant HT\s+Montant TTC\s+TVA/i.test(text)) {
        if (unsupportedMoney(raw)) invalid = true;
        inTable = true; found = true; continue;
      }
      if (!inTable) {
        if (unsupportedMoney(raw) && !safeOutsideMoney(text)) invalid = true;
        continue;
      }
      if (/^Siret\s*:|^Devis gratuit|^Taux\s+Base HT|^Coordonnées bancaires/i.test(text)) {
        if (unsupportedMoney(raw) && !safeOutsideMoney(text)) invalid = true;
        inTable = false; continue;
      }
      if (!text) continue;
      const match = raw.match(columns);
      if (!match && unsupportedMoney(raw)) invalid = true;
      const description = (match?.[1] ?? text).trim();
      // Zero numeric columns cannot legitimise a charge in the description,
      // especially when that description will be discarded as a LOT heading.
      if (match && unsupportedMoney(match[1])) invalid = true;
      if (/^-{5,}$|^LOT\s/i.test(description)) {
        if (match && match.slice(2).some(value => number(value) !== 0)) invalid = true;
        if (pending.length) invalid = true;
        current = null;
        lotHeading = /^LOT\s/i.test(description);
        continue;
      }
      if (reference.test(description)) {
        if (pending.length) invalid = true;
        current = null;
        lotHeading = false;
      }
      if (lotHeading) {
        if (match && match.slice(2).some(value => number(value) !== 0)) invalid = true;
        continue;
      }
      if (match) {
        const [quantity, unitPrice, total, ttc, vat] = match.slice(2).map(number);
        if ([quantity, unitPrice, total, ttc, vat].every(n => n === 0)) {
          append(description, index + 1); continue;
        }
        if (quantity <= 0 || total <= 0 || vat < 0 || vat > 100
          || Math.abs(quantity * unitPrice - total) > 0.011
          || Math.abs(total * (1 + vat / 100) - ttc) > 0.011) { invalid = true; continue; }
        // A new charged row may follow a completed item without a separator.
        current = null;
        const terminal = /^T\s*OT\s*AL DU POST\s*E/i.test(description);
        if (terminal) terminalRows++;
        if (terminal && !pending.length) { invalid = true; continue; }
        if (!terminal) pending.push(description);
        pendingPages.add(index + 1);
        if (!pending.join("").trim()) { invalid = true; continue; }
        current = { description: pending.join("\n"), quantity, unitPrice, total,
          pageHint: Math.min(...Array.from(pendingPages)) };
        rows.push(current);
        evidence.push({ pages: Array.from(pendingPages), priceText: raw.trim(), sourceText: current.description });
        pending = []; pendingPages = new Set();
      } else {
        // Unsupported monetary content was checked before any skipped region.
        append(description, index + 1);
      }
    }
  }
  if (!found || invalid || pending.length || !rows.length || terminalRows < 2
    || totals.ht.length !== 1 || totals.ttc.length !== 1) return null;
  const sum = rows.reduce((n, row) => n + Math.round(row.total! * 100), 0);
  const gross = evidence.reduce((n, entry) => {
    const match = entry.priceText.match(columns);
    return n + Math.round(number(match![5]) * 100);
  }, 0);
  if (sum !== Math.round(totals.ht[0] * 100) || gross !== Math.round(totals.ttc[0] * 100)) return null;
  if (taxRows.length) {
    const bases = new Map<number, number>();
    for (const entry of evidence) {
      const price = entry.priceText.match(columns)!;
      const rate = number(price[6]);
      bases.set(rate, (bases.get(rate) ?? 0) + Math.round(number(price[4]) * 100));
    }
    // A numeric block is accepted as tax metadata only when every printed
    // rate/base actually describes the recovered charges, without duplicates.
    if (taxRows.length !== bases.size || new Set(taxRows.map(row => row.rate)).size !== taxRows.length
      || taxRows.some(row => bases.get(row.rate) !== Math.round(row.base * 100))
      || taxRows.reduce((n, row) => n + Math.round(row.tax * 100), 0) !== gross - sum) return null;
  }
  return { rows, evidence, amountHt: totals.ht[0], amountTtc: totals.ttc[0] };
}
