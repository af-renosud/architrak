import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, RotateCw, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface DriveUploadRow {
  id: number;
  docKind: "devis" | "invoice" | "certificat";
  docId: number;
  projectId: number;
  lotId: number | null;
  state: "pending" | "in_flight" | "succeeded" | "failed" | "dead_letter";
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  driveFileId: string | null;
  driveWebViewLink: string | null;
  displayName: string;
  updatedAt: string;
}

interface ListResponse {
  rows: DriveUploadRow[];
  enabled: boolean;
}

interface PingResponse {
  ok: boolean;
  driveName?: string;
  reason?: string;
}

const STATE_COLOURS: Record<DriveUploadRow["state"], string> = {
  pending: "bg-amber-100 text-amber-900",
  in_flight: "bg-blue-100 text-blue-900",
  succeeded: "bg-emerald-100 text-emerald-900",
  failed: "bg-red-100 text-red-900",
  dead_letter: "bg-red-200 text-red-950",
};

export default function AdminDriveUploads() {
  const { toast } = useToast();
  const [stateFilter, setStateFilter] = useState<DriveUploadRow["state"] | "all">("all");

  const listQuery = useQuery<ListResponse>({
    queryKey: ["/api/admin/drive-uploads", stateFilter],
    queryFn: async () => {
      const params = stateFilter === "all" ? "" : `?state=${stateFilter}`;
      const res = await fetch(`/api/admin/drive-uploads${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const pingQuery = useQuery<PingResponse>({
    queryKey: ["/api/admin/drive-uploads/ping"],
    enabled: false,
  });

  const retryMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("POST", `/api/admin/drive-uploads/${id}/retry`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/drive-uploads"] });
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
    <div className="container mx-auto p-6 space-y-6" data-testid="page-admin-drive-uploads">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Drive auto-upload</h1>
          <p className="text-sm text-muted-foreground">
            Pushes a copy of every devis / facture PDF to the Renosud shared Drive.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => pingQuery.refetch()}
            disabled={pingQuery.isFetching}
            data-testid="button-ping-drive"
          >
            {pingQuery.isFetching ? <Loader2 className="size-4 animate-spin" /> : "Test connection"}
          </Button>
        </div>
      </div>

      {listQuery.data && !listQuery.data.enabled && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-4 text-sm">
            <strong>Disabled.</strong> Set <code>DRIVE_AUTO_UPLOAD_ENABLED=true</code>,{" "}
            <code>GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON</code> and{" "}
            <code>GOOGLE_DRIVE_SHARED_DRIVE_ID</code> to enable.
          </CardContent>
        </Card>
      )}

      {pingQuery.data && (
        <Card className={pingQuery.data.ok ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}>
          <CardContent className="pt-4 text-sm" data-testid="text-drive-ping-result">
            {pingQuery.data.ok
              ? `✓ Service account can read shared Drive "${pingQuery.data.driveName}".`
              : `✗ ${pingQuery.data.reason}`}
          </CardContent>
        </Card>
      )}

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
                  <th>Doc</th>
                  <th>State</th>
                  <th>Attempts</th>
                  <th>Last error</th>
                  <th>Next attempt</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {listQuery.data?.rows.map((row) => (
                  <tr key={row.id} className="border-b" data-testid={`row-drive-upload-${row.id}`}>
                    <td className="py-2 font-mono">{row.id}</td>
                    <td>
                      <div className="font-medium">{row.displayName}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.docKind}#{row.docId} · project {row.projectId}
                        {row.lotId ? ` · lot ${row.lotId}` : " · (unassigned lot)"}
                      </div>
                    </td>
                    <td>
                      <Badge className={STATE_COLOURS[row.state]} data-testid={`badge-state-${row.id}`}>
                        {row.state}
                      </Badge>
                    </td>
                    <td>{row.attempts}</td>
                    <td className="max-w-xs truncate text-xs text-muted-foreground" title={row.lastError ?? ""}>
                      {row.lastError ?? "—"}
                    </td>
                    <td className="text-xs">
                      {row.nextAttemptAt ? new Date(row.nextAttemptAt).toLocaleString() : "—"}
                    </td>
                    <td className="text-xs">{new Date(row.updatedAt).toLocaleString()}</td>
                    <td className="space-x-2 text-right">
                      {row.driveWebViewLink && (
                        <a
                          href={row.driveWebViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"
                          data-testid={`link-drive-${row.id}`}
                        >
                          <ExternalLink size={12} /> Drive
                        </a>
                      )}
                      {(row.state === "dead_letter" || row.state === "failed" || row.state === "pending") && (
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
  );
}
