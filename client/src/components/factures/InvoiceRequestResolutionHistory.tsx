import { useQuery } from "@tanstack/react-query";
import { Download, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { formatCurrency as fmt } from "@/lib/utils";

interface RequestResolutionHistoryEntry {
  id: number;
  reason: string;
  createdAt: string;
  actor: string;
  beforeHt: number | string;
  beforeTtc: number | string;
  afterHt: number | string;
  afterTtc: number | string;
  originals: { certificateId: number; fileName: string; url: string }[];
}

export function InvoiceRequestResolutionHistory({ invoiceId }: { invoiceId: number }) {
  const history = useQuery<RequestResolutionHistoryEntry[]>({
    queryKey: ["/api/invoices", invoiceId, "request-resolution-history"],
    queryFn: async () => (await apiRequest("GET", `/api/invoices/${invoiceId}/request-resolution-history`)).json(),
    retry: false,
  });

  return (
    <section className="rounded-xl border border-[#c1a27b]/30 bg-[#c1a27b]/5 p-3 space-y-3" aria-label="Audited request decision history" data-testid={`request-resolution-history-${invoiceId}`}>
      <div className="flex items-center gap-2 text-[#0B2545]">
        <History size={15} aria-hidden="true" />
        <h3 className="text-[12px] font-semibold">Audited request decision history</h3>
      </div>
      {history.isLoading ? (
        <div className="space-y-2" aria-label="Loading request decision history">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : history.error ? (
        <div className="space-y-2">
          <p role="alert" className="text-[12px] text-destructive">Request decision history could not be loaded: {history.error.message}</p>
          <Button variant="outline" size="sm" disabled={history.isFetching} onClick={() => { void history.refetch(); }}>
            {history.isFetching ? "Refreshing history…" : "Retry history"}
          </Button>
        </div>
      ) : history.data?.length ? (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            These read-only decisions preserve the documentary reason and amount changes. Original architect invoices detached during correction remain available for review and reuse. Check the original and reattach it to the certificate before sending.
          </p>
          <ol className="space-y-3">
            {history.data.map((entry) => {
              const date = new Date(entry.createdAt);
              return (
                <li key={entry.id} className="rounded-lg border border-border/60 p-3 space-y-2 text-[12px]" data-testid={`request-resolution-history-entry-${entry.id}`}>
                  <div className="flex flex-wrap justify-between gap-1 text-[11px] text-muted-foreground">
                    <span>Decision #{entry.id} · {entry.actor}</span>
                    <time dateTime={entry.createdAt}>{Number.isNaN(date.getTime()) ? entry.createdAt : date.toLocaleString("fr-FR")}</time>
                  </div>
                  <p className="whitespace-pre-wrap break-words leading-relaxed">{entry.reason}</p>
                  <dl className="grid grid-cols-1 gap-2 rounded-md bg-[#0B2545]/5 p-2 sm:grid-cols-2">
                    <div>
                      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Before decision</dt>
                      <dd className="tabular-nums">{fmt(Number(entry.beforeHt))} HT / {fmt(Number(entry.beforeTtc))} TTC</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">After decision</dt>
                      <dd className="font-semibold tabular-nums text-[#0B2545]">{fmt(Number(entry.afterHt))} HT / {fmt(Number(entry.afterTtc))} TTC</dd>
                    </div>
                  </dl>
                  {entry.originals.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold">Preserved original architect invoices</p>
                      {entry.originals.map((original, index) => (
                        <a key={`${original.certificateId}:${index}`} href={original.url} download={original.fileName} className="flex items-start gap-2 rounded-md border border-[#0B2545]/15 px-2 py-2 text-[#0B2545] underline underline-offset-2 hover:bg-[#0B2545]/5" data-testid={`request-resolution-original-${entry.id}-${index}`}>
                          <Download size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                          <span className="break-words">Download {original.fileName} · Certificate #{original.certificateId}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      ) : <p className="text-[12px] text-muted-foreground">No audited request decisions recorded for this invoice.</p>}
    </section>
  );
}
