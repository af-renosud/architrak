import { Amount } from "@/components/ui/amount";
import type { LotSubtotalComparison } from "./use-quotation-extraction-review";

function lineList(numbers: number[]): string {
  if (!numbers.length) return "none matched";
  const parts: string[] = [];
  let start = numbers[0], prev = numbers[0];
  for (const n of numbers.slice(1).concat([NaN])) {
    if (n === prev + 1) { prev = n; continue; }
    parts.push(start === prev ? String(start) : `${start}–${prev}`);
    start = prev = n;
  }
  return parts.join(", ");
}

/**
 * Lot-by-lot check of an AI-read quotation: each printed lot subtotal next to
 * the sum of the lines extracted for that lot. Read-only; nothing is corrected.
 */
export function LotSubtotalCheck({ rows, sourceUrl }: { rows: LotSubtotalComparison[]; sourceUrl?: string }) {
  if (!rows.length) return null;
  const differing = rows.filter(r => r.status === "differs").length;
  const unmatched = rows.filter(r => r.status === "unmatched").length;
  const flagged = differing + unmatched > 0;
  return <details className={flagged ? "review-source-notice" : "border rounded-md p-3 text-sm"} open={flagged}
    data-testid="lot-subtotal-check">
    <summary className="cursor-pointer font-semibold">
      Lot subtotals · {rows.length} printed{differing ? ` · ${differing} differ${differing > 1 ? "" : "s"}` : ""}
      {unmatched ? ` · ${unmatched} not checked` : ""}{!flagged ? " · all match" : ""}
    </summary>
    <p className="text-muted-foreground my-2">
      Each subtotal printed on the PDF is compared with the lines extracted for that lot, so errors that cancel out in the grand total still show here.
      Nothing has been corrected; compare differing lots with the original PDF.
    </p>
    <table className="w-full text-sm">
      <thead><tr className="text-left text-muted-foreground">
        <th className="font-normal py-1">Lot</th><th className="font-normal py-1 text-right">Printed</th>
        <th className="font-normal py-1 text-right">Extracted lines</th><th className="font-normal py-1 text-right">Difference</th>
        <th className="font-normal py-1 pl-3">Lines</th>
      </tr></thead>
      <tbody>{rows.map((r, index) => <tr key={index} data-testid={`lot-subtotal-row-${index}`}
        className={r.status === "matches" ? "" : "font-semibold text-[#8a4b2a]"}>
        <td className="py-1 pr-2 break-words">{r.label}
          {sourceUrl && r.page && <a className="underline ml-2 font-normal" href={`${sourceUrl}#page=${r.page}`}
            target="_blank" rel="noopener noreferrer">page {r.page}</a>}</td>
        <td className="py-1 text-right"><Amount value={r.printed} denomination="HT" /></td>
        <td className="py-1 text-right">{r.extracted == null ? "—" : <Amount value={r.extracted} denomination="HT" />}</td>
        <td className="py-1 text-right">{r.status === "unmatched" ? "Not checked" : r.status === "matches" ? "Matches"
          : <>{r.difference! > 0 ? "+" : "−"}<Amount value={Math.abs(r.difference!)} denomination="HT" /></>}</td>
        <td className="py-1 pl-3">{lineList(r.lineNumbers)}</td>
      </tr>)}</tbody>
    </table>
  </details>;
}
