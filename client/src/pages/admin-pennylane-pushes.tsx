import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, RotateCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AppLayout } from "@/components/layout/AppLayout";
import { OpsAdminNav } from "@/components/layout/OpsAdminNav";

type PushState = "pending" | "in_flight" | "succeeded" | "failed" | "dead_letter";
type PushKind = "customer" | "customer_invoice" | "email_send";

interface PennylanePushRow {
  id: number;
  kind: PushKind;
  docId: number;
  projectId: number;
  state: PushState;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  pennylaneId: string | null;
  dryRun: boolean;
  updatedAt: string;
}

interface ListResponse {
  rows: PennylanePushRow[];
  enabled: boolean;
  configured: boolean;
  dryRun: boolean;
}

interface PingResponse {
  ok: boolean;
  configured: boolean;
  pushEnabled: boolean;
  dryRun: boolean;
  message?: string;
  me?: unknown;
}

const STATE_COLOURS: Record<PushState, string> = {
  pending: "bg-amber-100 text-amber-900",
  in_flight: "bg-blue-100 text-blue-900",
  succeeded: "bg-emerald-100 text-emerald-900",
  failed: "bg-red-100 text-red-900",
  dead_letter: "bg-red-200 text-red-950",
};

export default function AdminPennylanePushes() {
  const { toast } = useToast();
  const [stateFilter, setStateFilter] = useState<PushState | "all">("all");
  const [kindFilter, setKindFilter] = useState<PushKind | "all">("all");

  const listQuery = useQuery<ListResponse>({
    queryKey: ["/api/admin/pennylane/pushes", stateFilter, kindFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (stateFilter !== "all") params.set("state", stateFilter);
      if (kindFilter !== "all") params.set("kind", kindFilter);
      const qs = params.toString();
      const res = await fetch(`/api/admin/pennylane/pushes${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const pingQuery = useQuery<PingResponse>({
    queryKey: ["/api/admin/pennylane/me"],
    enabled: false,
  });

  const retryMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("POST", `/api/admin/pennylane/pushes/${id}/retry`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pennylane/pushes"] });
      toast({ title: "Retry triggered", description: "One immediate attempt was fired." });
    },
    onError: (err) => {
      toast({
        title: "Retry failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="page-admin-pennylane-pushes">
        <OpsAdminNav />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Pennylane pushes</h1>
            <p className="text-sm text-muted-foreground">
              Outbound customer + customer_invoice + auto-email queue. Idempotent on (kind, doc_id).
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => pingQuery.refetch()}
              disabled={pingQuery.isFetching}
              data-testid="button-ping-pennylane"
            >
              {pingQuery.isFetching ? <Loader2 className="size-4 animate-spin" /> : "Test connection"}
            </Button>
          </div>
        </div>

        {listQuery.data && !listQuery.data.enabled && (
          <Card className="border-amber-300 bg-amber-50">
            <CardContent className="pt-4 text-sm">
              <strong>Disabled.</strong> Set <code>PENNYLANE_API_KEY</code> and{" "}
              <code>PENNYLANE_PUSH_ENABLED=true</code> to enable. Optionally set{" "}
              <code>PENNYLANE_DRY_RUN=true</code> for log-only mode and{" "}
              <code>PENNYLANE_PROJECT_WHITELIST=…</code> to limit which projects can push.
            </CardContent>
          </Card>
        )}

        {listQuery.data?.dryRun && (
          <Card className="border-blue-300 bg-blue-50">
            <CardContent className="pt-4 text-sm" data-testid="text-pennylane-dryrun-banner">
              <strong>Dry-run mode.</strong> Payloads are logged; the Pennylane API is NOT contacted.
              Mirror columns are written with sentinel <code>dry-run:…</code> ids.
            </CardContent>
          </Card>
        )}

        {pingQuery.data && (
          <Card className={pingQuery.data.ok ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}>
            <CardContent className="pt-4 text-sm" data-testid="text-pennylane-ping-result">
              {pingQuery.data.ok
                ? `✓ Pennylane API reachable (push_enabled=${pingQuery.data.pushEnabled}, dry_run=${pingQuery.data.dryRun}).`
                : `✗ ${pingQuery.data.message ?? "Unknown error"}`}
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap gap-4">
          <div className="flex flex-wrap gap-2">
            {(["all", "pending", "in_flight", "succeeded", "failed", "dead_letter"] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={stateFilter === s ? "default" : "outline"}
                onClick={() => setStateFilter(s)}
                data-testid={`button-filter-state-${s}`}
              >
                {s}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {(["all", "customer", "customer_invoice", "email_send"] as const).map((k) => (
              <Button
                key={k}
                size="sm"
                variant={kindFilter === k ? "default" : "outline"}
                onClick={() => setKindFilter(k)}
                data-testid={`button-filter-kind-${k}`}
              >
                {k}
              </Button>
            ))}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Queue ({listQuery.data?.rows.length ?? 0})</CardTitle>
          </CardHeader>
          <CardContent>
            {listQuery.isLoading ? (
              <Loader2 className="size-6 animate-spin" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2">ID</th>
                    <th>Kind</th>
                    <th>Doc</th>
                    <th>State</th>
                    <th>Attempts</th>
                    <th>Pennylane id</th>
                    <th>Last error</th>
                    <th>Next attempt</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {listQuery.data?.rows.map((row) => (
                    <tr key={row.id} className="border-b" data-testid={`row-pennylane-push-${row.id}`}>
                      <td className="py-2 font-mono">{row.id}</td>
                      <td>
                        <Badge variant="outline">{row.kind}</Badge>
                        {row.dryRun && <span className="ml-1 text-[10px] text-blue-700">[dry]</span>}
                      </td>
                      <td>
                        <div className="font-medium">#{row.docId}</div>
                        <div className="text-xs text-muted-foreground">project {row.projectId}</div>
                      </td>
                      <td>
                        <Badge className={STATE_COLOURS[row.state]} data-testid={`badge-state-${row.id}`}>
                          {row.state}
                        </Badge>
                      </td>
                      <td>{row.attempts}</td>
                      <td className="font-mono text-xs">{row.pennylaneId ?? "—"}</td>
                      <td className="max-w-xs truncate text-xs text-muted-foreground" title={row.lastError ?? ""}>
                        {row.lastError ?? "—"}
                      </td>
                      <td className="text-xs">
                        {row.nextAttemptAt ? new Date(row.nextAttemptAt).toLocaleString() : "—"}
                      </td>
                      <td className="text-xs">{new Date(row.updatedAt).toLocaleString()}</td>
                      <td className="text-right">
                        {(row.state === "dead_letter" || row.state === "failed") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => retryMutation.mutate(row.id)}
                            disabled={retryMutation.isPending}
                            data-testid={`button-retry-${row.id}`}
                          >
                            <RotateCw size={12} className="mr-1" /> Retry
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
