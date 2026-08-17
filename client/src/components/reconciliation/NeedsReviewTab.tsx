import { useState } from "react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertTriangle,
  ArrowRight,
  Calculator,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Layers,
  Loader2,
  Quote,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { AccountingStatusBadge } from "./AccountingStatusBadge";
import type {
  OverlapArithmeticProof,
  ProjectReviewCasesResponse,
  ResolvedReviewCard,
  ReviewCard,
  ReviewDevisSummary,
} from "@shared/reconciliation-dto";
import { Amount } from "@/components/ui/amount";
import { formatCurrency as fmt } from "@/lib/utils";

interface AccountingStatus {
  projectId: number;
  status: "clean" | "pending_analysis" | "needs_review" | "resolved";
  provisionalCount: number;
  supersededCount: number;
  needsReviewCount: number;
  eurosAtRisk: number;
}

function formatCentsAsEur(cents: number): string {
  return fmt(cents / 100);
}

const RELATIONSHIP_HEADLINE: Record<ReviewCard["relationshipType"], (n: number) => string> = {
  aggregates: (n) => `This consolidated devis appears to absorb ${n} earlier devis`,
  contains: (n) => `This devis appears to contain ${n} earlier devis`,
  supersedes: (n) => `This devis appears to supersede ${n} earlier devis`,
  duplicate: (n) => (n === 1 ? "This devis appears to be a duplicate of an earlier devis" : `This devis appears to duplicate ${n} earlier devis`),
  unrelated: () => "Possible overlap between these devis",
};

function headline(card: ReviewCard): string {
  return (RELATIONSHIP_HEADLINE[card.relationshipType] ?? RELATIONSHIP_HEADLINE.unrelated)(card.members.length);
}

function DevisSummaryCard({ summary, tone, label, testId }: {
  summary: ReviewDevisSummary | null;
  tone: "primary" | "member";
  label: string;
  testId: string;
}) {
  if (!summary) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 p-3 text-[11px] text-muted-foreground" data-testid={`${testId}-missing`}>
        Document no longer available
      </div>
    );
  }
  return (
    <div
      className={`rounded-xl border p-3 ${tone === "primary" ? "border-[#0B2545]/30 bg-[#0B2545]/[0.03]" : "border-slate-200 bg-white"}`}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-2">
        <TechnicalLabel className={tone === "primary" ? "text-[#0B2545]" : undefined}>{label}</TechnicalLabel>
        <StatusBadge status={summary.accountingState} size="sm" />
      </div>
      <p className="text-[13px] font-black text-[#0B2545] tracking-tight mt-1" data-testid={`${testId}-code`}>
        {summary.devisCode}
      </p>
      <p className="text-[11px] text-foreground truncate" title={summary.contractorName}>{summary.contractorName}</p>
      <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5" title={summary.descriptionFr}>{summary.descriptionFr}</p>
      <p className="text-[13px] font-semibold text-foreground mt-1.5" data-testid={`${testId}-ht`}>
        <Amount value={parseFloat(summary.amountHt)} denomination="HT" />
      </p>
    </div>
  );
}

