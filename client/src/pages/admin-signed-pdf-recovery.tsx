import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, RotateCw, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AppLayout } from "@/components/layout/AppLayout";
import { OpsAdminNav } from "@/components/layout/OpsAdminNav";

interface RecoveryRow {
  id: number;
  devisCode: string | null;
  projectId: number;
  lotId: number | null;
  archisignEnvelopeId: string | null;
  signedPdfRetryAttempts: number;
  signedPdfNextAttemptAt: string | null;
  signedPdfLastError: string | null;
  dateSigned: string | null;
  retentionBreachedAt: string | null;
  retentionIncidentRef: string | null;
}

interface ListResponse {
  rows: RecoveryRow[];
}

interface RetryResponse {
  id: number;
  recovered: boolean;
  signedPdfStorageKey: string | null;
  signedPdfLastError: string | null;
  signedPdfRetryAttempts: number;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export default function AdminSignedPdfRecovery() {
  const { toast } = useToast();

  const listQuery = useQuery<ListResponse>({
    queryKey: ["/api/admin/signed-pdf-recovery"],
  });

  const retryMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/signed-pdf-recovery/${id}/retry`);
      return (await res.json()) as RetryResponse;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/signed-pdf-recovery"] });
      if (result.recovered) {
        toast({
          title: "Signed PDF recovered",
          description: `Devis #${result.id}: audit copy persisted.`,
        });
      } else {
        toast({
          title: "Retry attempted — still missing",
          description: result.signedPdfLastError ?? "See logs for details.",
          variant: "destructive",
        });
      }
    },
    onError: (err) => {
      toast({
        title: "Retry failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  const rows = listQuery.data?.rows ?? [];

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="page-admin-signed-pdf-recovery">
        <OpsAdminNav />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Signed PDF recovery</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Devis at stage <code>client_signed_off</code> whose signed-PDF audit copy
              never landed in object storage. Retry runs the same persist + Drive enqueue
              path used by the Archisign webhook. Rows whose envelope has breached
              Archisign's retention window are read-only — the bytes are gone.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => listQuery.refetch()}
            disabled={listQuery.isFetching}
            data-testid="button-refresh"
          >
            <RefreshCw
              className={`size-4 mr-2 ${listQuery.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Missing audit copies ({rows.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {listQuery.isLoading ? (
              <Loader2 className="size-6 animate-spin" />
            ) : rows.length === 0 ? (
              <div
                className="py-8 text-center text-sm text-muted-foreground"
                data-testid="text-empty"
              >
                All signed devis have a persisted audit copy.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2">Devis</th>
                    <th>Envelope</th>
                    <th>Signed</th>
                    <th>Attempts</th>
                    <th>Next attempt</th>
                    <th>Last error</th>
                    <th className="text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const breached = Boolean(row.retentionBreachedAt);
                    return (
                      <tr
                        key={row.id}
                        className="border-b align-top"
                        data-testid={`row-recovery-${row.id}`}
                      >
                        <td className="py-2">
                          <div className="font-medium">
                            {row.devisCode ?? `devis #${row.id}`}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            #{row.id} · project {row.projectId}
                            {row.lotId ? ` · lot ${row.lotId}` : " · (no lot)"}
                          </div>
                        </td>
                        <td className="font-mono text-xs">
                          {row.archisignEnvelopeId ?? "—"}
                          {breached && (
                            <div className="mt-1">
                              <Badge
                                className="bg-red-200 text-red-950"
                                data-testid={`badge-retention-${row.id}`}
                                title={
                                  row.retentionIncidentRef
                                    ? `Incident ${row.retentionIncidentRef}`
                                    : undefined
                                }
                              >
                                retention breached
                              </Badge>
                            </div>
                          )}
                        </td>
                        <td className="text-xs">{formatDate(row.dateSigned)}</td>
                        <td className="text-xs">{row.signedPdfRetryAttempts}</td>
                        <td className="text-xs">{formatDate(row.signedPdfNextAttemptAt)}</td>
                        <td
                          className="max-w-xs truncate text-xs text-muted-foreground"
                          title={row.signedPdfLastError ?? ""}
                          data-testid={`text-last-error-${row.id}`}
                        >
                          {row.signedPdfLastError ?? "—"}
                        </td>
                        <td className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={breached || retryMutation.isPending}
                            onClick={() => retryMutation.mutate(row.id)}
                            data-testid={`button-retry-${row.id}`}
                            title={
                              breached
                                ? "Archisign has purged these bytes — recovery is no longer possible."
                                : undefined
                            }
                          >
                            <RotateCw size={12} className="mr-1" />
                            Retry persist
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
