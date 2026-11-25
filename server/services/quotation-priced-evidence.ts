import { createHash } from "node:crypto";
import type { ParsedDocument } from "../gmail/document-parser";
import { readNumberedPrice } from "./quotation-numbered-table";
import { CODED_LOT_TABLE_PARSER, codedLotRowProblem } from "./quotation-coded-lot-table";

export const PRICED_EVIDENCE_PARSER = "priced-source-v1";
export interface PricedEvidence {
  parser: typeof PRICED_EVIDENCE_PARSER;
  sourceDigest: string;
  rowsDigest: string;
  issues: Array<{ line: number; page?: number; reason: string }>;
}
/** Sentence casing at persistence is not an edit; words and money still are. */
export function pricedRowsDigest(rows: NonNullable<ParsedDocument["lineItems"]>) {
  return createHash("sha256").update(JSON.stringify(rows.map(row => ({
    description: row.description.toLocaleLowerCase("fr").replace(/\s+/g, " ").trim(),
    total: row.total == null ? null : Math.round(row.total * 100),
  })))).digest("hex");
}

export function collectPricedEvidence(parsed: ParsedDocument, pdf: Buffer): PricedEvidence {
  const rows = parsed.lineItems ?? [];
  const sourceDigest = createHash("sha256").update(pdf).digest("hex");
  const native = parsed.nativeTableRecovery;
  if (native?.parser === CODED_LOT_TABLE_PARSER) {
    // Name exactly the rows that fail to pair; matching rows need no review.
    const fresh = native.sourceDigest === sourceDigest;
    const issues = !fresh ? rows.map((row, i) => ({ line: i + 1, page: row.pageHint, reason: "The original PDF changed since it was read." }))
      : rows.length !== native.evidence.length
        ? [{ line: 1, reason: `The PDF lists ${native.evidence.length} priced items but ${rows.length} were extracted. Review the items against the original PDF.` }]
        : native.evidence.flatMap((entry, i) => {
          const problem = codedLotRowProblem(entry as any, rows[i])
            ?? (rows[i].vatRate !== entry.vatRate ? "The printed VAT rate was not applied to this item." : null);
          return problem ? [{ line: i + 1, page: entry.pages[0], reason: problem }] : [];
        });
    return { parser: PRICED_EVIDENCE_PARSER, sourceDigest, rowsDigest: pricedRowsDigest(rows), issues };
  }
  const supported = native?.sourceDigest === sourceDigest
    && native.evidence.length === rows.length
    && native.evidence.every((entry, i) => {
      if (native.parser === "numbered-table-v2" || native.parser === "numbered-table-v3") {
        const source = readNumberedPrice(entry.priceText);
        return !!source && entry.sourceText === rows[i].description
          && source.quantity === rows[i].quantity && source.unit === rows[i].unit
          && source.unitPrice === rows[i].unitPrice && source.total === rows[i].total;
      }
      const fields = entry.priceText.split(/\s{2,}/);
      const numbers = fields.slice(-5).map(value => Number(value.replace(/[ \u00a0]/g, "").replace(",", ".")));
      return fields.length >= 6 && numbers.every(Number.isFinite)
        && entry.sourceText === rows[i].description
        && numbers[0] === rows[i].quantity
        && numbers[1] === rows[i].unitPrice
        && numbers[2] === rows[i].total;
    });
  return {
    parser: PRICED_EVIDENCE_PARSER, sourceDigest,
    // Storage represents an unpriced context row's contribution as zero.
    // Keep its original blank columns in native evidence, but fingerprint the
    // persisted representation so saving does not invalidate genuine evidence.
    rowsDigest: pricedRowsDigest((native?.parser === "numbered-table-v2" || native?.parser === "numbered-table-v3")
      ? rows.map(row => ({ ...row, total: row.total ?? 0 })) : rows),
    issues: supported ? [] : rows.length ? rows.map((row, i) => ({
      line: i + 1, page: row.pageHint,
      reason: "The description and charge have not been independently verified together in the original PDF. Review this item in Edit working quotation and confirm the original source total.",
    })) : [{ line: 1, reason: "No source-supported priced items were extracted. Review the original PDF and record the quotation in Edit working quotation." }],
  };
}
