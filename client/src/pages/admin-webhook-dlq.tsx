import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { WebhookDeliveryOut } from "@shared/schema";
import { WEBHOOK_DELIVERY_STATES } from "@shared/schema";

interface ListResponse {
  rows: WebhookDeliveryOut[];
}

type StateFilter = (typeof WEBHOOK_DELIVERY_STATES)[number] | "all";

function formatTimestamp(value: string | Date | null): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function stateBadgeVariant(state: WebhookDeliveryOut["state"]): "default" | "secondary" | "destructive" {
  switch (state) {
    case "succeeded": return "secondary";
    case "dead_lettered": return "destructive";
    case "pending":
    default: return "default";
  }
}

export default function AdminWebhookDlqPage() {
  const { toast } = useToast();
  const [stateFilter, setStateFilter] = useState<StateFilter>("dead_lettered");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [pendingRetry, setPendingRetry] = useState<WebhookDeliveryOut | null>(null);

  const queryKey = useMemo(
    () => ["/api/admin/webhook-dlq", stateFilter] as const,
    [stateFilter],
  );

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<ListResponse>({
    queryKey,
    queryFn: async () => {
      const url = stateFilter === "all"
        ? "/api/admin/webhook-dlq"
        : `/api/admin/webhook-dlq?state=${encodeURIComponent(stateFilter)}`;
      const res = await apiRequest("GET", url);
      return res.json() as Promise<ListResponse>;
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/webhook-dlq/${id}/retry`);
      return res.json() as Promise<{ id: number; after: WebhookDeliveryOut | null }>;
    },
    onSuccess: (result) => {
      const newState = result.after?.state ?? "pending";
      toast({
        title: "Retry triggered",
        description: `Delivery #${result.id} is now ${newState}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/webhook-dlq"] });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: "Retry failed", description: message, variant: "destructive" });
    },
    onSettled: () => {
      setPendingRetry(null);
    },
  });

  const rows = data?.rows ?? [];

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="page-webhook-dlq">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">
              Outbound webhook DLQ
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Archidoc work-authorisation deliveries from Architrak. Dead-lettered rows can be
              re-attempted manually — the receiver dedups on eventId, so safe to retry.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={stateFilter}
              onValueChange={(v) => setStateFilter(v as StateFilter)}
            >
              <SelectTrigger className="w-44" data-testid="select-state-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" data-testid="option-state-all">All states</SelectItem>
                <SelectItem value="pending" data-testid="option-state-pending">Pending</SelectItem>
                <SelectItem value="succeeded" data-testid="option-state-succeeded">Succeeded</SelectItem>
                <SelectItem value="dead_lettered" data-testid="option-state-dead-lettered">Dead-lettered</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-refresh"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {isError && (
          <Card className="p-6 border-destructive">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span data-testid="text-load-error">
                Failed to load: {error instanceof Error ? error.message : String(error)}
              </span>
            </div>
          </Card>
        )}

        {!isLoading && !isError && rows.length === 0 && (
          <Card className="p-8 text-center text-muted-foreground" data-testid="text-empty">
            No outbound webhook deliveries match the current filter.
          </Card>
        )}

        {!isLoading && !isError && rows.length > 0 && (
          <div className="space-y-3">
            {rows.map((row) => {
              const isExpanded = expanded[row.id] ?? false;
              const canRetry = row.state === "dead_lettered" || row.state === "pending";
              return (
                <Card
                  key={row.id}
                  className="p-4"
                  data-testid={`card-delivery-${row.id}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <button
                      type="button"
                      className="flex items-start gap-3 text-left flex-1 min-w-0"
                      onClick={() =>
                        setExpanded((prev) => ({ ...prev, [row.id]: !isExpanded }))
                      }
                      data-testid={`button-toggle-${row.id}`}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-5 w-5 mt-0.5 shrink-0" />
                      ) : (
                        <ChevronRight className="h-5 w-5 mt-0.5 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className="font-mono text-sm font-medium truncate"
                            data-testid={`text-event-id-${row.id}`}
                          >
                            {row.eventId}
                          </span>
                          <Badge
                            variant={stateBadgeVariant(row.state)}
                            data-testid={`badge-state-${row.id}`}
                          >
                            {row.state}
                          </Badge>
                          <Badge variant="outline" data-testid={`badge-event-type-${row.id}`}>
                            {row.eventType}
                          </Badge>
                          <Badge variant="outline" data-testid={`badge-attempts-${row.id}`}>
                            attempts: {row.attemptCount}
                          </Badge>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                          <span data-testid={`text-created-${row.id}`}>
                            Created: {formatTimestamp(row.createdAt)}
                          </span>
                          <span data-testid={`text-last-attempt-${row.id}`}>
                            Last attempt: {formatTimestamp(row.lastAttemptAt)}
                          </span>
                          {row.nextAttemptAt && (
                            <span data-testid={`text-next-attempt-${row.id}`}>
                              Next attempt: {formatTimestamp(row.nextAttemptAt)}
                            </span>
                          )}
                          {row.deadLetteredAt && (
                            <span data-testid={`text-dead-lettered-${row.id}`}>
                              Dead-lettered: {formatTimestamp(row.deadLetteredAt)}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canRetry || retryMutation.isPending}
                      onClick={() => setPendingRetry(row)}
                      data-testid={`button-retry-${row.id}`}
                    >
                      Retry now
                    </Button>
                  </div>

                  {isExpanded && (
                    <div
                      className="mt-4 border-t pt-4 space-y-3"
                      data-testid={`section-detail-${row.id}`}
                    >
                      <div className="text-xs font-medium text-muted-foreground">Target URL</div>
                      <div
                        className="font-mono text-xs break-all"
                        data-testid={`text-target-url-${row.id}`}
                      >
                        {row.targetUrl}
                      </div>

                      {row.lastErrorBody && (
                        <>
                          <div className="text-xs font-medium text-muted-foreground">
                            Last error
                          </div>
                          <pre
                            className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs font-mono rounded-md border bg-muted/40 p-3"
                            data-testid={`text-last-error-${row.id}`}
                          >
                            {row.lastErrorBody}
                          </pre>
                        </>
                      )}

                      <div className="text-xs font-medium text-muted-foreground">Payload</div>
                      <pre
                        className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs font-mono rounded-md border bg-muted/40 p-3"
                        data-testid={`text-payload-${row.id}`}
                      >
                        {JSON.stringify(row.payload, null, 2)}
                      </pre>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog
        open={pendingRetry !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRetry(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-retry-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Retry this webhook delivery?</AlertDialogTitle>
            <AlertDialogDescription>
              Delivery <span className="font-mono">#{pendingRetry?.id}</span> ({pendingRetry?.eventType})
              will be reset to pending and immediately re-attempted. The eventId is preserved, so
              Archidoc dedups if the original actually succeeded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-retry">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRetry) retryMutation.mutate(pendingRetry.id);
              }}
              data-testid="button-confirm-retry"
            >
              Retry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
