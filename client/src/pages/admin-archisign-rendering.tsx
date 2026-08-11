import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, RefreshCw, MailWarning } from "lucide-react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { OpsAdminNav } from "@/components/layout/OpsAdminNav";

interface DriftRow {
  id: number;
  devisCode: string | null;
  devisNumber: string | null;
  projectId: number;
  projectName: string | null;
  archisignEnvelopeId: string | null;
  archisignEnvelopeStatus: string | null;
  signOffStage: string | null;
  archisignSubjectDriftAt: string | null;
  archisignBodyDriftAt: string | null;
}

interface ListResponse {
  rows: DriftRow[];
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export default function AdminArchisignRendering() {
  const listQuery = useQuery<ListResponse>({
    queryKey: ["/api/admin/archisign-rendering-drift"],
  });

  const rows = listQuery.data?.rows ?? [];

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="page-admin-archisign-rendering">
        <OpsAdminNav />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Archisign rendering drift</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Devis whose current Archisign envelope reported{" "}
              <code>subjectApplied: false</code> and/or{" "}
              <code>bodyApplied: false</code> on creation — the signer received
              the invitation under Archisign&apos;s <strong>default</strong> email
              subject, and/or <strong>without</strong> the architect&apos;s
              personal note that the in-force contract requires to be rendered.
              The envelope itself went out normally (non-blocking). Escalate
              persistent drift to Archisign per contract §7.2 change control;
              each flag clears automatically when a fresh envelope for the same
              devis renders correctly.
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
            <CardTitle className="flex items-center gap-2">
              <MailWarning className="size-5 text-amber-600" />
              Rendering drift ({rows.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {listQuery.isLoading ? (
              <Loader2 className="size-6 animate-spin" />
            ) : rows.length === 0 ? (
              <div
                className="py-8 text-center text-sm text-muted-foreground"
                data-testid="text-empty"
              >
                No rendering drift reported — every envelope&apos;s custom subject
                and message were applied (or Archisign has not yet shipped the
                v1.2 echo).
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2">Devis</th>
                    <th>Project</th>
                    <th>Envelope</th>
                    <th>Envelope status</th>
                    <th>Stage</th>
                    <th>Subject dropped</th>
                    <th>Message dropped</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b align-top"
                      data-testid={`row-drift-${row.id}`}
                    >
                      <td className="py-2">
                        <Link
                          href={`/projets/${row.projectId}?devis=${row.id}`}
                          className="font-medium hover:underline"
                          data-testid={`link-devis-${row.id}`}
                        >
                          {row.devisNumber || row.devisCode || `devis #${row.id}`}
                        </Link>
                        <div className="text-xs text-muted-foreground">#{row.id}</div>
                      </td>
                      <td className="text-xs">
                        {row.projectName ?? `project ${row.projectId}`}
                      </td>
                      <td className="font-mono text-xs">
                        {row.archisignEnvelopeId ?? "—"}
                      </td>
                      <td className="text-xs">
                        {row.archisignEnvelopeStatus ? (
                          <Badge variant="secondary">
                            {row.archisignEnvelopeStatus}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="text-xs">{row.signOffStage ?? "—"}</td>
                      <td
                        className="text-xs"
                        data-testid={`text-drift-at-${row.id}`}
                      >
                        {formatDate(row.archisignSubjectDriftAt)}
                      </td>
                      <td
                        className="text-xs"
                        data-testid={`text-body-drift-at-${row.id}`}
                      >
                        {formatDate(row.archisignBodyDriftAt)}
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
