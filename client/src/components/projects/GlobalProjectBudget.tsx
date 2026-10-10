import { useState } from "react";
import { Plus, Pencil, History, RotateCcw, Ban } from "lucide-react";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/queryClient";
import type { FinancialSummary } from "@/lib/financial-summary";
import { externalWorkForm, validateExternalWork, type ExternalWork, type ExternalWorkAudit, type ExternalWorksResponse } from "@/lib/external-works";
import { useExternalWorks, useWriteExternalWork, type ExternalWorkWrite } from "@/hooks/use-external-works";

type Operation = { action: "create" } | { action: "edit" | "void" | "restore"; entry: ExternalWork };
const scopeWarning = "Never also count the same scope in a managed Devis. These are historical completed costs, not paid or certified amounts. Fees and payment balances are unchanged.";

function MoneyPair({ ht, ttc }: { ht: number; ttc: number }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
    <Amount value={ht} denomination="HT" />
    <Amount value={ttc} denomination="TTC" />
  </div>;
}

function AuditHistory({ history, entries }: { history: ExternalWorkAudit[]; entries: ExternalWork[] }) {
  const labels: Partial<Record<keyof ExternalWork, string>> = {
    reference: "Reference", description: "Description", amountHt: "HT", amountTtc: "TTC",
    companyName: "Company", lot: "Lot", completionDate: "Completion date", status: "Status", voidReason: "Void reason",
  };
  return <div className="space-y-3">
    {history.length === 0 && <p className="text-sm text-muted-foreground">No changes recorded yet.</p>}
    {[...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id).map(event => (
      <article key={event.id} className="rounded-lg border border-border p-3 text-xs">
        <p className="font-semibold">{entries.find(e => e.id === event.entryId)?.reference ?? event.after?.reference ?? event.before?.reference ?? `Entry ${event.entryId}`} · {event.action}</p>
        <p className="mt-1 text-muted-foreground">{event.actorName || "Actor not recorded"} · <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></p>
        {event.reason && <p className="mt-2">Reason: {event.reason}</p>}
        <dl className="mt-2 space-y-1">
          {(Object.keys(labels) as (keyof ExternalWork)[]).filter(key => event.before?.[key] !== event.after?.[key]).map(key => {
            const display = (value: unknown) => key === "amountHt" || key === "amountTtc"
              ? value == null ? "Not set" : <Amount value={Number(value)} denomination={key === "amountHt" ? "HT" : "TTC"} />
              : String(value ?? "Not set");
            return <div key={key} className="grid grid-cols-[7rem_1fr] gap-2">
              <dt className="text-muted-foreground">{labels[key]}</dt>
              <dd className="break-words">{display(event.before?.[key])} → {display(event.after?.[key])}</dd>
            </div>;
          })}
        </dl>
      </article>
    ))}
  </div>;
}

