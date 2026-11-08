import { Button } from "@/components/ui/button";
import type { QuotationNextActionsController } from "@/hooks/use-quotation-next-actions";
import { nextActionCounts, type NextActionQuotation } from "@/lib/quotation-next-actions";

export function QuotationNextActionsSummary({ rows, controller, selected, onToggle }: {
  rows: NextActionQuotation[];
  controller: QuotationNextActionsController;
  selected: boolean;
  onToggle: () => void;
}) {
  const counts = nextActionCounts(rows, false, controller.data);
  return <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid="quotation-next-actions-summary">
    <Button type="button" variant={selected ? "secondary" : "outline"} size="sm" className="h-7 text-[11px]"
      aria-pressed={selected} disabled={controller.unknown && !selected} onClick={onToggle}>
      Action needed{!controller.unknown ? ` (${counts.actionable})` : " — unknown"}
    </Button>
    {!controller.unknown && counts.unknownEvidence > 0 && <span role="status" className="text-muted-foreground" data-testid="quotation-unknown-evidence-count">
      {counts.unknownEvidence} {counts.unknownEvidence === 1 ? "quotation with" : "quotations with"} unknown evidence — review required.
    </span>}
    {controller.unknown && <><span role="status" className="text-muted-foreground">{controller.loading ? "Checking quotation guidance…" : "Guidance unavailable or outdated — not an all-clear."}</span>
      <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px]" disabled={controller.fetching} onClick={() => void controller.retry()}>Retry guidance</Button></>}
  </div>;
}
