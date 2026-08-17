/**
 * Task #450 — Situation traffic-light review.
 *
 * Mirrors the devis line-item review experience 1:1 (same table layout,
 * green/amber/red Approved/Questioned/Rejected buttons, editable % input and
 * per-line Notes field under each entry) so quotation review and situation
 * review feel identical to the architect. Shows previous validated % →
 * claimed % → approved % per line with advisory flags (regression, jump,
 * claim on a rejected devis line). Confirm requires every line resolved.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Situation } from "@shared/schema";
import { Check, ChevronDown, ChevronRight, FileText, Loader2, AlertTriangle } from "lucide-react";
import { Amount } from "@/components/ui/amount";

interface SituationReviewLine {
  id: number;
  devisLineItemId: number;
  lineNumber: number;
  description: string;
  totalHt: string;
  previousPercent: number;
  claimedPercent: number | null;
  approvedPercent: number;
  cumulativeAmount: string;
  previousAmount: string;
  netAmount: string;
  checkStatus: string;
  checkNotes: string | null;
  flags: string[];
}

interface SituationReview {
  situation: Situation;
  lines: SituationReviewLine[];
}

// Same palette as the devis LineItemWithCheck traffic-light rows.
const CHECK_COLORS: Record<string, { border: string; row: string }> = {
  green: { border: "border-l-emerald-500", row: "bg-emerald-50/30" },
  amber: { border: "border-l-amber-400", row: "bg-amber-50/40" },
  red: { border: "border-l-rose-500", row: "bg-rose-50/40" },
  unchecked: { border: "border-l-transparent", row: "" },
};

const FLAG_LABELS: Record<string, { label: string; title: string }> = {
  regression: { label: "Régression", title: "Claimed % is below the previously validated %" },
  jump: { label: "Saut", title: "Claimed % jumps more than 50 points above the previous %" },
  claim_on_rejected: { label: "Ligne rejetée", title: "Progress claimed on a line rejected during devis review" },
};

function SituationLineRow({
  line,
  onUpdate,
  disabled,
}: {
  line: SituationReviewLine;
  onUpdate: (data: Record<string, string>) => Promise<unknown>;
  disabled: boolean;
}) {
  const status = line.checkStatus || "unchecked";
  const notes = line.checkNotes || "";
  const colors = CHECK_COLORS[status] || CHECK_COLORS.unchecked;
  const [notesOpen, setNotesOpen] = useState(!!notes);

  const fireUpdate = (data: Record<string, string>) => {
    void Promise.resolve(onUpdate(data)).catch(() => {});
  };

  const toggleStatus = (newStatus: string) => {
    if (disabled) return;
    const next = status === newStatus ? "unchecked" : newStatus;
    fireUpdate({ checkStatus: next });
  };

  return (
    <>
      <tr className={`border-l-[3px] ${colors.border} ${colors.row} transition-colors duration-500`} data-testid={`row-situation-line-${line.id}`}>
        <td className="py-1.5 px-2 text-[11px] align-top">{line.lineNumber}</td>
        <td className="py-1.5 px-2 text-[11px] align-top">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="whitespace-pre-wrap">{line.description}</span>
            {line.flags.map((f) => {
              const meta = FLAG_LABELS[f];
              if (!meta) return null;
              return (
                <span
                  key={f}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 text-[9px] font-bold uppercase tracking-widest"
                  title={meta.title}
                  data-testid={`badge-flag-${f}-${line.id}`}
                >
                  <AlertTriangle size={9} /> {meta.label}
                </span>
              );
            })}
          </div>
        </td>
        <td className="py-1.5 px-2 text-[11px] text-right font-medium"><Amount value={parseFloat(line.totalHt)} denomination="HT" /></td>
        <td className="py-1.5 px-2 text-[11px] text-right text-muted-foreground" data-testid={`text-prev-percent-${line.id}`}>
          {line.previousPercent}%
        </td>
        <td className="py-1.5 px-2 text-[11px] text-right" data-testid={`text-claimed-percent-${line.id}`}>
          {line.claimedPercent != null ? (
            <span className={line.flags.length ? "text-rose-600 font-semibold" : ""}>{line.claimedPercent}%</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="py-1.5 px-2">
          <div className="flex items-center justify-end gap-1">
            <Input
              type="number"
              className="h-6 w-16 text-[10px] text-right inline-block"
              defaultValue={line.approvedPercent}
              min={0}
              max={100}
              step={5}
              onBlur={(e) => { if (!disabled) fireUpdate({ percentComplete: e.target.value }); }}
              disabled={disabled}
              data-testid={`input-situation-line-percent-${line.id}`}
            />
            <div className="flex items-center gap-0.5 ml-1">
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "green" ? "bg-emerald-500 border-emerald-600 ring-2 ring-emerald-300" : "border-emerald-400 hover:bg-emerald-50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => toggleStatus("green")}
                disabled={disabled}
                title="Approved"
                data-testid={`button-situation-check-green-${line.id}`}
              >
                {status === "green" && <Check size={12} className="text-white" />}
              </button>
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "amber" ? "bg-amber-400 border-amber-500 ring-2 ring-amber-200" : "border-amber-400 hover:bg-amber-50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => toggleStatus("amber")}
                disabled={disabled}
                title="Questioned"
                data-testid={`button-situation-check-amber-${line.id}`}
              >
                {status === "amber" && <span className="text-white text-[10px] font-bold">?</span>}
              </button>
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "red" ? "bg-rose-500 border-rose-600 ring-2 ring-rose-300" : "border-rose-400 hover:bg-rose-50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => toggleStatus("red")}
                disabled={disabled}
                title="Rejected"
                data-testid={`button-situation-check-red-${line.id}`}
              >
                {status === "red" && <span className="text-white text-[10px] font-bold">✕</span>}
              </button>
            </div>
            <button
              className={`w-6 h-6 rounded-md border transition-all flex items-center justify-center ml-0.5 ${notesOpen ? "bg-[#c1a27b]/10 border-[#c1a27b] text-[#c1a27b]" : notes ? "border-[#c1a27b]/50 text-[#c1a27b]" : "border-gray-200 text-gray-400 hover:text-[#c1a27b] hover:border-[#c1a27b]/50"}`}
              onClick={() => setNotesOpen(!notesOpen)}
              title={notesOpen ? "Hide notes" : "Show notes"}
              data-testid={`button-situation-toggle-notes-${line.id}`}
            >
              <FileText size={11} />
            </button>
          </div>
        </td>
      </tr>
      {notesOpen && (
        <tr className={`border-l-[3px] ${colors.border}`}>
          <td colSpan={6} className="px-2 pb-2 pt-0.5">
            <input
              type="text"
              className="w-full h-7 px-3 text-[11px] rounded-lg border-2 outline-none transition-colors bg-white disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ borderColor: "#c1a27b" }}
              placeholder="Notes"
              defaultValue={notes}
              onBlur={(e) => {
                if (disabled) return;
                if (e.target.value !== notes) {
                  fireUpdate({ checkNotes: e.target.value });
                }
              }}
              disabled={disabled}
              data-testid={`input-situation-line-notes-${line.id}`}
            />
          </td>
        </tr>
      )}
      {!notesOpen && notes && (
        <tr className={`border-l-[3px] ${colors.border}`}>
          <td colSpan={6} className="px-2 pb-1 pt-0">
            <p className="text-[10px] text-[#c1a27b] italic truncate cursor-pointer" onClick={() => setNotesOpen(true)} data-testid={`text-situation-note-preview-${line.id}`}>
              {notes}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

function SituationReviewPanel({ situationId, devisId, isArchived }: { situationId: number; devisId: number; isArchived: boolean }) {
  const { toast } = useToast();
  const { data: review, isLoading } = useQuery<SituationReview>({
    queryKey: ["/api/situations", situationId, "review"],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/situations", situationId, "review"] });
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "situations"] });
  };

  const lineMutation = useMutation({
    mutationFn: async ({ lineId, data }: { lineId: number; data: Record<string, string> }) => {
      const res = await apiRequest("PATCH", `/api/situation-lines/${lineId}`, data);
      return res.json();
    },
    onSuccess: invalidate,
    onError: (err) => {
      toast({
        title: "Couldn't update line",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/situations/${situationId}/confirm`);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Situation confirmed", description: "This situation is now the baseline for the next one." });
    },
    onError: (err) => {
      toast({
        title: "Couldn't confirm situation",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (isLoading || !review) {
    return <div className="py-4 text-center"><Loader2 size={16} className="animate-spin inline-block text-muted-foreground" /></div>;
  }

  const isDraft = review.situation.status === "draft";
  const disabled = isArchived || !isDraft;
  const unresolved = review.lines.filter((l) => (l.checkStatus || "unchecked") === "unchecked").length;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-[rgba(0,0,0,0.08)]">
              <th className="text-left py-1 px-2 font-black uppercase tracking-widest text-[8px]">#</th>
              <th className="text-left py-1 px-2 font-black uppercase tracking-widest text-[8px]">Description</th>
              <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Total HT</th>
              <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Prev %</th>
              <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Claimed %</th>
              <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Approved %</th>
            </tr>
          </thead>
          <tbody>
            {review.lines.map((line) => (
              <SituationLineRow
                key={line.id}
                line={line}
                disabled={disabled}
                onUpdate={(data) => lineMutation.mutateAsync({ lineId: line.id, data })}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-3 pt-2 border-t border-[rgba(0,0,0,0.06)]">
        <div className="text-[10px] text-muted-foreground" data-testid={`text-situation-totals-${situationId}`}>
          Cumulé <Amount value={parseFloat(review.situation.cumulativeHt)} denomination="HT" /> · Précédent{" "}
          <Amount value={parseFloat(review.situation.previousHt)} denomination="HT" /> · Net{" "}
          <Amount value={parseFloat(review.situation.netHt)} denomination="HT" />
        </div>
        {isDraft && (
          <div className="flex items-center gap-2">
            {unresolved > 0 && (
              <span className="text-[10px] text-amber-600 font-semibold" data-testid={`text-situation-unresolved-${situationId}`}>
                {unresolved} line{unresolved > 1 ? "s" : ""} to resolve
              </span>
            )}
            <Button
              size="sm"
              className="h-7 px-3 text-[10px] font-bold uppercase tracking-widest"
              onClick={() => confirmMutation.mutate()}
              disabled={isArchived || unresolved > 0 || confirmMutation.isPending}
              data-testid={`button-confirm-situation-${situationId}`}
            >
              {confirmMutation.isPending ? <Loader2 size={10} className="animate-spin" /> : "Confirm Situation"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function SituationsSection({ devisId, isArchived }: { devisId: number; isArchived: boolean }) {
  const { data: situations = [], isLoading } = useQuery<Situation[]>({
    queryKey: ["/api/devis", devisId, "situations"],
  });
  const [openId, setOpenId] = useState<number | null>(null);

  if (isLoading) {
    return <div className="py-4 text-center"><Loader2 size={16} className="animate-spin inline-block text-muted-foreground" /></div>;
  }
  if (situations.length === 0) {
    return <p className="text-[11px] text-muted-foreground text-center py-2" data-testid={`text-no-situations-${devisId}`}>No situations. A situation de travaux PDF routed from Intake will appear here for review.</p>;
  }

  // Auto-open the latest draft (the one awaiting review).
  const draft = situations.find((s) => s.status === "draft");
  const effectiveOpenId = openId ?? draft?.id ?? null;

  return (
    <div className="space-y-2">
      {situations.map((s) => {
        const isOpen = effectiveOpenId === s.id;
        return (
          <div key={s.id} className="rounded-xl border border-[rgba(0,0,0,0.06)] bg-white/30" data-testid={`row-situation-${s.id}`}>
            <button
              type="button"
              className="w-full flex items-center justify-between p-2 text-left"
              onClick={() => setOpenId(isOpen ? -1 : s.id)}
              data-testid={`button-toggle-situation-${s.id}`}
            >
              <div className="flex items-center gap-2">
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="text-[11px] font-semibold">Situation nº{s.situationNumber}</span>
                {s.sourceFileName && (
                  <span className="text-[10px] text-muted-foreground truncate max-w-[220px]">{s.sourceFileName}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-foreground"><Amount value={parseFloat(s.netHt)} denomination="HT" /></span>
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest ${s.status === "confirmed" ? "bg-emerald-600 text-white" : "bg-amber-400 text-amber-950"}`}
                  data-testid={`chip-situation-status-${s.id}`}
                >
                  {s.status === "confirmed" ? "Confirmed" : "Draft"}
                </span>
              </div>
            </button>
            {isOpen && (
              <div className="px-3 pb-3">
                <SituationReviewPanel situationId={s.id} devisId={devisId} isArchived={isArchived} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
