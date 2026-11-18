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
      for (const key of ["ht", "ttc"]) {
        const match = text.match(new RegExp(String.raw`\bTotal ${key}\s+(${amount})\s*$`, "i"));
        if (match) totals[key].push(number(match[1]));
      }
      if (/Description\s+Qté\s+P\.U\. HT\s+Montant HT\s+Montant TTC\s+TVA/i.test(text)) {
        inTable = true; found = true; continue;
      }
      if (!inTable) continue;
      if (/^Siret\s*:|^Devis gratuit|^Taux\s+Base HT|^Coordonnées bancaires/i.test(text)) {
        inTable = false; continue;
      }
      if (!text) continue;
      const match = raw.match(columns);
      const description = (match?.[1] ?? text).trim();
      if (/^-{5,}$|^LOT\s/i.test(description)) {
        if (match && match.slice(2).some(value => number(value) !== 0)) invalid = true;
        if (!match && /\s{2,}-?\d[\d ,.]*\s*(?:€|EUR)?\s*$/.test(raw)) invalid = true;
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
        // An unparsed numeric column is not silently discarded.
        if (/\s{2,}-?\d[\d ,.]*\s*(?:€|EUR)?\s*$/.test(raw)) invalid = true;
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
  return { rows, evidence, amountHt: totals.ht[0], amountTtc: totals.ttc[0] };
}
