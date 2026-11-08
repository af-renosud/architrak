import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Flag, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Amount } from "@/components/ui/amount";
import type { NextActionExplanation, QuotationNextAction } from "@shared/quotation-next-actions";
import type { QuotationNextActionsController } from "@/hooks/use-quotation-next-actions";
import { nextActionHref } from "@/lib/quotation-next-actions";
import { goToQuotationTarget } from "./action-requirements";

const tones = {
  action: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  blocked: "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200",
  waiting: "border-border bg-muted text-muted-foreground",
  unknown: "border-border bg-muted text-muted-foreground",
};
const labels = { action: "Action needed", blocked: "Verified blocker", waiting: "Waiting", unknown: "Unknown" };

function ActionDetail({ action, primary, controller, projectId, onExpand, onNavigate }: {
  action: QuotationNextAction; primary: boolean; controller: QuotationNextActionsController;
  projectId: string; onExpand: () => void; onNavigate: () => void;
}) {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [explanation, setExplanation] = useState<NextActionExplanation | null>(null);
  const generation = useRef(0);
  const snapshot = JSON.stringify(action);
  useEffect(() => {
    generation.current += 1;
    setExplanation(null); setError(""); setBusy(false);
    return () => { generation.current += 1; };
  }, [snapshot, controller.unknown]);

  async function run(kind: "navigate" | "explain") {
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      if (kind === "explain") {
        const result = await controller.explain(action);
        if (request === generation.current) setExplanation(result);
      } else {
        const current = await controller.revalidate(action);
        if (request !== generation.current) return;
        onExpand();
        onNavigate();
        if (current.certificateId != null) {
          navigate(nextActionHref(current, projectId)!);
        } else if (current.target) {
          // Let the row and its workflow listeners mount before dispatching.
          requestAnimationFrame(() => requestAnimationFrame(() => goToQuotationTarget(current.devisId, current.target!, projectId)));
        } else {
          const href = nextActionHref(current, projectId);
          if (href) navigate(href);
        }
      }
    } catch (err) {
      if (request === generation.current) setError(err instanceof Error ? err.message : "Guidance unavailable. Retry.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  const hasDestination = !!action.target || !!nextActionHref(action, projectId);
  const href = action.certificateId != null || !action.target ? nextActionHref(action, projectId) : undefined;
  return <section className="space-y-2 border-b border-border pb-3 last:border-0 last:pb-0">
    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{primary ? "Primary action" : "Also needed"} · {labels[action.tone]} · {action.actor}</p>
    <h4 className="text-xs font-semibold">{action.label}</h4>
    <div className="text-[11px] space-y-1">
      <p><strong>Why: </strong>{action.why}</p>
      <p><strong>Next step: </strong>{action.nextStep}</p>
      {action.certificateRef != null && <p><strong>Certificate: </strong>{action.certificateRef}</p>}
      {action.outstandingTtc != null && <p><strong>Outstanding: </strong>{Number.isFinite(Number(action.outstandingTtc)) ? <Amount value={Number(action.outstandingTtc)} denomination="TTC" /> : "Amount unavailable — verify certificate"}</p>}
    </div>
    <div className="flex flex-wrap gap-2">
      {href ? <a href={href} aria-disabled={busy || controller.unknown}
        className={`inline-flex h-7 items-center rounded-md border border-input px-3 text-[11px] font-medium hover:bg-accent ${busy || controller.unknown ? "opacity-50" : ""}`}
        onClick={event => { event.preventDefault(); if (!busy && !controller.unknown) void run("navigate"); }}
        onAuxClick={event => event.preventDefault()}>
        {busy ? "Verifying…" : action.certificateId != null ? "View certificate" : "Go to next step"}
      </a> : hasDestination && <Button type="button" variant="outline" size="sm" className="h-7 text-[11px]" disabled={busy || controller.unknown} onClick={() => void run("navigate")}>
        {busy ? "Verifying…" : "Go to next step"}
      </Button>}
      <Button type="button" variant="ghost" size="sm" className="h-7 text-[11px]" disabled={busy || controller.unknown} onClick={() => void run("explain")}>Explain this action</Button>
    </div>
    {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
    {explanation && !controller.unknown && <div className="rounded border border-border bg-muted/40 p-2 text-[11px]">
      <p className="font-semibold">{explanation.source === "ai" ? "AI explanation" : "Factual fallback"}</p>
      <p className="whitespace-pre-wrap">{explanation.explanation}</p>
      <p className="mt-1 text-muted-foreground">Guidance only. No financial action has been performed.</p>
    </div>}
  </section>;
}

export function QuotationNextActionFlag({ devisId, projectId, controller, onExpand }: {
  devisId: number; projectId: string; controller: QuotationNextActionsController; onExpand: () => void;
}) {
  const [open, setOpen] = useState(false);
  const preserveNavigationFocus = useRef(false);
  const entry = controller.data?.quotations[devisId];
  const unknown = controller.unknown || !entry;
  const primary = !unknown ? entry.actions[0] : undefined;
  const tone = unknown ? "unknown" : primary?.tone ?? "waiting";
  const label = unknown ? controller.loading ? "Checking next action…" : "Next action unknown" : primary ? `${labels[tone]}: ${primary.label}` : "No next action identified";
  // Completed quotations need no additional row furniture. An unverified empty
  // response must still display the unknown flag and retry, never disappear.
  if (!unknown && entry.actions.length === 0) return null;
  return <div onClick={event => event.stopPropagation()} data-testid={`next-action-${devisId}`}>
    <Popover open={open} onOpenChange={next => { preserveNavigationFocus.current = false; setOpen(next); }}>
      <PopoverTrigger asChild>
        <button type="button" className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold text-left ${tones[tone]}`} aria-label={label}>
          {tone === "blocked" ? <AlertTriangle size={13} className="shrink-0" /> : <Flag size={13} className="shrink-0" />}
          <span>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(390px,calc(100vw-24px))] max-h-[70dvh] overflow-auto space-y-3" align="end" onClick={event => event.stopPropagation()}
        onCloseAutoFocus={event => {
          if (preserveNavigationFocus.current) event.preventDefault();
          preserveNavigationFocus.current = false;
        }}>
        <h3 className="text-xs font-semibold">Quotation next actions</h3>
        <p className="text-[10px] text-muted-foreground">Read-only guidance. Links open the relevant record or control; they never send, generate or record payment.</p>
        {unknown ? <div className="space-y-2">
          <p role="status" className="text-xs">{controller.loading ? "Checking current facts…" : "Current guidance cannot be verified. This does not mean the quotation is clear."}</p>
          <Button type="button" variant="outline" size="sm" disabled={controller.fetching} onClick={() => void controller.retry()}>Retry guidance</Button>
        </div> : entry.actions.map((action, index) => <ActionDetail key={action.id} action={action} primary={index === 0} controller={controller} projectId={projectId} onExpand={onExpand}
          onNavigate={() => { preserveNavigationFocus.current = true; setOpen(false); }} />)}
      </PopoverContent>
    </Popover>
  </div>;
}
