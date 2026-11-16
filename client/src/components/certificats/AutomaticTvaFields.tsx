import { AlertTriangle, PencilLine } from "lucide-react";
import { Input } from "@/components/ui/input";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Amount } from "@/components/ui/amount";
import { deriveTvaAmount } from "@shared/financial-utils";
import type { CertificatDeductionExplanation } from "@shared/certificat-preview";

export type ManualCertificatAmountBasis = "ht" | "ttc";

export interface ManualCertificatPreview {
  works: {
    enteredAmount: string;
    enteredBasis: ManualCertificatAmountBasis;
    amountHt: string;
    amountTtc: string;
  };
  deductions: {
    retenueGarantie: string;
    cumulativeProrataDeduction: string;
    periodProrataDeduction: string;
    cumulativeAcompteRecoupment: string;
    periodAcompteRecoupment: string;
    retenueReleaseAmount: string;
    netToPayHt: string;
    tvaAmount: string;
    netToPayTtc: string;
    tvaRatePercent: string;
    tvaAutoliquidation: boolean;
    tvaRateSource: string;
  };
  tva: {
    ratePercent: string;
    autoliquidation: boolean;
    source: string;
    evidenceKind: string;
  };
  explanation: CertificatDeductionExplanation;
}

function sourceLabel(preview: ManualCertificatPreview): string {
  if (preview.tva.autoliquidation) return "Autoliquidation — art. 283 CGI";
  if (preview.tva.source === "marche") return "Configuration fiscale du marché";
  if (preview.tva.source === "contractor") return "Configuration fiscale de l’entreprise";
  switch (preview.tva.evidenceKind) {
    case "signed_quotation":
      return "Devis signé — montants HT/TTC extraits";
    case "invoices":
    case "exact_invoices":
      return "Factures — montants HT/TTC extraits";
    case "configuration":
      return preview.tva.source === "marche"
        ? "Configuration fiscale du marché"
        : preview.tva.source === "contractor"
          ? "Configuration fiscale de l’entreprise"
          : "Justificatifs fiscaux";
    case "marche":
      return "Configuration fiscale du marché";
    case "contractor":
      return "Configuration fiscale de l’entreprise";
    case "autoliquidation":
      return "Autoliquidation — art. 283 CGI";
    default:
      return "Justificatifs fiscaux";
  }
}