function ArithmeticProofPanel({ proof, card }: { proof: OverlapArithmeticProof; card: ReviewCard }) {
  const equation = proof.memberCents.map((c) => formatCentsAsEur(c)).join(" + ");
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3" data-testid={`proof-${card.id}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Calculator size={13} className="text-[#0B2545]" />
        <TechnicalLabel>Arithmetic Proof</TechnicalLabel>
      </div>
      <p className="text-[12px] font-mono text-foreground" data-testid={`proof-equation-${card.id}`}>
        {equation || "—"} = {formatCentsAsEur(proof.sumCents)}
      </p>
      <div className="flex items-center gap-1.5 mt-1.5 text-[11px]">
        {proof.reconciles ? (
          <span className="inline-flex items-center gap-1 text-emerald-700" data-testid={`proof-verdict-${card.id}`}>
            <CheckCircle2 size={12} /> Matches the consolidated total of {formatCentsAsEur(proof.primaryCents)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-amber-700" data-testid={`proof-verdict-${card.id}`}>
            <AlertTriangle size={12} /> Off by {formatCentsAsEur(Math.abs(proof.deltaCents))} vs the consolidated total of {formatCentsAsEur(proof.primaryCents)}
          </span>
        )}
      </div>
    </div>
  );
}

function CitationsList({ card }: { card: ReviewCard }) {
  if (card.citations.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3" data-testid={`citations-${card.id}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Quote size={13} className="text-[#0B2545]" />
        <TechnicalLabel>Source Lines</TechnicalLabel>
      </div>
      <ul className="space-y-1">
        {card.citations.map((cit, idx) => (
          <li key={idx} className="text-[10px] text-foreground flex items-start gap-1.5" data-testid={`citation-${card.id}-${idx}`}>
            <FileText size={10} className="mt-0.5 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-semibold">{cit.devisCode ?? `Devis #${cit.devisId}`}</span>
              {cit.lineNumber != null && <span className="text-muted-foreground"> · line {cit.lineNumber}</span>}
              {" — "}{cit.description}
              {cit.totalHt != null && <span className="text-muted-foreground"> (<Amount value={parseFloat(cit.totalHt)} denomination="HT" />)</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DecisionCard({ card, projectId }: { card: ReviewCard; projectId: string }) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [pendingDecision, setPendingDecision] = useState<"confirm" | "dismiss" | null>(null);

  const resolveMutation = useMutation({
    mutationFn: async (decision: "confirm" | "dismiss") => {
      const res = await apiRequest("POST", `/api/overlap-cases/${card.id}/resolve`, {
        decision,
        note: note.trim() ? note.trim() : undefined,
      });
      return res.json();
    },
    onSuccess: (_data, decision) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "overlap-cases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "accounting-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "financial-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId)] });
      toast({
        title: decision === "confirm" ? "Overlap confirmed" : "Kept separate",
        description: decision === "confirm"
          ? `Earlier devis superseded — ${fmt(card.impactEuros)} removed from Contracted.`
          : "The devis were left as separate, genuinely-contracted documents.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Could not record decision", description: error.message, variant: "destructive" });
    },
    onSettled: () => setPendingDecision(null),
  });

  const isPending = resolveMutation.isPending;

  return (
    <LuxuryCard data-testid={`card-review-${card.id}`}>
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <Layers size={16} className="text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-[14px] font-black text-[#0B2545] tracking-tight" data-testid={`text-review-headline-${card.id}`}>
              {headline(card)}
            </p>
            {card.reasoning && (
              <p className="text-[11px] text-muted-foreground mt-0.5" data-testid={`text-review-reasoning-${card.id}`}>
                {card.reasoning}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1.4fr] gap-3 items-center">
          <DevisSummaryCard summary={card.primary} tone="primary" label="Consolidated" testId={`review-primary-${card.id}`} />
          <ArrowRight size={18} className="hidden lg:block text-muted-foreground mx-auto rotate-180" />
          <div className="space-y-2">
            <TechnicalLabel>Appears to replace ({card.members.length})</TechnicalLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {card.members.map((m) => (
                <DevisSummaryCard key={m.id} summary={m} tone="member" label="Earlier" testId={`review-member-${card.id}-${m.id}`} />
              ))}
            </div>
          </div>
        </div>

        {card.arithmeticProof && <ArithmeticProofPanel proof={card.arithmeticProof} card={card} />}

        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 flex items-center gap-2" data-testid={`impact-${card.id}`}>
          <AlertTriangle size={14} className="text-amber-600 shrink-0" />
          <p className="text-[12px] text-amber-800">
            Confirming removes <span className="font-bold" data-testid={`impact-euros-${card.id}`}><Amount value={card.impactEuros} denomination="HT" /></span> of double-counting from Contracted.
          </p>
        </div>

        <CitationsList card={card} />

        <div className="space-y-2 pt-1">
          <Textarea
            placeholder="Optional note for the audit trail (why you decided this)…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="text-[12px] min-h-[60px]"
            disabled={isPending}
            data-testid={`input-review-note-${card.id}`}
          />
          <div className="flex items-center justify-end gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => { setPendingDecision("dismiss"); resolveMutation.mutate("dismiss"); }}
              disabled={isPending}
              data-testid={`button-keep-separate-${card.id}`}
            >
              {isPending && pendingDecision === "dismiss" ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
              <span className="text-[9px] font-bold uppercase tracking-widest">Keep separate</span>
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => { setPendingDecision("confirm"); resolveMutation.mutate("confirm"); }}
              disabled={isPending}
              data-testid={`button-confirm-supersede-${card.id}`}
            >
              {isPending && pendingDecision === "confirm" ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              <span className="text-[9px] font-bold uppercase tracking-widest">Confirm (supersede the earlier ones)</span>
            </Button>
          </div>
        </div>
      </div>
    </LuxuryCard>
  );
}

function ResolvedCaseRow({ card }: { card: ResolvedReviewCard }) {
  const [expanded, setExpanded] = useState(false);
  const memberCodes = card.members.map((m) => m.devisCode).join(", ");
  return (
    <div className="rounded-xl border border-slate-200 bg-white" data-testid={`row-resolved-${card.id}`}>
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 p-3 text-left"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`button-resolved-toggle-${card.id}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-[#0B2545] truncate">
              {card.primary?.devisCode ?? `Case #${card.id}`} {memberCodes && <span className="text-muted-foreground font-normal">· {memberCodes}</span>}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {new Date(card.decidedAt).toLocaleDateString("fr-FR")}{card.actorEmail && ` · ${card.actorEmail}`}
            </p>
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[8px] font-black uppercase tracking-widest shrink-0 ${
            card.decision === "confirm"
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-slate-50 text-slate-600 border-slate-200"
          }`}
          data-testid={`text-resolved-decision-${card.id}`}
        >
          {card.decision === "confirm" ? <ShieldCheck size={10} /> : <XCircle size={10} />}
          {card.decision === "confirm" ? "Superseded" : "Kept separate"}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-slate-100 pt-2">
          {card.reasoning && <p className="text-[11px] text-muted-foreground">{card.reasoning}</p>}
          {card.note && (
            <p className="text-[11px] text-foreground">
              <span className="font-semibold">Note: </span>{card.note}
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <DevisSummaryCard summary={card.primary} tone="primary" label="Consolidated" testId={`resolved-primary-${card.id}`} />
            <div className="space-y-2">
              {card.members.map((m) => (
                <DevisSummaryCard key={m.id} summary={m} tone="member" label="Earlier" testId={`resolved-member-${card.id}-${m.id}`} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function NeedsReviewTab({ projectId }: { projectId: string }) {
  const [showResolved, setShowResolved] = useState(false);

  const { data, isLoading } = useQuery<ProjectReviewCasesResponse>({
    queryKey: ["/api/projects", String(projectId), "overlap-cases"],
  });
  const { data: status } = useQuery<AccountingStatus>({
    queryKey: ["/api/projects", String(projectId), "accounting-status"],
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  const openCases = data?.openCases ?? [];
  const resolvedCases = data?.resolvedCases ?? [];

  // Group open cases by contractor (primary devis's contractor) so the list
  // stays short and calm — one quiet section per contractor.
  const groups = new Map<string, ReviewCard[]>();
  for (const card of openCases) {
    const key = card.primary?.contractorName ?? "Unattributed";
    const existing = groups.get(key);
    if (existing) existing.push(card);
    else groups.set(key, [card]);
  }
  const groupedEntries = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <TechnicalLabel>Accounting Status</TechnicalLabel>
          {status && (
            <AccountingStatusBadge
              status={status.status}
              eurosAtRisk={status.eurosAtRisk}
              needsReviewCount={status.needsReviewCount}
            />
          )}
        </div>
        {resolvedCases.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => setShowResolved((v) => !v)}
            data-testid="button-toggle-resolved"
          >
            {showResolved ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="text-[9px] font-bold uppercase tracking-widest">
              History ({resolvedCases.length})
            </span>
          </Button>
        )}
      </div>

      {openCases.length === 0 ? (
        <LuxuryCard data-testid="card-no-review">
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
            <CheckCircle2 size={28} className="text-emerald-500" />
            <p className="text-[13px] font-semibold text-foreground">Nothing needs your review</p>
            <p className="text-[11px] text-muted-foreground max-w-sm">
              Any anomalies the system could prove on its own have already been resolved automatically.
              You'll only see cases here when a genuine human judgment is required.
            </p>
          </div>
        </LuxuryCard>
      ) : (
        <div className="space-y-5">
          {groupedEntries.map(([contractor, cards]) => (
            <div key={contractor} className="space-y-3" data-testid={`group-review-${contractor}`}>
              {groups.size > 1 && (
                <div className="flex items-center gap-2">
                  <TechnicalLabel>{contractor}</TechnicalLabel>
                  <span className="text-[9px] text-muted-foreground">({cards.length})</span>
                </div>
              )}
              {cards.map((card) => (
                <DecisionCard key={card.id} card={card} projectId={projectId} />
              ))}
            </div>
          ))}
        </div>
      )}

      {showResolved && resolvedCases.length > 0 && (
        <div className="space-y-2" data-testid="list-resolved-cases">
          <TechnicalLabel>Resolved History</TechnicalLabel>
          {resolvedCases.map((card) => (
            <ResolvedCaseRow key={card.id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}
