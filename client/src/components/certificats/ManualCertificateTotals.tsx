import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ManualCertificatPreview } from "./AutomaticTvaFields";

interface PreviewState {
  preview?: ManualCertificatPreview;
  isLoading: boolean;
  error?: Error | null;
}

function PreviewNotice({ isLoading, error }: PreviewState) {
  return <p role="status" className="text-xs text-muted-foreground">
    {isLoading ? "Updating calculation…" : error ? "Calculation unavailable. Resolve the preview error before creating the certificate." : "Select the quotation and enter an amount to see the calculation."}
  </p>;
}

export function RetentionReview({
  preview, isLoading, error, value, onChange, inputId,
}: PreviewState & {
  value?: string;
  onChange: (value: string) => void;
  inputId: string;
}) {
  const retention = !isLoading && !error ? preview?.explanation?.retention : undefined;
  return (
    <section className="rounded-xl border border-[#0B2545]/20 bg-[#0B2545]/[0.025] p-4 space-y-3" aria-label="Retention review" data-testid="retention-review">
      <div>
        <h3 className="text-sm font-semibold">Review retention — Retenue de garantie</h3>
        <p className="mt-1 text-xs text-muted-foreground">This decision changes the payment calculated above.</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Retention often does not apply to professional services such as engineering, geotechnical support and surveying. Check the agreed terms; no service is automatically exempted.
      </p>
      {retention && preview ? (
        <div className="space-y-1 text-xs" aria-live="polite">
          <p data-testid="retention-source">
            {retention.source === "override" ? "Operator override — replaces the automatic cumulative amount."
              : retention.source === "bank_guarantee" ? "Bank guarantee — automatic cash retention bypassed."
              : retention.source === "marche" ? "Marché configuration — check the agreed terms."
              : "Application default — no configured marché rate. This is not verified contractual retention."}
          </p>
          <p className="font-semibold" data-testid="retention-calculation">
            {retention.source === "override" ? "Cumulative override: "
              : retention.source === "bank_guarantee" ? "Cash retention: "
              : <><Amount value={Number(retention.baseHt)} denomination="HT" /> × {Number(retention.ratePercent)}% = </>}
            <Amount value={Number(preview.deductions.retenueGarantie)} denomination="HT" /> withheld (cumulative)
          </p>
          {(retention.source === "override" || retention.source === "bank_guarantee") && (
            <p className="text-muted-foreground">
              Underlying rate: {Number(retention.ratePercent)}% ({retention.rateSource === "default" ? "application default, not verified contractual retention" : "marché configuration"}).
              {retention.source === "override" && " The explicit override takes precedence over a bank guarantee, if present."}
            </p>
          )}
        </div>
      ) : <PreviewNotice isLoading={isLoading} error={error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-auto min-h-9 whitespace-normal px-3 py-2 text-xs aria-pressed:border-[#0B2545]/50 aria-pressed:bg-[#0B2545]/10" onClick={() => onChange("0.00")} aria-pressed={value !== undefined && value !== "" && Number(value) === 0} data-testid="button-no-retention">No retention</Button>
        <Button type="button" variant="outline" className="h-auto min-h-9 whitespace-normal px-3 py-2 text-xs aria-pressed:border-[#0B2545]/50 aria-pressed:bg-[#0B2545]/10" onClick={() => onChange("")} aria-pressed={!value} data-testid="button-auto-retention">Use automatic calculation</Button>
      </div>
      <div>
        <label htmlFor={inputId} className="block text-xs font-semibold mb-1">Custom cumulative retention override (HT)</label>
        <Input id={inputId} data-testid={inputId} aria-describedby={`${inputId}-help`} value={value ?? ""} onChange={(event) => onChange(event.target.value)} type="number" step="0.01" placeholder="Automatic" />
        <p id={`${inputId}-help`} className="mt-1 text-xs text-muted-foreground">Leave blank for automatic calculation. Enter 0 for no retention. Applies to this certificate, not the contract settings.</p>
      </div>
    </section>
  );
}

function MoneyRow({ label, value, denomination = "HT", strong = false }: {
  label: string; value: string | number; denomination?: "HT" | "TTC" | "TVA"; strong?: boolean;
}) {
  return <div className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs ${strong ? "border-t pt-2 font-semibold" : ""}`}>
    <span className="min-w-0">{label}</span>
    <span className="ml-auto shrink-0 tabular-nums"><Amount value={Object.is(Number(value), -0) ? 0 : Number(value)} denomination={denomination} /></span>
  </div>;
}

export function ManualCertificateTotals({ preview, isLoading, error }: PreviewState) {
  if (!preview?.explanation || isLoading || error) return <PreviewNotice isLoading={isLoading} error={error} />;
  const { deductions: d, explanation: e, works } = preview;
  return (
    <section className="rounded-xl border border-[#0B2545]/20 p-4 space-y-2" aria-label="Gross to net payment calculation" data-testid="manual-certificate-totals">
      <h3 className="text-sm font-semibold">Payment calculation · this certificate</h3>
      <p className="pb-2 text-xs leading-relaxed text-muted-foreground">Cumulative works are not the payment due. Previous net certified amounts and the deductions below are applied before TVA.</p>
      <MoneyRow label="Gross works (cumulative)" value={works.amountHt} />
      {Number(e.pvMvAdjustment) !== 0 && <MoneyRow label="PV/MV adjustment (+ / −)" value={e.pvMvAdjustment} />}
      {Number(e.pvMvAdjustment) !== 0 && <MoneyRow label="Adjusted gross works (cumulative)" value={e.grossCumulativeHt} strong />}
      <MoneyRow label="Less retention (cumulative)" value={-Number(d.retenueGarantie)} />
      {Number(d.cumulativeProrataDeduction) !== 0 && <MoneyRow label="Less Compte Prorata (cumulative)" value={-Number(d.cumulativeProrataDeduction)} />}
      <MoneyRow label="Less previous net certified (cumulative)" value={-Number(e.previousPayments)} />
      {Number(d.periodAcompteRecoupment) !== 0 && <MoneyRow label="Less deposit recoupment (this period)" value={-Number(d.periodAcompteRecoupment)} />}
      {Number(d.retenueReleaseAmount) !== 0 && <MoneyRow label="Add retention release (this period)" value={d.retenueReleaseAmount} />}
      <MoneyRow label="Net payable HT (this period)" value={d.netToPayHt} strong />
      <MoneyRow label={`TVA on net payable HT (${Number(preview.tva.ratePercent)}%${preview.tva.autoliquidation ? " — Autoliquidation" : ""})`} value={d.tvaAmount} denomination="TVA" />
      <div className="!mt-4 rounded-lg border border-[#0B2545]/20 bg-[#0B2545]/5 p-3">
        <p className="text-sm font-semibold">Payment to authorise</p>
        <p className="mt-1 text-xs text-muted-foreground">Net payable TTC (this period)</p>
        <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums">
          <Amount value={Number(d.netToPayTtc)} denomination="TTC" />
        </p>
        <p className="mt-1 text-xs text-muted-foreground">After deductions and applicable releases · including TVA</p>
      </div>
    </section>
  );
}