import type { ExternalCostOverview, ExternalCostRow } from "@shared/external-works";
import { formatCurrencyNoSymbol } from "@shared/financial-utils";

export function externalOverviewFromSummary(summary: {
  externalWorks?: ExternalCostRow[]; totalExternalHt?: number; totalExternalTtc?: number;
  totalCombinedCostHt?: number; totalCombinedCostTtc?: number;
}): ExternalCostOverview | null {
  if (!summary.externalWorks?.length) return null;
  if ([summary.totalExternalHt, summary.totalExternalTtc, summary.totalCombinedCostHt, summary.totalCombinedCostTtc].some(n => typeof n !== "number" || !Number.isFinite(n))) {
    throw new Error("External works totals are incomplete");
  }
  return {
    entries: summary.externalWorks, totalExternalHt: summary.totalExternalHt!, totalExternalTtc: summary.totalExternalTtc!,
    totalCombinedCostHt: summary.totalCombinedCostHt!, totalCombinedCostTtc: summary.totalCombinedCostTtc!,
  };
}
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export function externalWorksOverviewHtml(overview?: ExternalCostOverview | null, details = true): string {
  if (!overview?.entries.length) return "";
  const amount = (n: number) => formatCurrencyNoSymbol(n);
  return `<section style="margin-top:4mm;font-size:7pt;">
    <h3 style="font-size:9pt;color:#0B2545;">External works completed before ArchiTrak</h3>
    <p>Historical costs recorded by the architect. These are not amounts certified or confirmed paid by ArchiTrak and do not affect this certificate's amount payable.</p>
    <table style="width:100%;border-collapse:collapse;">
    <thead><tr style="background:#0B2545;color:white;"><th style="text-align:left;">Reference / description</th><th style="text-align:right;">HT</th><th style="text-align:right;">TTC</th></tr></thead>
    <tbody>${details ? overview.entries.map(r => `<tr style="page-break-inside:avoid;"><td>${escape(r.reference)} — ${escape(r.description)}${r.companyName ? `<br>${escape(r.companyName)}` : ""}${r.lot ? ` · Lot ${escape(r.lot)}` : ""}</td><td style="text-align:right;white-space:nowrap;">${amount(Number(r.amountHt))}</td><td style="text-align:right;white-space:nowrap;">${amount(Number(r.amountTtc))}</td></tr>`).join("") : ""}
    <tr style="font-weight:bold;border-top:1px solid #C1A27B;"><td>External completed works${details ? "" : ` (${overview.entries.length} records)`}</td><td style="text-align:right;">${amount(overview.totalExternalHt)}</td><td style="text-align:right;">${amount(overview.totalExternalTtc)}</td></tr>
    <tr style="font-weight:bold;background:#E8ECF1;"><td>Combined project cost — signed managed commitments + external works</td><td style="text-align:right;">${amount(overview.totalCombinedCostHt)}</td><td style="text-align:right;">${amount(overview.totalCombinedCostTtc)}</td></tr></tbody></table>
    </section>`;
}