function ExternalWorkEditor({ projectId, operation, readOnly, onClose, reload }: {
  projectId: number; operation: Operation; readOnly: boolean; onClose: () => void;
  reload: () => Promise<{ data?: ExternalWorksResponse; isError?: boolean }>;
}) {
  const original = operation.action === "create" ? undefined : operation.entry;
  // Snapshot only on open: query invalidation/refetch must never replace unsaved edits.
  const [form, setForm] = useState(() => externalWorkForm(original));
  const [version, setVersion] = useState(original?.version ?? 0);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [overlaps, setOverlaps] = useState<{ id: number; reference: string }[]>([]);
  const [overlapRequired, setOverlapRequired] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [latest, setLatest] = useState<ExternalWork>();
  const [reviewing, setReviewing] = useState(false);
  const mutation = useWriteExternalWork(projectId);
  const isForm = operation.action === "create" || operation.action === "edit";

  function changeField(key: keyof Omit<typeof form, "confirmedCompleted">, value: string) {
    setForm(previous => ({ ...previous, [key]: value }));
    // An acknowledgement is valid only for the exact content that was reviewed.
    // Changed content must receive a fresh server overlap check before retrying.
    setOverlapRequired(false);
    setOverlaps([]);
    setAcknowledged(false);
    setError("");
  }

  function submit() {
    if (readOnly || mutation.isPending || conflicted) return;
    const validation = isForm ? validateExternalWork(form) : operation.action === "void" && !reason.trim() ? "A void reason is required." : null;
    if (validation) { setError(validation); return; }
    if (overlapRequired && !acknowledged) { setError("Review and explicitly acknowledge the managed Devis overlap before retrying."); return; }
    const overlap = overlapRequired && acknowledged ? { acknowledgeOverlap: true as const } : {};
    let write: ExternalWorkWrite;
    if (operation.action === "create") write = { action: "create", form, ...overlap };
    else if (operation.action === "edit") write = { action: "edit", id: operation.entry.id, version, form, ...overlap };
    else if (operation.action === "void") write = { action: "void", id: operation.entry.id, version, reason };
    else write = { action: "restore", id: operation.entry.id, version, ...overlap };
    setError("");
    mutation.mutate(write, {
      onSuccess: onClose,
      onError: (failure) => {
        if (failure instanceof ApiError && failure.code === "MANAGED_OVERLAP") {
          const data = failure.data as { overlaps?: { id: number; reference: string }[] };
          setOverlaps(data.overlaps ?? []);
          setOverlapRequired(true);
          setAcknowledged(false);
          setError("Potential overlap with managed Devis. Resolve the duplicated scope or explicitly acknowledge the warning.");
        } else if (failure instanceof ApiError && failure.code === "VERSION_CONFLICT") {
          setConflicted(true);
          setLatest(undefined);
          setError("This entry changed since you opened it. Your unsaved content is preserved. Review the latest version before retrying.");
        } else if (failure instanceof ApiError && failure.code === "DUPLICATE_REFERENCE") {
          setError("This reference already exists in this project, including voided entries. Use a unique reference or restore the original entry.");
        } else setError(failure.message || "Unable to save. Please retry.");
      },
    });
  }

  const title = operation.action === "create" ? "Add external works" : operation.action === "edit" ? "Edit external works" : operation.action === "void" ? "Void external works" : "Restore external works";
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" onInteractOutside={event => event.preventDefault()}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{scopeWarning}</DialogDescription>
      </DialogHeader>
      <form onSubmit={event => { event.preventDefault(); submit(); }} className="space-y-4">
        <fieldset disabled={readOnly || mutation.isPending} className="space-y-4">
          {isForm ? <>
            {([
              ["reference", "External reference", true], ["description", "Description", true],
              ["amountHt", "Amount HT (€)", true], ["amountTtc", "Amount TTC (€)", true],
              ["companyName", "Company name", false], ["lot", "Lot", false], ["completionDate", "Completion date", false],
            ] as const).map(([key, label, required]) => <div key={key} className="space-y-1">
              <label htmlFor={`external-${key}`} className="text-xs font-medium">{label}{required ? " *" : " (optional)"}</label>
              {key === "description" ? <Textarea id={`external-${key}`} required value={form[key]} onChange={event => changeField(key, event.target.value)} /> : <Input id={`external-${key}`} required={required} type={key === "completionDate" ? "date" : "text"}
                inputMode={key === "amountHt" || key === "amountTtc" ? "decimal" : undefined}
                value={form[key]} onChange={event => changeField(key, event.target.value)} />}
            </div>)}
            <p className="text-xs text-muted-foreground">Enter both amounts explicitly with up to two decimal places (decimal point). No VAT rate is assumed or calculated.</p>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={form.confirmedCompleted} onChange={event => setForm({ ...form, confirmedCompleted: event.target.checked })} />
              I confirm these are agreed, completed works outside ArchiTrak, not planned or partially completed works.
            </label>
          </> : <>
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <p className="font-semibold">{original?.reference} · {original?.description}</p>
              <MoneyPair ht={Number(original?.amountHt)} ttc={Number(original?.amountTtc)} />
              {original?.voidReason && <p className="mt-2 text-xs">Void reason: {original.voidReason}</p>}
            </div>
            {operation.action === "void" ? <div className="space-y-1">
              <label htmlFor="external-void-reason" className="text-xs font-medium">Void reason *</label>
              <Textarea id="external-void-reason" value={reason} required onChange={event => setReason(event.target.value)} />
              <p className="text-xs text-muted-foreground">Excluded from the budget, retained in the audit history. This can be restored later.</p>
            </div> : <p className="text-xs text-muted-foreground">Restoring includes this cost in the external and combined totals again. It does not certify or record a payment.</p>}
          </>}
          {overlapRequired && <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs space-y-2">
            <p className="font-semibold">Potential managed Devis overlap</p>
            <ul>{overlaps.map(overlap => <li key={overlap.id}>{overlap.reference}</li>)}</ul>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
              I reviewed these references and confirm this external scope is not also counted in managed Devis.
            </label>
          </div>}
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {conflicted && <div className="rounded-lg border border-border p-3 space-y-3 text-xs">
          <Button type="button" variant="outline" size="sm" disabled={reviewing} onClick={async () => {
            setReviewing(true);
            try {
              const result = await reload();
              if (result.isError) { setError("Could not load the latest entry. Retry the review."); return; }
              const entry = result.data?.entries.find(entry => entry.id === original?.id);
              if (entry) setLatest(entry);
              else setError("Could not load the latest entry. Retry the review.");
            } catch { setError("Could not load the latest entry. Retry the review."); }
            finally { setReviewing(false); }
          }}>{reviewing ? "Loading latest version…" : "Review latest version"}</Button>
          {latest && <>
            <p className="font-semibold">Server version {latest.version} · {latest.status}</p>
            <p>{latest.reference} · {latest.description}</p>
            <MoneyPair ht={Number(latest.amountHt)} ttc={Number(latest.amountTtc)} />
            <p>{[latest.companyName, latest.lot, latest.completionDate].filter(Boolean).join(" · ")}</p>
            {latest.voidReason && <p>Void reason: {latest.voidReason}</p>}
            <p>Updated {new Date(latest.updatedAt).toLocaleString()}. Review the audit history for actor attribution.</p>
            {latest.status === (operation.action === "restore" ? "void" : "active") ? <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => {
              setVersion(latest.version); setConflicted(false); setLatest(undefined); setError(""); setAcknowledged(false); setOverlapRequired(false); setOverlaps([]);
            }}>Use this version, keep my {isForm ? "edits" : "action"}</Button> : <p>This entry’s status no longer allows this action. Close and reopen the appropriate action from the register.</p>}
          </>}
        </div>}
        {readOnly && <p className="text-xs text-muted-foreground">Archived project — read-only.</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button type="submit" disabled={readOnly || mutation.isPending || conflicted || (overlapRequired && !acknowledged)}>
            {mutation.isPending ? "Saving…" : operation.action === "void" ? "Void entry" : operation.action === "restore" ? "Restore entry" : "Save external works"}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

export function GlobalProjectBudget({ projectId, summary, readOnly }: {
  projectId: number; summary: FinancialSummary; readOnly: boolean;
}) {
  const register = useExternalWorks(projectId);
  const [expanded, setExpanded] = useState(false);
  const [showVoid, setShowVoid] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const entries = register.data?.entries ?? [];
  const activeCount = entries.filter(entry => entry.status === "active").length;
  return <LuxuryCard data-testid="global-project-budget">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><TechnicalLabel>Global project budget</TechnicalLabel>
        <p className="mt-1 text-xs text-muted-foreground">Signed managed commitments + historical completed works</p>
      </div>
      {!readOnly && <Button variant="outline" size="sm" onClick={() => setOperation({ action: "create" })}><Plus size={13} className="mr-1" />Add external works</Button>}
      {readOnly && <span className="text-xs text-muted-foreground">Archived · read-only</span>}
    </div>
    <dl className="mt-4 divide-y divide-border text-xs">
      <div className="flex flex-col gap-2 py-3 md:flex-row md:justify-between"><dt>ArchiTrak-managed · signed, including adjustments</dt><dd><MoneyPair ht={summary.totalContractedHt} ttc={summary.totalContractedTtc} /></dd></div>
      <div className="flex flex-col gap-2 py-3 md:flex-row md:justify-between"><dt>External · completed, not certified</dt><dd>{summary.totalExternalHt == null || summary.totalExternalTtc == null ? <span className="text-muted-foreground">External totals unavailable</span> : <MoneyPair ht={summary.totalExternalHt} ttc={summary.totalExternalTtc} />}</dd></div>
      <div className="flex flex-col gap-2 py-3 md:flex-row md:justify-between font-semibold"><dt>Combined project cost</dt><dd>{summary.totalCombinedCostHt == null || summary.totalCombinedCostTtc == null ? <span className="text-muted-foreground">Combined totals unavailable</span> : <MoneyPair ht={summary.totalCombinedCostHt} ttc={summary.totalCombinedCostTtc} />}</dd></div>
    </dl>
    <p className="text-[11px] text-muted-foreground">Pending unsigned quotations remain separate and excluded. {scopeWarning}</p>
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls="external-works-register" onClick={() => setExpanded(!expanded)}>{expanded ? "Hide register" : "View register"}{register.data ? ` (${activeCount} active)` : ""}</Button>
      <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}><History size={13} className="mr-1" />Audit history</Button>
    </div>
    {register.isError && <div role="alert" className="mt-3 text-xs text-destructive">Could not load the external works register. <Button variant="outline" size="sm" onClick={() => void register.refetch()}>Retry</Button></div>}
    {expanded && <div id="external-works-register" className="mt-3 space-y-3">
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={showVoid} onChange={event => setShowVoid(event.target.checked)} />Show voided entries</label>
      {register.isLoading ? <Skeleton className="h-20 w-full" /> : !register.isError && entries.filter(entry => showVoid || entry.status === "active").length === 0 ?
        <div className="rounded-lg border border-dashed border-border p-5"><p className="text-sm font-medium">No {showVoid ? "" : "active "}external works recorded</p><p className="mt-1 text-xs text-muted-foreground">Add only agreed, completed works carried out outside ArchiTrak. Managed Devis stay in their existing workflow.</p></div> :
        entries.filter(entry => showVoid || entry.status === "active").map(entry => <article key={entry.id} className="rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex flex-wrap justify-between gap-2 text-xs">
            <div className="min-w-0"><p className="font-semibold break-words">{entry.reference} {entry.status === "void" && <span className="text-muted-foreground">· Voided — excluded</span>}</p><p className="mt-1 break-words">{entry.description}</p></div>
            <MoneyPair ht={Number(entry.amountHt)} ttc={Number(entry.amountTtc)} />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">{[entry.companyName, entry.lot && `Lot ${entry.lot}`, entry.completionDate && `Completed ${entry.completionDate}`].filter(Boolean).join(" · ")}</p>
          {entry.voidReason && <p className="mt-1 text-xs">Void reason: {entry.voidReason}</p>}
          {!readOnly && <div className="mt-2 flex gap-2">
            {entry.status === "active" ? <>
              <Button variant="ghost" size="sm" onClick={() => setOperation({ action: "edit", entry })}><Pencil size={12} className="mr-1" />Edit</Button>
              <Button variant="ghost" size="sm" onClick={() => setOperation({ action: "void", entry })}><Ban size={12} className="mr-1" />Void</Button>
            </> : <Button variant="ghost" size="sm" onClick={() => setOperation({ action: "restore", entry })}><RotateCcw size={12} className="mr-1" />Restore</Button>}
          </div>}
        </article>)}
    </div>}
    {operation && <ExternalWorkEditor projectId={projectId} operation={operation} readOnly={readOnly} onClose={() => setOperation(null)} reload={register.refetch} />}
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>External works audit history</DialogTitle><DialogDescription>Changes, actors and timestamps. Voided records remain in the history.</DialogDescription></DialogHeader>
        {register.isLoading ? <Skeleton className="h-20" /> : register.isError ? <div role="alert">History unavailable. <Button variant="outline" onClick={() => void register.refetch()}>Retry</Button></div> : <AuditHistory history={register.data?.history ?? []} entries={entries} />}
      </DialogContent>
    </Dialog>
  </LuxuryCard>;
}