export function AutomaticTvaFields({
  enteredAmount,
  basis,
  preview,
  isLoading,
  error,
  onEdit,
  testIdPrefix,
}: {
  enteredAmount: string;
  basis: ManualCertificatAmountBasis;
  preview?: ManualCertificatPreview;
  isLoading: boolean;
  error?: Error | null;
  onEdit: (basis: ManualCertificatAmountBasis, value: string) => void;
  testIdPrefix: string;
}) {
  // A same-key refetch retains old data. Never offer a stale conversion as an
  // editable amount: switching basis would turn it into a new user input.
  const currentPreview = !isLoading && !error ? preview : undefined;
  const htValue =
    basis === "ht" ? enteredAmount : currentPreview?.works.amountHt ?? "";
  const ttcValue =
    basis === "ttc" ? enteredAmount : currentPreview?.works.amountTtc ?? "";

  return (
    <div className="space-y-3 rounded-xl border border-[#0B2545]/20 bg-[#0B2545]/[0.025] p-4">
      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <PencilLine size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          Enter total works to date
        </h3>
        <p id={`${testIdPrefix}-help`} className="text-xs leading-relaxed text-muted-foreground">
          Enter the total value of works completed since the start of the contract, before deductions — <strong className="font-semibold text-foreground">not the payment you want to authorise today.</strong>
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          <strong className="font-medium text-foreground">First certificate:</strong> enter all works completed so far.{" "}
          <strong className="font-medium text-foreground">Later certificates:</strong> include works already certified.
          {" "}For example, €10,000 HT previously completed + €4,000 HT of new works = €14,000 HT to enter.
        </p>
      </div>
      <p className="text-xs font-medium">Edit either amount in euros. The other is converted automatically using TVA.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className={`rounded-lg border p-3 ${basis === "ht" ? "border-[#0B2545]/40 bg-background" : "border-border bg-background/70"}`}>
          <label htmlFor={`${testIdPrefix}-ht`} className="block text-xs font-semibold">Gross Works HT (Cumulative)</label>
          <p id={`${testIdPrefix}-ht-help`} className="mb-2 mt-1 text-xs text-muted-foreground">Excluding TVA · {basis === "ht" ? "your entered amount" : "converted; edit to enter HT instead"}</p>
          <Input
            id={`${testIdPrefix}-ht`}
            aria-describedby={`${testIdPrefix}-help ${testIdPrefix}-ht-help`}
            className="h-11 border-[#0B2545]/30 bg-background text-base font-semibold tabular-nums focus-visible:ring-[#0B2545]/40"
            value={htValue}
            disabled={basis !== "ht" && isLoading}
            type="number"
            min="0"
            step="0.01"
            onChange={(event) => onEdit("ht", event.target.value)}
            data-testid={`${testIdPrefix}-ht`}
          />
        </div>
        <div className={`rounded-lg border p-3 ${basis === "ttc" ? "border-[#0B2545]/40 bg-background" : "border-border bg-background/70"}`}>
          <label htmlFor={`${testIdPrefix}-ttc`} className="block text-xs font-semibold">Gross Works TTC (Cumulative)</label>
          <p id={`${testIdPrefix}-ttc-help`} className="mb-2 mt-1 text-xs text-muted-foreground">Including TVA · {basis === "ttc" ? "your entered amount" : "converted; edit to enter TTC instead"}</p>
          <Input
            id={`${testIdPrefix}-ttc`}
            aria-describedby={`${testIdPrefix}-help ${testIdPrefix}-ttc-help`}
            className="h-11 border-[#0B2545]/30 bg-background text-base font-semibold tabular-nums focus-visible:ring-[#0B2545]/40"
            value={ttcValue}
            disabled={basis !== "ttc" && isLoading}
            type="number"
            min="0"
            step="0.01"
            onChange={(event) => onEdit("ttc", event.target.value)}
            data-testid={`${testIdPrefix}-ttc`}
          />
        </div>
      </div>

      <div className="rounded-lg border border-[#0B2545]/20 bg-[#0B2545]/5 p-3" role="status" aria-live="polite" aria-atomic="true">
        <p className="text-xs font-semibold">Payment to authorise · net payable TTC</p>
        {currentPreview ? (
          <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums text-foreground" data-testid={`${testIdPrefix}-net-payable`}>
            <Amount value={Number(currentPreview.deductions.netToPayTtc)} denomination="TTC" />
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {isLoading ? "Updating payment calculation…" : error ? "Payment unavailable — resolve the calculation error below." : "Enter works above to calculate the payment."}
          </p>
        )}
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          For this certificate only, after previous net certified amounts, applicable deductions and releases, and TVA. Calculated automatically; not editable.
        </p>
      </div>

      <div
        className="rounded-lg border border-[#0B2545]/15 bg-[#0B2545]/5 px-3 py-2"
        data-testid={`${testIdPrefix}-decision`}
      >
        {isLoading ? (
          <div role="status" className="text-xs text-muted-foreground">
            Calculating TVA from current evidence…
          </div>
        ) : error ? (
          <div role="alert" className="flex items-start gap-2 text-xs text-destructive">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{error.message}</span>
          </div>
        ) : preview ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <TechnicalLabel>Applied TVA</TechnicalLabel>
              <p
                className="mt-0.5 text-[12px] font-semibold text-[#0B2545]"
                data-testid={`${testIdPrefix}-rate`}
              >
                {preview.tva.autoliquidation
                  ? "0% — Autoliquidation"
                  : `${Number(preview.tva.ratePercent).toLocaleString("fr-FR", {
                      maximumFractionDigits: 2,
                    })}%`}
              </p>
              <p
                className="text-xs text-muted-foreground"
                data-testid={`${testIdPrefix}-source`}
              >
                {sourceLabel(preview)}
              </p>
            </div>
             <div>
               <TechnicalLabel>TVA on gross works</TechnicalLabel>
              <p className="mt-0.5 text-[12px] font-semibold">
                <Amount
                   value={deriveTvaAmount(Number(preview.works.amountHt), Number(preview.works.amountTtc))}
                  denomination="TVA"
                />
              </p>
               <p className="text-xs text-muted-foreground">Before deductions, not the TVA payable.</p>
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Select the quotation and enter an amount to calculate TVA.
          </p>
        )}
      </div>
    </div>
  );
}