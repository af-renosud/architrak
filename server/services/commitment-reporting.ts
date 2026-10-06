import { formatCurrencyNoSymbol } from "../../shared/financial-utils";

export interface ExcludedCommitmentRow {
  devisCode: string;
  commitmentStatus: string;
  adjustedHt: number;
  adjustedTtc: number;
  certifiedHt: number;
  certifiedTtc: number;
  hasFinancialEvidence?: boolean;
}
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Shared by both PDF reports. Excluded money is disclosed, never folded into
 * signed commitment totals or silently removed from the report. */
export function excludedCommitmentsHtml(rows: ExcludedCommitmentRow[] = []): string {
  if (!rows.length) return "";
  return `<section style="margin-top:10px;font-size:7pt;">
    <h3 style="font-size:8pt;">Outside signed commitment totals</h3>
    <table style="width:100%;border-collapse:collapse;"><thead><tr>
    <th style="text-align:left;">Quotation / status</th><th>Value HT / TTC</th><th>Recorded financial evidence HT / TTC</th>
    </tr></thead><tbody>${rows.map(d => `<tr>
      <td style="padding:5px;border-bottom:1px solid #ddd;">${escape(d.devisCode)} — ${d.commitmentStatus === "unsigned" ? "Not signed — excluded from commitment" : "Inactive — excluded from commitment"}</td>
      <td style="padding:5px;text-align:right;">${formatCurrencyNoSymbol(d.adjustedHt)} € HT / ${formatCurrencyNoSymbol(d.adjustedTtc)} € TTC</td>
      <td style="padding:5px;text-align:right;">${d.hasFinancialEvidence ? `${formatCurrencyNoSymbol(d.certifiedHt)} € HT / ${formatCurrencyNoSymbol(d.certifiedTtc)} € TTC — review required` : "—"}</td>
    </tr>`).join("")}</tbody></table>
    <p>Pending quotation values are not contracted liabilities. Recorded invoices and outstanding deposit certificates remain visible above; they are not included in the signed totals.</p>
  </section>`;
}
