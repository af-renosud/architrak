import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, ShieldCheck, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { DocumentAdvisory } from "@shared/schema";

interface AdvisoriesListProps {
  subject: { type: "devis" | "invoice"; id: number };
}

export function AdvisoriesList({ subject }: AdvisoriesListProps) {
  const { toast } = useToast();
  const queryKey = [`/api/${subject.type === "devis" ? "devis" : "invoices"}/${subject.id}/advisories`];
  const { data, isLoading } = useQuery<DocumentAdvisory[]>({ queryKey });

  const ackMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/advisories/${id}/acknowledge`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      // Refresh parent devis/invoice lists so any badges/counts reflect the change.
      queryClient.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey;
          return Array.isArray(k) && typeof k[0] === "string" && (
            k[0].includes(`/api/devis`) || k[0].includes(`/api/invoices`) ||
            k[0].includes(`/api/projects`)
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

  return (
    <div className="space-y-1.5" data-testid={`list-advisories-${subject.type}-${subject.id}`}>
      {items.map((a) => {
        const isOpen = !a.resolvedAt && !a.acknowledgedAt;
        const isAck = !!a.acknowledgedAt;
        return (
          <div
            key={a.id}
            className={`flex items-start gap-2 px-2 py-1.5 rounded-md border ${
              isOpen
                ? a.severity === "error"
                  ? "border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30"
                  : "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
                : "border-muted bg-muted/40"
            }`}
            data-testid={`advisory-row-${a.id}`}
          >
            {isOpen ? <ShieldAlert size={12} className="mt-0.5" /> : <ShieldCheck size={12} className="mt-0.5" />}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge variant="outline" className="text-[8px]" data-testid={`badge-advisory-code-${a.id}`}>
                  {a.code}
                </Badge>
                {a.field && (
                  <span className="text-[9px] text-muted-foreground">{a.field}</span>
                )}
                {isAck && (
                  <Badge variant="secondary" className="text-[8px]">
                    acknowledged
                  </Badge>
                )}
                {!isAck && a.resolvedAt && (
                  <Badge variant="secondary" className="text-[8px]">
                    resolved
                  </Badge>
                )}
              </div>
              <p className="text-[10px] mt-0.5" data-testid={`text-advisory-message-${a.id}`}>
                {a.message}
              </p>
            </div>
            {isOpen && (
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
      })}
    </div>
  );
}
