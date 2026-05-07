/**
 * Project-detail "Design Contract" card.
 *
 * Reads /api/projects/:id/design-contract and renders:
 *   - Header with totals + reference + a download button for the PDF.
 *   - Milestone list with status pill (reached / pending), trigger label,
 *     percentage, € TTC, "Mark reached" button (manual override) and
 *     "Mark invoiced" linkage stub (handled server-side once invoices land).
 *   - Replace-PDF dropzone driven by <DesignContractUpload mode="replace" />.
 *
 * If the project has no design contract yet (legacy or partial creation
 * fallout) the card renders an empty state inviting the architect to
 * upload one.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FileText, Download, CheckCircle2, Circle, Loader2, AlertCircle } from "lucide-react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { DesignContractUpload, type ConfirmedDesignContract } from "./DesignContractUpload";
import type { DesignContract, DesignContractMilestone, DesignContractTriggerEvent } from "@shared/schema";

interface DesignContractResponse {
  contract: DesignContract;
  milestones: DesignContractMilestone[];
}

const TRIGGER_LABELS: Record<DesignContractTriggerEvent, string> = {
  file_opened: "File opened",
  concept_signed: "Concept signed",
  permit_deposited: "Permit deposited",
  final_plans_signed: "Final plans signed",
  manual: "Manual tick",
};

function fmtEur(n: number | string | null | undefined): string {
  if (n == null) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(v);
}

interface DesignContractCardProps {
  projectId: number;
}

export function DesignContractCard({ projectId }: DesignContractCardProps) {
  const { toast } = useToast();
  const [pendingReplace, setPendingReplace] = useState<ConfirmedDesignContract | null>(null);

  const { data, isLoading, error } = useQuery<DesignContractResponse | null>({
    queryKey: ["/api/projects", projectId, "design-contract"],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/design-contract`, { credentials: "include" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      return res.json();
    },
  });

  const replaceMutation = useMutation({
    mutationFn: async (payload: ConfirmedDesignContract) => {
      // Re-upload destroys the prior milestone schedule — confirm before
      // we overwrite. Skipped when no contract exists yet (empty-state).
      if (data) {
        const ok = window.confirm(
          "Replacing the design contract will archive the existing PDF and overwrite the current milestone schedule. Continue?",
        );
        if (!ok) {
          const e = new Error("Cancelled");
          (e as Error & { __cancelled?: boolean }).__cancelled = true;
          throw e;
        }
      }
      const res = await apiRequest("POST", `/api/projects/${projectId}/design-contract`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "design-contract"] });
      setPendingReplace(null);
      toast({ title: "Design contract saved", description: "The new contract has been stored and the previous version archived." });
    },
    onError: (err: Error) => {
      if ((err as Error & { __cancelled?: boolean }).__cancelled) {
        setPendingReplace(null);
        return;
      }
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const markReachedMutation = useMutation({
    mutationFn: async (milestoneId: number) => {
      const res = await apiRequest("PATCH", `/api/design-contracts/milestones/${milestoneId}`, {
        status: "reached",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "design-contract"] });
      toast({ title: "Milestone marked reached" });
    },
    onError: (err: Error) => {
      toast({ title: "Could not update milestone", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <LuxuryCard data-testid="card-design-contract-loading">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> Loading design contract…
        </div>
      </LuxuryCard>
    );
  }

  if (error) {
    return (
      <LuxuryCard data-testid="card-design-contract-error">
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle size={14} /> Failed to load design contract: {error.message}
        </div>
      </LuxuryCard>
    );
  }

  if (!data) {
    return (
      <LuxuryCard data-testid="card-design-contract-empty">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileText size={16} />
            <h3 className="text-[14px] font-black uppercase tracking-tight">Design Contract</h3>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          No design contract on file. Upload the signed PDF — the AI will extract the totals and payment milestones.
        </p>
        <DesignContractUpload
          confirmed={pendingReplace}
          onConfirmed={(p) => { setPendingReplace(p); replaceMutation.mutate(p); }}
          onCleared={() => setPendingReplace(null)}
          mode="replace"
        />
      </LuxuryCard>
    );
  }

  const { contract, milestones } = data;
  const isReached = (m: DesignContractMilestone) => m.status !== "pending";
  const reachedCount = milestones.filter(isReached).length;

  return (
    <LuxuryCard data-testid="card-design-contract">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <FileText size={16} />
          <h3 className="text-[14px] font-black uppercase tracking-tight">Design Contract</h3>
          {contract.contractReference && (
            <Badge variant="outline" className="text-[10px]" data-testid="badge-contract-reference">
              {contract.contractReference}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/projects/${projectId}/design-contract/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-bold text-[#0B2545] hover:underline"
            data-testid="link-download-design-contract-pdf"
          >
            <Download size={12} /> PDF
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div>
          <TechnicalLabel>Total TTC</TechnicalLabel>
          <p className="text-[16px] font-light" data-testid="text-design-contract-total-ttc">{fmtEur(contract.totalTtc)}</p>
        </div>
        <div>
          <TechnicalLabel>Total HT</TechnicalLabel>
          <p className="text-[16px] font-light" data-testid="text-design-contract-total-ht">{fmtEur(contract.totalHt)}</p>
        </div>
        <div>
          <TechnicalLabel>Conception HT</TechnicalLabel>
          <p className="text-[16px] font-light">{fmtEur(contract.conceptionAmountHt)}</p>
        </div>
        <div>
          <TechnicalLabel>Planning HT</TechnicalLabel>
          <p className="text-[16px] font-light">{fmtEur(contract.planningAmountHt)}</p>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        <div className="flex items-center justify-between">
          <TechnicalLabel>Payment milestones ({reachedCount}/{milestones.length} reached)</TechnicalLabel>
        </div>
        <div className="space-y-1">
          {milestones.map((m) => {
            const reached = isReached(m);
            return (
            <div
              key={m.id}
              className={`flex items-center gap-3 p-2 rounded border ${reached ? "bg-emerald-50 border-emerald-200" : "bg-card border-border"}`}
              data-testid={`row-milestone-detail-${m.id}`}
            >
              {reached ? <CheckCircle2 size={14} className="text-emerald-600" /> : <Circle size={14} className="text-muted-foreground" />}
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">
                  #{m.sequence} · {m.labelFr}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Trigger: {TRIGGER_LABELS[m.triggerEvent as DesignContractTriggerEvent]}
                  {reached && m.reachedAt ? ` · reached ${new Date(m.reachedAt).toLocaleDateString()}` : ""}
                  {m.status === "invoiced" ? " · invoiced" : ""}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-xs font-medium" data-testid={`text-milestone-amount-${m.id}`}>{fmtEur(m.amountTtc)}</div>
                <div className="text-[10px] text-muted-foreground">{Number(m.percentage).toFixed(2)}%</div>
              </div>
              {!reached && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px]"
                  disabled={markReachedMutation.isPending}
                  onClick={() => markReachedMutation.mutate(m.id)}
                  data-testid={`button-mark-reached-${m.id}`}
                >
                  Mark reached
                </Button>
              )}
            </div>
            );
          })}
        </div>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground" data-testid="toggle-replace-design-contract">
          Replace contract (re-upload)
        </summary>
        <div className="mt-3">
          <DesignContractUpload
            confirmed={pendingReplace}
            onConfirmed={(p) => { setPendingReplace(p); replaceMutation.mutate(p); }}
            onCleared={() => setPendingReplace(null)}
            mode="replace"
          />
        </div>
      </details>
    </LuxuryCard>
  );
}
