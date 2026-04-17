import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, ShieldCheck, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { DocumentAdvisory } from "@shared/schema";

interface AdvisorySubject {
  type: "devis" | "invoice";
  id: number;
}

interface AdvisoriesListProps {
  subject: AdvisorySubject;
}

function formatTimestamp(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

export function AdvisoriesList({ subject }: AdvisoriesListProps) {
  const { toast } = useToast();
  const base = subject.type === "devis" ? "/api/devis" : "/api/invoices";
  const queryKey = [`${base}/${subject.id}/advisories`];
  const { data, isLoading } = useQuery<DocumentAdvisory[]>({ queryKey });

  const ackMutation = useMutation({
    mutationFn: async (advisoryId: number) => {
      const res = await apiRequest(
        "POST",
        `${base}/${subject.id}/advisories/${advisoryId}/acknowledge`,
        {},
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey;
          return (
            Array.isArray(k) &&
            typeof k[0] === "string" &&
            (k[0].includes("/api/devis") ||
              k[0].includes("/api/invoices") ||
              k[0].includes("/api/projects"))
          );
        },
      });
      toast({ title: "Advisory acknowledged" });
    },
    onError: (err: Error) =>
      toast({ title: "Acknowledge failed", description: err.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <p className="text-[10px] text-muted-foreground" data-testid="text-advisories-loading">
        Loading advisories...
      </p>
    );
  }

  const items = data ?? [];
  if (items.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground" data-testid="text-advisories-empty">
        No extraction advisories.
      </p>
    );
  }

  const open = items.filter((a) => !a.resolvedAt && !a.acknowledgedAt);
  const acknowledged = items.filter((a) => a.acknowledgedAt);
  const resolved = items.filter((a) => a.resolvedAt && !a.acknowledgedAt);

  const renderRow = (a: DocumentAdvisory, kind: "open" | "ack" | "resolved") => {
    const tone =
      kind === "open"
        ? a.severity === "error"
          ? "border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30"
          : "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
        : "border-muted bg-muted/40";
    return (
      <div
        key={a.id}
        className={`flex items-start gap-2 px-2 py-1.5 rounded-md border ${tone}`}
        data-testid={`advisory-row-${a.id}`}
      >
        {kind === "open" ? (
          <ShieldAlert size={12} className="mt-0.5" />
        ) : (
          <ShieldCheck size={12} className="mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-[8px]" data-testid={`badge-advisory-code-${a.id}`}>
              {a.code}
            </Badge>
            {a.field && (
              <span className="text-[9px] text-muted-foreground">{a.field}</span>
            )}
            <Badge variant="secondary" className="text-[8px]">
              {a.severity}
            </Badge>
            <Badge variant="outline" className="text-[8px]" data-testid={`badge-advisory-source-${a.id}`}>
              {a.source}
            </Badge>
            {kind === "ack" && (
              <Badge variant="secondary" className="text-[8px]">
                acknowledged
              </Badge>
            )}
            {kind === "resolved" && (
              <Badge variant="secondary" className="text-[8px]">
                resolved
              </Badge>
            )}
          </div>
          <p className="text-[10px] mt-0.5" data-testid={`text-advisory-message-${a.id}`}>
            {a.message}
          </p>
          <p className="text-[9px] text-muted-foreground mt-0.5">
            Raised {formatTimestamp(a.raisedAt)}
            {a.resolvedAt ? ` · Resolved ${formatTimestamp(a.resolvedAt)}` : ""}
            {a.acknowledgedAt
              ? ` · Acknowledged ${formatTimestamp(a.acknowledgedAt)}${a.acknowledgedBy ? ` by ${a.acknowledgedBy}` : ""}`
              : ""}
          </p>
        </div>
        {kind === "open" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 gap-1"
            onClick={() => ackMutation.mutate(a.id)}
            disabled={ackMutation.isPending}
            data-testid={`button-acknowledge-advisory-${a.id}`}
          >
            <Check size={10} />
            <span className="text-[9px] font-bold uppercase tracking-widest">Ack</span>
          </Button>
        )}
      </div>
    );
  };

  return (
    <div
      className="space-y-2"
      data-testid={`list-advisories-${subject.type}-${subject.id}`}
    >
      {open.length > 0 && (
        <div className="space-y-1.5" data-testid="advisories-section-open">
          <p className="text-[9px] uppercase tracking-widest text-muted-foreground">
            Open ({open.length})
          </p>
          {open.map((a) => renderRow(a, "open"))}
        </div>
      )}
      {(acknowledged.length > 0 || resolved.length > 0) && (
        <details data-testid="advisories-section-history">
          <summary className="text-[9px] uppercase tracking-widest text-muted-foreground cursor-pointer">
            History ({acknowledged.length + resolved.length})
          </summary>
          <div className="space-y-1.5 mt-1.5">
            {acknowledged.map((a) => renderRow(a, "ack"))}
            {resolved.map((a) => renderRow(a, "resolved"))}
          </div>
        </details>
      )}
    </div>
  );
}

interface AdvisoryBadgeProps {
  subject: AdvisorySubject;
}

export function AdvisoryBadge({ subject }: AdvisoryBadgeProps) {
  const base = subject.type === "devis" ? "/api/devis" : "/api/invoices";
  const queryKey = [`${base}/${subject.id}/advisories`];
  const { data } = useQuery<DocumentAdvisory[]>({ queryKey });
  const items = data ?? [];
  const open = items.filter((a) => !a.resolvedAt && !a.acknowledgedAt);
  if (open.length === 0) return null;
  const hasError = open.some((a) => a.severity === "error");
  return (
    <Badge
      variant="outline"
      className={`text-[9px] gap-1 ${
        hasError
          ? "border-rose-300 text-rose-600 bg-rose-50"
          : "border-amber-300 text-amber-600 bg-amber-50"
      }`}
      data-testid={`badge-advisories-${subject.type}-${subject.id}`}
    >
      <ShieldAlert size={10} />
      {open.length}
    </Badge>
  );
}
