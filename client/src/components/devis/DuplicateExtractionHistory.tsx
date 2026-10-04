import { useId, useState } from "react";
import { ChevronDown, History } from "lucide-react";
import type { DuplicateExtractionHistoryEntry } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDuplicateExtractionHistory } from "./use-duplicate-extraction-history";

function HistoryEntry({ entry }: { entry: DuplicateExtractionHistoryEntry }) {
  const date = new Date(entry.createdAt);
  const when = Number.isNaN(date.getTime())
    ? entry.createdAt
    : date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const reconciliation = entry.reconciliation;
  const amounts = [
    ["Source total · immutable", reconciliation.sourceTotalHt],
    ["Active line sum · before", reconciliation.beforeSumHt],
    ["Active line sum · after", reconciliation.afterSumHt],
    ["Discrepancy · before", reconciliation.discrepancyBeforeHt],
    ["Discrepancy · after", reconciliation.discrepancyAfterHt],
  ];

  return (
    <li className="space-y-3 rounded-lg border border-border p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-semibold break-words">{entry.actor.name}</p>
        <time dateTime={entry.createdAt} className="text-muted-foreground">{when}</time>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Correction reason</p>
        <p className="whitespace-pre-wrap break-words">{entry.reason}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {([
          ["Removed extracted line", entry.removedLine],
          ["Retained extracted line", entry.retainedLine],
        ] as const).map(([label, line]) => (
          <div key={label} className="min-w-0 border-l-2 border-[#c1a27b]/60 pl-3">
            <p className="font-semibold">{label} #{line.lineNumber}</p>
            <p className="text-[10px] text-muted-foreground">Line ID {line.id}</p>
            <p className="mt-1 whitespace-pre-wrap break-words">{line.description}</p>
            <p className="mt-1 font-mono">{line.totalHt} EUR HT</p>
          </div>
        ))}
      </div>
      <dl className="space-y-2 rounded-md bg-muted/20 p-3">
        {amounts.map(([label, amount]) => (
          <div key={label} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono">{amount} EUR HT</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

/** Audit evidence remains available regardless of quotation editing permissions. */
export function DuplicateExtractionHistory({ devisId }: { devisId: number }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const history = useDuplicateExtractionHistory(devisId, open);

  return (
    <section className="rounded-lg border border-border/60" aria-label="Duplicate extraction correction history">
      <button
        type="button"
        className="flex w-full items-center gap-2 p-3 text-left text-[11px] font-bold uppercase tracking-widest hover:bg-muted/20 rounded-lg"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        data-testid={`toggle-duplicate-extraction-history-${devisId}`}
      >
        <History className="h-4 w-4 shrink-0 text-[#c1a27b]" aria-hidden="true" />
        <span className="flex-1">Duplicate extraction correction history</span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      <div id={panelId} hidden={!open}>
        {open && (
          <div className="space-y-3 border-t border-border/60 p-3 text-xs">
            <p className="text-muted-foreground">Read-only correction record. The contractor PDF and source quotation totals remain unchanged.</p>
            {history.isPending ? (
              <div role="status" aria-label="Loading correction history" className="space-y-2">
                <span className="sr-only">Loading correction history…</span>
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : history.isError ? (
              <div role="alert" className="space-y-2 rounded-md border border-destructive/30 p-3">
                <p>Correction history could not be loaded: {history.error.message}</p>
                <Button type="button" variant="outline" size="sm" disabled={history.isFetching} onClick={() => void history.refetch()}>
                  {history.isFetching ? "Retrying…" : "Retry correction history"}
                </Button>
              </div>
            ) : history.data?.length ? (
              <ol className="space-y-3" aria-label="Recorded corrections">
                {history.data.map((entry) => <HistoryEntry key={entry.id} entry={entry} />)}
              </ol>
            ) : (
              <div className="rounded-md border border-dashed border-border bg-muted/20 p-4">
                <p className="font-semibold">No duplicate extraction corrections recorded.</p>
                <p className="mt-1 text-muted-foreground">Any confirmed correction will appear here with its reason and financial reconciliation.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}