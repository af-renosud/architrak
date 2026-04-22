import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

interface TvaDerivedHintProps {
  amountHt: string | number | null | undefined;
  amountTtc: string | number | null | undefined;
  testId?: string;
  className?: string;
}

export function TvaDerivedHint({ amountHt, amountTtc, testId, className }: TvaDerivedHintProps) {
  const ht = typeof amountHt === "number" ? amountHt : parseFloat((amountHt ?? "0").toString() || "0");
  const ttc = typeof amountTtc === "number" ? amountTtc : parseFloat((amountTtc ?? "0").toString() || "0");
  const tva = Number((ttc - ht).toFixed(2));

  return (
    <div
      className={`flex items-center gap-1 text-[10px] text-muted-foreground ${className ?? ""}`}
      data-testid={testId}
    >
      <span>TVA = TTC − HT = {formatCurrency(tva)}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Why is TVA derived?"
            data-testid={testId ? `${testId}-tooltip` : undefined}
          >
            <Info size={10} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-[11px]">
          TVA on documents is derived automatically from HT and TTC; we no longer
          store a separate rate. To change the TVA, edit the HT or TTC amount.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
