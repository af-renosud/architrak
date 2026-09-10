import { AlertTriangle, Loader2 } from "lucide-react";
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
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <TechnicalLabel>Gross Works HT (Cumulative)</TechnicalLabel>
          <Input
            value={htValue}
            disabled={basis !== "ht" && isLoading}
            type="number"
            min="0"
            step="0.01"
            onChange={(event) => onEdit("ht", event.target.value)}
            data-testid={`${testIdPrefix}-ht`}
          />
          <p className="mt-1 text-[9px] text-muted-foreground">
            {basis === "ht" ? "Entered amount" : "Calculated automatically"}
          </p>
        </div>
        <div>
          <TechnicalLabel>Gross Works TTC (Cumulative)</TechnicalLabel>
          <Input
            value={ttcValue}
            disabled={basis !== "ttc" && isLoading}
            type="number"
            min="0"
            step="0.01"
            onChange={(event) => onEdit("ttc", event.target.value)}
            data-testid={`${testIdPrefix}-ttc`}
          />
          <p className="mt-1 text-[9px] text-muted-foreground">
            {basis === "ttc" ? "Entered amount" : "Calculated automatically"}
          </p>
        </div>
      </div>

      <div
        className="rounded-lg border border-[#0B2545]/15 bg-[#0B2545]/5 px-3 py-2"
        data-testid={`${testIdPrefix}-decision`}
      >
        {isLoading ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 size={12} className="animate-spin" />
            Calculating TVA from current evidence…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 text-[11px] text-destructive">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{error.message}</span>
          </div>
        ) : preview ? (
          <div className="flex items-start justify-between gap-4">
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
                className="text-[10px] text-muted-foreground"
                data-testid={`${testIdPrefix}-source`}
              >
                {sourceLabel(preview)}
              </p>
            </div>
            <div className="text-right">
               <TechnicalLabel>TVA on gross works</TechnicalLabel>
              <p className="mt-0.5 text-[12px] font-semibold">
                <Amount
                   value={deriveTvaAmount(Number(preview.works.amountHt), Number(preview.works.amountTtc))}
                  denomination="TVA"
                />
              </p>
               <p className="text-[10px] text-muted-foreground">Before deductions; payable TVA is shown below.</p>
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