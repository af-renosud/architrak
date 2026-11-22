import type { ParsedDocument } from "../gmail/document-parser";

const amount = String.raw`-?\d+(?:[ \u00a0]\d{3})*,\d{2}`;
const numeric = (s: string) => Number(s.replace(/[ \u00a0]/g, "").replace(",", "."));
const cents = (n: number) => Math.round(n * 100);
const header = /N°\s+Désignation\s+Un\s+Quantité\s+Prix unit\.\s+Montant H\.T\./i;
const price = new RegExp(String.raw`^\s*(\d+(?:\.\d+)+)\s{2,}(.+?)\s{2,}(\S+)\s+(\d+(?:[ \u00a0]\d{3})*,\d{3})(?:\s{2,}(${amount})\s{2,}(${amount}))?\s*$`);

export function readNumberedPrice(text: string) {
  const m = text.match(price);
  if (!m) return null;
  return { reference: m[1], description: m[2], unit: m[3], quantity: numeric(m[4]),
    unitPrice: m[5] === undefined ? undefined : numeric(m[5]),
    total: m[6] === undefined ? undefined : numeric(m[6]) };
}

/**
 * Strict numbered Sage-style tables. Every section is closed by a printed
 * subtotal and independently checked against the recap. Unknown table rows,
 * broken numbering, missing subtotals or unexplained money refuse recovery.
 * Blank price columns remain absent, not fabricated zero-price evidence.
 */
