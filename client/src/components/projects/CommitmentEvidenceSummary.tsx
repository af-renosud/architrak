import { Amount } from "@/components/ui/amount";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { commitmentLabel, type FinancialSummary } from "@/lib/financial-summary";

export function CommitmentEvidenceSummary({ summary }: { summary: FinancialSummary }) {
  // Older responses may arrive during rollout. Do not display invented zeroes.
  if (summary.totalExcludedCertifiedHt == null || summary.totalPendingHt == null) return null;
  const totalQuotationsTtc = summary.totalContractedTtc + summary.totalPendingTtc;
  const totalQuotationsHt = summary.totalContractedHt + summary.totalPendingHt;
  const hasTotalQuotations = [
    summary.totalContractedTtc, summary.totalPendingTtc,
    summary.totalContractedHt, summary.totalPendingHt,
    totalQuotationsTtc, totalQuotationsHt,
  ].every((value) => typeof value === "number" && Number.isFinite(value));
  return (
    <div className="space-y-2 text-[11px] text-muted-foreground" data-testid={`commitment-evidence-${summary.projectId}`}>
      <p>Commitment, certified and remaining totals cover signed active quotations only.</p>
      <div>
        <TechnicalLabel>Not signed — pending quotations</TechnicalLabel>
        <p><Amount value={summary.totalPendingTtc} denomination="TTC" />{" · "}<Amount value={summary.totalPendingHt} denomination="HT" /></p>
      </div>
      {hasTotalQuotations && (
        <div data-testid={`text-total-quotations-${summary.projectId}`}>
          <TechnicalLabel>Signed + not signed — total quotations</TechnicalLabel>
          <p className="flex flex-wrap items-baseline gap-x-1"><Amount value={totalQuotationsTtc} denomination="TTC" />{" · "}<Amount value={totalQuotationsHt} denomination="HT" /></p>
          <p>Includes unsigned quotations; unsigned amounts are not contractual commitment.</p>
        </div>
      )}
      <div data-testid={`text-excluded-certified-${summary.projectId}`}>
        <TechnicalLabel>Certified outside signed commitment</TechnicalLabel>
        <p><Amount value={summary.totalExcludedCertifiedTtc} denomination="TTC" />{" · "}<Amount value={summary.totalExcludedCertifiedHt} denomination="HT" /></p>
        <p>Invoices and deposits on unsigned or inactive quotations are preserved, not included in signed totals.</p>
      </div>
      {(summary.financialExceptions?.length ?? 0) > 0 && (
        <div data-testid={`text-financial-exceptions-${summary.projectId}`}>
          <p className="text-amber-700 dark:text-amber-300">
            {summary.financialExceptions.length} financial exception{summary.financialExceptions.length === 1 ? "" : "s"} outside signed commitment — review the quotation records.
          </p>
          {summary.financialExceptions.map((row) => (
            <p key={row.devisId} data-testid={`text-financial-exception-${row.devisId}`}>
              {row.devisCode}: {commitmentLabel(row)}{" · "}Certified: <Amount value={row.certifiedTtc} denomination="TTC" />{" · "}<Amount value={row.certifiedHt} denomination="HT" />
              {" · "}{row.invoiceCount} invoice{row.invoiceCount === 1 ? "" : "s"}
              {(row.acompteCertifiedTtc ?? 0) > 0 && <>{" · "}Includes deposit: <Amount value={row.acompteCertifiedTtc ?? 0} denomination="TTC" /></>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
