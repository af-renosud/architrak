import { Link } from "wouter";
import type { QuotationReplacementHistory as HistoryEntry } from "@shared/quotation-replacement";

export function QuotationReplacementHistory({ entries, devisId, projectId }: {
  entries: HistoryEntry[];
  devisId: number;
  projectId: string;
}) {
  const related = entries.filter(entry => entry.oldDevisId === devisId || entry.newDevisId === devisId);
  if (!related.length) return null;
  return (
    <div className="mt-2 space-y-2 rounded-md border bg-muted/30 px-3 py-2 text-xs" data-testid={`replacement-history-${devisId}`}>
        {related.map(entry => {
          const outgoing = entry.oldDevisId === devisId;
          return (
            <div key={entry.id} className="border-t pt-2 first:border-t-0 first:pt-0">
              <span>{outgoing ? "Replaced by" : "Replaces"} </span>
              <Link className="font-semibold underline underline-offset-2" href={`/projets/${projectId}?tab=devis&devis=${outgoing ? entry.newDevisId : entry.oldDevisId}`}>
                {outgoing ? entry.newLabel : entry.oldLabel}
              </Link>
              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground">Replacement details · actor, date &amp; internal context</summary>
                <p className="mt-1 text-muted-foreground">
                  {entry.actorName} · <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString("fr-FR")}</time>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words"><span className="font-semibold">Internal context: </span>{entry.note}</p>
              </details>
            </div>
          );
        })}
    </div>
  );
}