export function recoverNumberedTable(pages: Array<string | null>) {
  if (!pages.length || pages.length > 80 || pages.some(p => p == null)
    || pages.reduce((n, p) => n + (p?.length ?? 0), 0) > 2_000_000) return null;
  const rows: NonNullable<ParsedDocument["lineItems"]> = [];
  const evidence: Array<{ pages: number[]; priceText: string; sourceText: string }> = [];
  const sections = new Map<string, { sum: number; closed: boolean; children: number }>();
  const recaps = new Map<string, number>();
  let stack: string[] = [], current = -1, inTable = false, recap = false;
  let ht: number | undefined, ttc: number | undefined, tax: number | undefined, tvaRate: number | undefined;
  let found = false;
  const pendingText: string[] = [];
  const moneyAtEnd = new RegExp(String.raw`(${amount})\s*$`);
  const unexplainedMoney = (text: string) => moneyAtEnd.test(text)
    || /\s{2,}[+\-−]?\d[\d ,.\u00a0]*(?:\s*(?:€|EUR|HT|TTC))?(?:\s|$)/i.test(text);
  const printedTotal = new RegExp(String.raw`^Total (H\.T\.|T\.T\.C\.|T\.V\.A\.\s+[\d,]+\s*%)\s+(${amount})\s*$`, "i");
  for (let p = 0; p < pages.length; p++) {
    inTable = false;
    for (const raw of pages[p]!.split(/\r?\n/)) {
      const text = raw.trim();
      if (!text) continue;
      const total = text.match(printedTotal);
      if (total) {
        const value = numeric(total[2]);
        if (/^H/i.test(total[1])) { if (ht !== undefined) return null; ht = value; }
        else if (/^T\.T/i.test(total[1])) { if (ttc !== undefined) return null; ttc = value; }
        else {
          if (tax !== undefined) return null;
          tax = value;
          const rate = numeric(total[1].match(/([\d,]+)\s*%/)![1]);
          tvaRate = rate;
          if (ht === undefined || cents(ht * rate / 100) !== cents(tax)) return null;
        }
        current = -1; continue;
      }
      if (header.test(text)) {
        if (recap) return null;
        inTable = true; found = true; continue;
      }
      if (/^N°\s+Récapitulatif\s+Quantité\s+Prix U\.\s+Montant H\.T\./i.test(text)) {
        if (stack.length) return null;
        recap = true; current = -1; continue;
      }
      // Repeated letterhead/footer are outside the table, not specifications.
      if (/^Réf\. Devis\s*:|^©Sage|^- SIRET\s*:/.test(text)) { inTable = false; continue; }
      if (/Tél\s*:.*Fax\s*:.*email\s*:/i.test(text)) { inTable = false; continue; }
      if (recap) {
        const r = text.match(new RegExp(String.raw`^(\d+(?:\.\d+)*)\s{2,}.+?\s{2,}1,000\s+(${amount})\s+(${amount})$`));
        if (r) {
          if (recaps.has(r[1]) || numeric(r[2]) !== numeric(r[3])) return null;
          recaps.set(r[1], cents(numeric(r[3]))); continue;
        }
        if (unexplainedMoney(text) || /^\d+(?:\.\d+)*\s{2,}/.test(text)) return null;
        continue;
      }
      if (!inTable) {
        const net = text.match(new RegExp(String.raw`^(?:représentant \d+% du présent devis\.\s+)?Net à payer \(Euro\)\s+(${amount})$`, "i"));
        if (net) {
          if (ttc === undefined || cents(numeric(net[1])) !== cents(ttc)) return null;
        } else if ((found && unexplainedMoney(text)) || moneyAtEnd.test(text)
          || /\d[\d ,.\u00a0]*\s*(?:€|EUR|HT|TTC)\b/i.test(text)) return null;
        continue;
      }
      const item = readNumberedPrice(raw);
      if (item) {
        const parent = item.reference.split(".").slice(0, -1).join(".");
        const section = sections.get(parent);
        const index = Number(item.reference.split(".").at(-1));
        if (!section || section.closed || stack.at(-1) !== parent || index !== section.children + 1) return null;
        section.children++;
        if (item.total !== undefined && cents(item.quantity * item.unitPrice!) !== cents(item.total)) return null;
        for (const ref of stack) sections.get(ref)!.sum += cents(item.total ?? 0);
        rows.push({ description: [...pendingText.splice(0), `${item.reference} ${item.description}`].join(" "), quantity: item.quantity,
          unit: item.unit, unitPrice: item.unitPrice, total: item.total, pageHint: p + 1 });
        current = rows.length - 1;
        evidence.push({ pages: [p + 1], priceText: raw.trim(), sourceText: rows[current].description });
        continue;
      }
      const heading = text.match(/^(\d+(?:\.\d+)*)\s{2,}(.+)$/);
      if (heading) {
        const ref = heading[1], parent = ref.split(".").slice(0, -1).join(".");
        if (sections.has(ref) || moneyAtEnd.test(text) || (parent ? stack.at(-1) !== parent : stack.length !== 0)) return null;
        const siblings = Array.from(sections.keys()).filter(k => k.split(".").slice(0, -1).join(".") === parent);
        if (Number(ref.split(".").at(-1)) !== siblings.length + 1) return null;
        pendingText.push(text);
        sections.set(ref, { sum: 0, closed: false, children: 0 }); stack.push(ref); current = -1; continue;
      }
      if (/^Sous-total\s/i.test(text)) {
        const m = text.match(moneyAtEnd), ref = stack.pop();
        if (!m || !ref || sections.get(ref)!.sum !== cents(numeric(m[1]))) return null;
        sections.get(ref)!.closed = true; current = -1; continue;
      }
      // Only text in the description column can continue a row or a heading.
      // A numeric column without a supported row is never silently discarded.
      if (/\s{2,}\S/.test(text) || moneyAtEnd.test(text) || /^\d+(?:\.\d+)*\s/.test(text)) return null;
      if (current >= 0) {
        rows[current].description += ` ${text}`;
        evidence[current].sourceText = rows[current].description;
        if (!evidence[current].pages.includes(p + 1)) evidence[current].pages.push(p + 1);
      } else pendingText.push(text);
    }
  }
  if (!found || !recap || stack.length || !rows.length || ht === undefined || ttc === undefined || tax === undefined
    || cents(ht) + cents(tax) !== cents(ttc) || sections.size !== recaps.size
    || Array.from(sections).some(([ref, s]) => !s.closed || recaps.get(ref) !== s.sum)
    || rows.reduce((n, r) => n + cents(r.total ?? 0), 0) !== cents(ht)) return null;
   if (pendingText.length) return null;
   return { rows, evidence, amountHt: ht, amountTtc: ttc, tvaRate };
}
