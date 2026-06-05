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

interface IntakeJobRow {
  id: number;
  intakeDocumentId: number;
  state: "pending" | "in_flight" | "succeeded" | "failed" | "dead_letter";
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  updatedAt: string;
  projectId: number;
  fileName: string;
  source: string;
  analysisState: string;
  routingState: string;
  promotedKind: string | null;
  promotedId: number | null;
}

interface ListResponse {
  rows: IntakeJobRow[];
}

const STATE_COLOURS: Record<IntakeJobRow["state"], string> = {
  pending: "bg-amber-100 text-amber-900",
  in_flight: "bg-blue-100 text-blue-900",
  succeeded: "bg-emerald-100 text-emerald-900",
  failed: "bg-red-100 text-red-900",
  dead_letter: "bg-red-200 text-red-950",
};

const ROUTING_COLOURS: Record<string, string> = {
  unrouted: "bg-slate-100 text-slate-900",
  routed: "bg-emerald-100 text-emerald-900",
  duplicate: "bg-violet-100 text-violet-900",
  parked: "bg-amber-100 text-amber-900",
  failed: "bg-red-100 text-red-900",
};

function promotedLink(row: IntakeJobRow): string | null {
  if (!row.promotedId) return null;
  if (row.promotedKind === "devis") return `/projects/${row.projectId}?devis=${row.promotedId}`;
  if (row.promotedKind === "invoice") return `/projects/${row.projectId}?invoice=${row.promotedId}`;
  return null;
}

export default function AdminIntakeJobs() {
  const { toast } = useToast();
  const [stateFilter, setStateFilter] = useState<IntakeJobRow["state"] | "all">("all");

  const listQuery = useQuery<ListResponse>({
    queryKey: ["/api/admin/intake-jobs", stateFilter],
    queryFn: async () => {
      const params = stateFilter === "all" ? "" : `?state=${stateFilter}`;
      const res = await fetch(`/api/admin/intake-jobs${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("POST", `/api/admin/intake-jobs/${id}/retry`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/intake-jobs"] });
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
      <div className="space-y-6" data-testid="page-admin-intake-jobs">
        <OpsAdminNav />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Intake routing</h1>
            <p className="text-sm text-muted-foreground">
              Background dedup → AI classify → auto-route of every intake document into a typed draft, or parked for manual handling.
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          {(["all", "pending", "in_flight", "succeeded", "failed", "dead_letter"] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={stateFilter === s ? "default" : "outline"}
              onClick={() => setStateFilter(s)}
              data-testid={`button-filter-${s}`}
            >
              {s}
            </Button>
          ))}
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
                    <th>Document</th>
                    <th>Job</th>
                    <th>Analysis</th>
                    <th>Routing</th>
                    <th>Result</th>
                    <th>Attempts</th>
                    <th>Last error</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {listQuery.data?.rows.map((row) => {
                    const link = promotedLink(row);
                    return (
                      <tr key={row.id} className="border-b" data-testid={`row-intake-job-${row.id}`}>
                        <td className="py-2 font-mono">{row.id}</td>
                        <td>
                          <div className="font-medium">{row.fileName}</div>
                          <div className="text-xs text-muted-foreground">
                            intake #{row.intakeDocumentId} · project {row.projectId} · {row.source}
                          </div>
                        </td>
                        <td>
                          <Badge className={STATE_COLOURS[row.state]} data-testid={`badge-state-${row.id}`}>
                            {row.state}
                          </Badge>
                        </td>
                        <td className="text-xs">{row.analysisState}</td>
                        <td>
                          <Badge
                            className={ROUTING_COLOURS[row.routingState] ?? "bg-slate-100 text-slate-900"}
                            data-testid={`badge-routing-${row.id}`}
                          >
                            {row.routingState}
                          </Badge>
                        </td>
                        <td className="text-xs">
                          {row.promotedKind && row.promotedId ? (
                            link ? (
                              <a
                                href={link}
                                className="text-blue-700 hover:underline"
                                data-testid={`link-promoted-${row.id}`}
                              >
                                {row.promotedKind} #{row.promotedId}
                              </a>
                            ) : (
                              <span>
                                {row.promotedKind} #{row.promotedId}
                              </span>
                            )
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{row.attempts}</td>
                        <td className="max-w-xs truncate text-xs text-muted-foreground" title={row.lastError ?? ""}>
                          {row.lastError ?? "—"}
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
