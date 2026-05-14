import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { OpsAdminNav } from "@/components/layout/OpsAdminNav";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import type { PostMergeTransientFailure } from "@shared/schema";

interface RecentFailure {
  timestamp: string;
  exitCode: number;
  logTail: string;
}

interface ListResponse {
  rows: PostMergeTransientFailure[];
}

function formatTimestamp(value: string | Date | null): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function parseRecentFailures(value: unknown): RecentFailure[] {
  if (!Array.isArray(value)) return [];
  const out: RecentFailure[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.timestamp === "string" &&
      typeof e.exitCode === "number" &&
      typeof e.logTail === "string"
    ) {
      out.push({ timestamp: e.timestamp, exitCode: e.exitCode, logTail: e.logTail });
    }
  }
  return out;
}

export default function AdminTransientFailuresPage() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingReset, setPendingReset] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<ListResponse>({
    queryKey: ["/api/admin/transient-failures"],
  });

  const resetMutation = useMutation({
    mutationFn: async (sourceTag: string) => {
      const res = await apiRequest("POST", "/api/admin/transient-failures/reset", { sourceTag });
      return res.json() as Promise<{ sourceTag: string; previousConsecutiveFailures: number }>;
    },
    onSuccess: (result) => {
      toast({
        title: "Counter reset",
        description: `${result.sourceTag}: broke a streak of ${result.previousConsecutiveFailures}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/transient-failures"] });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: "Reset failed", description: message, variant: "destructive" });
    },
    onSettled: () => {
      setPendingReset(null);
    },
  });

  const rows = data?.rows ?? [];
  const activeRows = rows.filter((r) => r.consecutiveFailures > 0);

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="page-transient-failures">
        <OpsAdminNav />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">
              Post-deploy backfill failures
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Sources currently failing transiently after deploys. Reset a counter once you've
              confirmed the underlying issue is resolved.
            </p>
          </div>
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
            No transient post-deploy failures recorded.
          </Card>
        )}

        {!isLoading && !isError && rows.length > 0 && (
          <>
            {activeRows.length === 0 && (
              <Card className="p-4 text-sm text-muted-foreground" data-testid="text-no-active">
                No sources currently failing — showing historical rows below.
              </Card>
            )}
            <div className="space-y-3">
              {rows.map((row) => {
                const isExpanded = expanded[row.sourceTag] ?? false;
                const recent = parseRecentFailures(row.recentFailures);
                const streak = row.consecutiveFailures;
                const streakActive = streak > 0;

                return (
                  <Card
                    key={row.sourceTag}
                    className="p-4"
                    data-testid={`card-source-${row.sourceTag}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <button
                        type="button"
                        className="flex items-start gap-3 text-left flex-1 min-w-0"
                        onClick={() =>
                          setExpanded((prev) => ({ ...prev, [row.sourceTag]: !isExpanded }))
                        }
                        data-testid={`button-toggle-${row.sourceTag}`}
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
                              data-testid={`text-source-${row.sourceTag}`}
                            >
                              {row.sourceTag}
                            </span>
                            <Badge
                              variant={streakActive ? "destructive" : "secondary"}
                              data-testid={`badge-streak-${row.sourceTag}`}
                            >
                              {streakActive ? `Streak: ${streak}` : "Cleared"}
                            </Badge>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                            <span data-testid={`text-last-failure-${row.sourceTag}`}>
                              Last failure: {formatTimestamp(row.lastFailureAt)}
                            </span>
                            <span data-testid={`text-last-exit-${row.sourceTag}`}>
                              Last exit code: {row.lastExitCode ?? "—"}
                            </span>
                            {row.lastClearedAt && (
                              <span data-testid={`text-last-cleared-${row.sourceTag}`}>
                                Last cleared: {formatTimestamp(row.lastClearedAt)}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!streakActive || resetMutation.isPending}
                        onClick={() => setPendingReset(row.sourceTag)}
                        data-testid={`button-reset-${row.sourceTag}`}
                      >
                        Reset counter
                      </Button>
                    </div>

                    {isExpanded && (
                      <div
                        className="mt-4 border-t pt-4 space-y-3"
                        data-testid={`section-history-${row.sourceTag}`}
                      >
                        {recent.length === 0 && (
                          <div className="text-sm text-muted-foreground">
                            No recent failure history recorded.
                          </div>
                        )}
                        {recent.map((failure, idx) => (
                          <div
                            key={`${failure.timestamp}-${idx}`}
                            className="rounded-md border bg-muted/40 p-3"
                            data-testid={`failure-${row.sourceTag}-${idx}`}
                          >
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span>{formatTimestamp(failure.timestamp)}</span>
                              <span>exit {failure.exitCode}</span>
                            </div>
                            <pre
                              className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs font-mono"
                              data-testid={`log-${row.sourceTag}-${idx}`}
                            >
                              {failure.logTail || "(empty log tail)"}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>

      <AlertDialog
        open={pendingReset !== null}
        onOpenChange={(open) => {
          if (!open) setPendingReset(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-reset-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Reset failure counter?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear the consecutive-failure streak for{" "}
              <span className="font-mono">{pendingReset}</span>. Only do this once you've
              confirmed the underlying issue is resolved — otherwise the next failure will
              start counting again from zero and the escalated alert will be delayed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-reset">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingReset) resetMutation.mutate(pendingReset);
              }}
              data-testid="button-confirm-reset"
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
