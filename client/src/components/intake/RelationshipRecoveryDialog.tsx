import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Link2, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

export interface RelationshipRecoveryItem {
  id: number;
  fileName: string;
  canResolve: boolean;
  explanation: string;
}

interface RelationshipRecoveryPreview {
  items: RelationshipRecoveryItem[];
  token: string;
}

interface RelationshipRecoveryOutcome {
  id?: number;
  fileName?: string;
  reason?: string;
  message?: string;
  explanation?: string;
}

interface RelationshipRecoveryResult {
  processed: number;
  matched: number;
  remaining: number;
  failures?: Array<RelationshipRecoveryOutcome | string>;
  failed?: Array<RelationshipRecoveryOutcome | string>;
  failedItems?: Array<RelationshipRecoveryOutcome | string>;
  changed?: Array<RelationshipRecoveryOutcome | string>;
  changedItems?: Array<RelationshipRecoveryOutcome | string>;
  applied?: Array<RelationshipRecoveryOutcome | string>;
}

interface RelationshipRecoveryDialogProps {
  projectId: string;
  parkedCount: number;
  isArchived?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to load relationship preview.";
}

function outcomeMessage(outcome: RelationshipRecoveryOutcome | string): string {
  if (typeof outcome === "string") return outcome;
  return outcome.reason
    ?? outcome.message
    ?? outcome.explanation
    ?? outcome.fileName
    ?? `Document #${outcome.id ?? "unknown"}`;
}

function outcomeItems(
  result: RelationshipRecoveryResult | null,
  kind: "failed" | "changed",
): Array<RelationshipRecoveryOutcome | string> {
  if (!result) return [];
  const candidates = kind === "failed"
    ? [result.failures, result.failedItems, result.failed]
    : [result.changedItems, result.changed, result.applied];
  return candidates.find((items): items is Array<RelationshipRecoveryOutcome | string> => Array.isArray(items)) ?? [];
}

function isPreviewConflict(error: unknown): boolean {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown }
    : null;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  return /(?:preview_token_invalid|invalid_preview_token|preview_token_mismatch|stale_preview|stale_preview_token|expired_preview_token|preview_token_stale|preview_stale)|preview.*(?:token|stale|expired)|(?:token|preview).*(?:invalid|stale|expired)/i.test(`${code} ${message}`);
}

/**
 * Dry-run/re-evaluate controls for links that the intake queue deliberately
 * parked. The service returns a token-bound preview; no relationship is
 * applied until the operator explicitly presses the apply button.
 */
