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
    <section className="rounded-xl border-2 border-red-500 dark:border-red-400 bg-red-50/40 dark:bg-red-950/10 p-4 space-y-3" aria-label="Retention review" data-testid="retention-review">
      <h3 className="text-sm font-bold">Review retention — Retenue de garantie</h3>
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
        <Button type="button" variant="outline" className="border-red-500 font-semibold" onClick={() => onChange("0.00")} aria-pressed={value !== undefined && value !== "" && Number(value) === 0} data-testid="button-no-retention">No retention</Button>
        <Button type="button" variant="outline" onClick={() => onChange("")} aria-pressed={!value} data-testid="button-auto-retention">Use automatic calculation</Button>
      </div>
      <div>
        <label htmlFor={inputId} className="block text-xs font-semibold mb-1">Custom cumulative retention override (HT)</label>
        <Input id={inputId} data-testid={inputId} value={value ?? ""} onChange={(event) => onChange(event.target.value)} type="number" step="0.01" placeholder="Automatic" />
        <p className="mt-1 text-xs text-muted-foreground">Leave blank for automatic calculation. Enter 0 for no retention. Applies to this certificate, not the contract settings.</p>
      </div>
    </section>
  );
}

function MoneyRow({ label, value, denomination = "HT", strong = false }: {
  label: string; value: string | number; denomination?: "HT" | "TTC" | "TVA"; strong?: boolean;
}) {
  return <div className={`flex items-start justify-between gap-3 text-xs ${strong ? "border-t pt-2 font-semibold" : ""}`}>
    <span>{label}</span>
    <span className="shrink-0"><Amount value={Object.is(Number(value), -0) ? 0 : Number(value)} denomination={denomination} /></span>
  </div>;
}

export function ManualCertificateTotals({ preview, isLoading, error }: PreviewState) {
  if (!preview?.explanation || isLoading || error) return <PreviewNotice isLoading={isLoading} error={error} />;
  const { deductions: d, explanation: e, works } = preview;
  return (
    <section className="rounded-xl border p-4 space-y-2" aria-label="Gross to net payment calculation" data-testid="manual-certificate-totals">
      <h3 className="text-sm font-semibold">From gross works to net payable</h3>
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
      <MoneyRow label="Net payable TTC (this period)" value={d.netToPayTtc} denomination="TTC" strong />
    </section>
  );
}