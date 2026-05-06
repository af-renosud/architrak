import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
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
import { AlertTriangle, RefreshCw, Undo2 } from "lucide-react";
import type { ArchidocProject, ArchidocContractor } from "@shared/schema";

interface ListResponse {
  projects: ArchidocProject[];
  contractors: ArchidocContractor[];
}

type RowKind = "project" | "contractor";

interface PendingRestore {
  kind: RowKind;
  archidocId: string;
  label: string;
}

function formatTimestamp(value: string | Date | null): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

export default function AdminMirrorRestorePage() {
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingRestore | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<ListResponse>({
    queryKey: ["/api/admin/mirror-restore"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/admin/mirror-restore");
      return res.json() as Promise<ListResponse>;
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (target: PendingRestore) => {
      const url =
        target.kind === "project"
          ? `/api/admin/mirror-restore/projects/${encodeURIComponent(target.archidocId)}/restore`
          : `/api/admin/mirror-restore/contractors/${encodeURIComponent(target.archidocId)}/restore`;
      const res = await apiRequest("POST", url);
      return res.json() as Promise<{
        archidocId: string;
        restored: boolean;
        refreshed: boolean;
        refreshError: string | null;
      }>;
    },
    onSuccess: (result, variables) => {
      if (result.refreshed) {
        toast({
          title: "Restored",
          description: `${variables.label} was restored and refreshed from the backend.`,
        });
      } else {
        toast({
          title: "Restored (not refreshed)",
          description:
            result.refreshError ?? `${variables.label} was restored but could not be refreshed.`,
          variant: "destructive",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/admin/mirror-restore"] });
      queryClient.invalidateQueries({ queryKey: ["/api/archidoc/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/archidoc/status"] });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: "Restore failed", description: message, variant: "destructive" });
    },
    onSettled: () => {
      setPending(null);
    },
  });

  const projects = data?.projects ?? [];
  const contractors = data?.contractors ?? [];
  const totalRows = projects.length + contractors.length;

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="page-mirror-restore">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">
              Restore archidoc mirror rows
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
              Mirror rows that disappeared from the upstream Archidoc response are soft-deleted by
              the reconciliation pass. If that was caused by a transient upstream issue, restore
              the row here and Architrak will re-fetch it from the configured backend.
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

        {!isLoading && !isError && totalRows === 0 && (
          <Card className="p-8 text-center text-muted-foreground" data-testid="text-empty">
            No soft-deleted mirror rows. The reconciliation pass has not cleared anything that needs
            operator attention.
          </Card>
        )}

        {!isLoading && !isError && projects.length > 0 && (
          <section className="space-y-3" data-testid="section-projects">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Soft-deleted projects ({projects.length})
            </h2>
            <div className="space-y-3">
              {projects.map((row) => (
                <Card
                  key={row.archidocId}
                  className="p-4"
                  data-testid={`card-project-${row.archidocId}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="font-medium truncate"
                          data-testid={`text-project-name-${row.archidocId}`}
                        >
                          {row.projectName}
                        </span>
                        {row.code && (
                          <Badge variant="outline" data-testid={`badge-project-code-${row.archidocId}`}>
                            {row.code}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                        <span
                          className="font-mono"
                          data-testid={`text-project-archidoc-id-${row.archidocId}`}
                        >
                          {row.archidocId}
                        </span>
                        <span data-testid={`text-project-deleted-at-${row.archidocId}`}>
                          Soft-deleted: {formatTimestamp(row.deletedAt)}
                        </span>
                        <span data-testid={`text-project-source-${row.archidocId}`}>
                          Source: {row.sourceBaseUrl ?? "—"}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restoreMutation.isPending}
                      onClick={() =>
                        setPending({
                          kind: "project",
                          archidocId: row.archidocId,
                          label: `Project "${row.projectName}"`,
                        })
                      }
                      data-testid={`button-restore-project-${row.archidocId}`}
                    >
                      <Undo2 className="h-4 w-4 mr-2" />
                      Restore
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </section>
        )}

        {!isLoading && !isError && contractors.length > 0 && (
          <section className="space-y-3" data-testid="section-contractors">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Soft-deleted contractors ({contractors.length})
            </h2>
            <div className="space-y-3">
              {contractors.map((row) => (
                <Card
                  key={row.archidocId}
                  className="p-4"
                  data-testid={`card-contractor-${row.archidocId}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="font-medium truncate"
                          data-testid={`text-contractor-name-${row.archidocId}`}
                        >
                          {row.name}
                        </span>
                        {row.siret && (
                          <Badge variant="outline" data-testid={`badge-contractor-siret-${row.archidocId}`}>
                            SIRET {row.siret}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                        <span
                          className="font-mono"
                          data-testid={`text-contractor-archidoc-id-${row.archidocId}`}
                        >
                          {row.archidocId}
                        </span>
                        <span data-testid={`text-contractor-deleted-at-${row.archidocId}`}>
                          Soft-deleted: {formatTimestamp(row.deletedAt)}
                        </span>
                        <span data-testid={`text-contractor-source-${row.archidocId}`}>
                          Source: {row.sourceBaseUrl ?? "—"}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restoreMutation.isPending}
                      onClick={() =>
                        setPending({
                          kind: "contractor",
                          archidocId: row.archidocId,
                          label: `Contractor "${row.name}"`,
                        })
                      }
                      data-testid={`button-restore-contractor-${row.archidocId}`}
                    >
                      <Undo2 className="h-4 w-4 mr-2" />
                      Restore
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </section>
        )}
      </div>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-restore-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this mirror row?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.label} will be un-soft-deleted and immediately refreshed from the configured
              Archidoc backend. If the upstream still does not return this row, the next full sync
              will soft-delete it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-restore">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) restoreMutation.mutate(pending);
              }}
              data-testid="button-confirm-restore"
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