export function RelationshipRecoveryDialog({
  projectId,
  parkedCount,
  isArchived = false,
}: RelationshipRecoveryDialogProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [lastResult, setLastResult] = useState<RelationshipRecoveryResult | null>(null);
  const previewQueryKey = ["/api/projects", String(projectId), "intake", "relationships", "preview"];

  const previewQuery = useQuery<RelationshipRecoveryPreview>({
    queryKey: previewQueryKey,
    enabled: open && !isArchived,
  });

  const applyMutation = useMutation({
    mutationFn: async (token: string) => {
      const response = await apiRequest(
        "POST",
        `/api/projects/${projectId}/intake/relationships/re-evaluate`,
        { token },
      );
      return await response.json() as RelationshipRecoveryResult;
    },
    onSuccess: (result) => {
      setLastResult(result);
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "intake"] });
      queryClient.invalidateQueries({ queryKey: previewQueryKey });
      // Relationship recovery may route an invoice, or retain an order
      // document against a devis. Refresh each affected project surface
      // without assuming which kind the recovery service found.
      for (const surface of [
        "devis",
        "invoices",
        "marche-documents",
        "financial-summary",
        "accounting-status",
        "devis-readiness",
        "devis-checks",
      ]) {
        queryClient.invalidateQueries({
          queryKey: ["/api/projects", String(projectId), surface],
        });
      }
      toast({
        title: "Document links re-evaluated",
        description: `${result.matched} unambiguous ${result.matched === 1 ? "match was" : "matches were"} applied.`,
      });
    },
    onError: async (error: Error) => {
      if (isPreviewConflict(error)) {
        // Applying is optimistic only up to the signed preview boundary. If
        // another operator or the queue changed a source, get a fresh token
        // before offering Apply again rather than repeatedly posting stale
        // claims.
        setLastResult(null);
        await queryClient.invalidateQueries({ queryKey: previewQueryKey });
        await previewQuery.refetch();
        toast({
          title: "Preview refreshed",
          description: "The stored document links changed. Review the refreshed matches before applying again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Relationship re-evaluation failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const items = previewQuery.data?.items ?? [];
  const resolvableItems = items.filter((item) => item.canResolve);
  const unresolvedItems = items.filter((item) => !item.canResolve);
  const failedItems = outcomeItems(lastResult, "failed");
  const changedItems = outcomeItems(lastResult, "changed");

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8"
        onClick={() => {
          setLastResult(null);
          setOpen(true);
        }}
        disabled={isArchived}
        data-testid="button-review-intake-relationships"
      >
        <Link2 size={12} />
        <span className="text-[9px] font-bold uppercase tracking-widest">
          Review document links
        </span>
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {parkedCount}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl" data-testid="dialog-review-intake-relationships">
          <DialogHeader>
            <DialogTitle>Review document links</DialogTitle>
            <DialogDescription>
              Re-check stored references on parked intake documents. Only
              unambiguous matches can be applied, and no payment, approval, or
              supplier message is created by this action.
            </DialogDescription>
          </DialogHeader>

          {previewQuery.isLoading ? (
            <div className="space-y-3" data-testid="intake-relationships-loading">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : previewQuery.isError ? (
            <Alert variant="destructive" data-testid="intake-relationships-preview-error">
              <AlertTriangle size={15} />
              <AlertTitle>Preview unavailable</AlertTitle>
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{errorMessage(previewQuery.error)}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => previewQuery.refetch()}
                  data-testid="button-retry-intake-relationships-preview"
                >
                  <RefreshCw size={12} />
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2" data-testid="intake-relationships-counts">
                <div className="rounded-md border bg-muted/30 px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Parked reviewed</p>
                  <p className="mt-1 text-lg font-semibold">{items.length}</p>
                </div>
                <div className="rounded-md border bg-emerald-50/70 px-3 py-2 dark:bg-emerald-950/20">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-300">Unambiguous</p>
                  <p className="mt-1 text-lg font-semibold text-emerald-800 dark:text-emerald-200">{resolvableItems.length}</p>
                </div>
                <div className="rounded-md border bg-amber-50/70 px-3 py-2 dark:bg-amber-950/20">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-300">Needs review</p>
                  <p className="mt-1 text-lg font-semibold text-amber-800 dark:text-amber-200">{unresolvedItems.length}</p>
                </div>
              </div>

              {lastResult && (
                <Alert data-testid="intake-relationships-apply-result">
                  <CheckCircle2 size={15} />
                  <AlertTitle>Re-evaluation complete</AlertTitle>
                  <AlertDescription>
                    Processed {lastResult.processed}; applied {lastResult.matched}; remaining {lastResult.remaining}.
                    {failedItems.length > 0
                      ? ` ${failedItems.length} document${failedItems.length === 1 ? "" : "s"} still need attention.`
                      : ""}
                    {changedItems.length > 0
                      ? ` ${changedItems.length} changed ${changedItems.length === 1 ? "item was" : "items were"} linked.`
                      : ""}
                  </AlertDescription>
                </Alert>
              )}

              {items.length === 0 ? (
                <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground" data-testid="intake-relationships-empty">
                  No parked documents have a stored relationship to review.
                </p>
              ) : (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1" data-testid="intake-relationships-list">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-md border px-3 py-2"
                      data-testid={`intake-relationship-item-${item.id}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="min-w-0 truncate text-[12px] font-semibold">{item.fileName}</p>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest ${
                          item.canResolve
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                            : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                        }`}>
                          {item.canResolve ? "Can apply" : "Needs review"}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">{item.explanation}</p>
                    </div>
                  ))}
                </div>
              )}

              {failedItems.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900 dark:bg-amber-950/20" data-testid="intake-relationships-failures">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-amber-800 dark:text-amber-200">Failures</p>
                  <ul className="mt-1 space-y-1 text-[11px] text-amber-900 dark:text-amber-100">
                    {failedItems.map((failure, index) => (
                      <li key={`${typeof failure === "string" ? failure : failure.id ?? failure.fileName ?? "failure"}-${index}`}>
                        {typeof failure === "object" && failure.fileName ? `${failure.fileName}: ` : ""}{outcomeMessage(failure)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {changedItems.length > 0 && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900 dark:bg-emerald-950/20" data-testid="intake-relationships-changed">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-800 dark:text-emerald-200">Changed items</p>
                  <ul className="mt-1 space-y-1 text-[11px] text-emerald-900 dark:text-emerald-100">
                    {changedItems.map((changed, index) => (
                      <li key={`${typeof changed === "string" ? changed : changed.id ?? changed.fileName ?? "changed"}-${index}`}>
                        {typeof changed === "object" && changed.fileName ? `${changed.fileName}: ` : ""}{outcomeMessage(changed)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} data-testid="button-close-intake-relationships">
              Close
            </Button>
            <Button
              onClick={() => previewQuery.data?.token && applyMutation.mutate(previewQuery.data.token)}
              disabled={
                previewQuery.isLoading
                || previewQuery.isError
                || resolvableItems.length === 0
                || !previewQuery.data?.token
                || applyMutation.isPending
              }
              data-testid="button-apply-intake-relationships"
            >
              {applyMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              {applyMutation.isPending ? "Applying..." : "Apply unambiguous matches"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default RelationshipRecoveryDialog;