import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import type { QuotationReplacementHistory as HistoryEntry } from "@shared/quotation-replacement";
import { ReviewPreviousQuotationWorkDialog } from "./ReviewPreviousQuotationWorkDialog";

export function QuotationReplacementHistory({ entries, devisId, projectId }: {
  entries: HistoryEntry[];
  devisId: number;
  projectId: string;
}) {
  const [reviewEntry, setReviewEntry] = useState<HistoryEntry | null>(null);
  const related = entries.filter(entry => entry.oldDevisId === devisId || entry.newDevisId === devisId);
  if (!related.length) return null;
  return (
    <div className="quotation-list-history mt-2 text-xs" data-testid={`replacement-history-${devisId}`}>
      <details onClick={event => event.stopPropagation()}>
        <summary className="w-fit cursor-pointer rounded px-2 py-1 font-medium text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          Replacement history ({related.length})
        </summary>
        <div className="mt-2 space-y-2 rounded-lg border bg-muted/30 px-4 py-3">
        {related.map(entry => {
          const outgoing = entry.oldDevisId === devisId;
          return (
            <div key={entry.id} className="border-t pt-2 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="min-w-0 flex-1 break-words"><span>{outgoing ? "Replaced by" : "Replaces"} </span>
              <Link className="font-semibold underline underline-offset-2" href={`/projets/${projectId}?tab=devis&devis=${outgoing ? entry.newDevisId : entry.oldDevisId}`}>
                {outgoing ? entry.newLabel : entry.oldLabel}
              </Link>
              </p>
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => setReviewEntry(entry)}>Review previous work</Button>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground">Replacement details · actor, date &amp; internal context</summary>
                <p className="mt-2 text-muted-foreground">Original context, images and translations remain available. Review what can be carried forward.</p>
                <p className="mt-1 text-muted-foreground">
                  {entry.actorName} · <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString("fr-FR")}</time>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words"><span className="font-semibold">Internal context: </span>{entry.note}</p>
              </details>
            </div>
          );
        })}
        </div>
      </details>
        {reviewEntry && <ReviewPreviousQuotationWorkDialog sourceId={reviewEntry.oldDevisId} targetId={reviewEntry.newDevisId}
          sourceLabel={reviewEntry.oldLabel} targetLabel={reviewEntry.newLabel} projectId={projectId} onClose={() => setReviewEntry(null)} />}
    </div>
  );
}
