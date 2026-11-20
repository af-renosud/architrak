import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ClientBudgetCandidate, ClientBudgetEntry, ClientBudgetSave, ClientBudgetState } from "@shared/client-budget";
import { ApiError, apiRequest, queryClient } from "@/lib/queryClient";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

type DraftRow = { included: boolean; title: string; refresh: boolean };
type Draft = Record<number, DraftRow>;
type Focus = { devisId: number; included: boolean };

function initialDraft(state: ClientBudgetState, focus?: Focus): Draft {
  return Object.fromEntries(state.candidates.map((candidate) => {
    const included = focus?.devisId === candidate.devisId ? focus.included : !!candidate.shared;
    return [candidate.devisId, {
      included,
      title: (candidate.shared ?? candidate.current)?.title ?? "",
      refresh: included && !candidate.shared,
    }];
  }));
}

function chosenEntry(candidate: ClientBudgetCandidate, row: DraftRow): ClientBudgetEntry | null {
  if (candidate.signed) return candidate.current;
  return row.refresh ? candidate.current : candidate.shared ?? candidate.current;
}

function Amounts({ ht, ttc }: { ht: number | string; ttc: number | string }) {
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
      <Amount value={Number(ht)} denomination="HT" />
      <Amount value={Number(ttc)} denomination="TTC" className="font-semibold" />
    </span>
  );
}

function auditEntries(value: unknown): ClientBudgetEntry[] {
  const rows = Array.isArray(value) ? value
    : value && typeof value === "object" && "entries" in value ? value.entries : null;
  if (!Array.isArray(rows)) throw new Error("Missing budget audit entries");
  return rows.map((row: unknown) => {
    if (!row || typeof row !== "object"
      || !("devisId" in row) || typeof row.devisId !== "number"
      || !("title" in row) || typeof row.title !== "string"
      || !("amountHt" in row) || !Number.isFinite(Number(row.amountHt))
      || !("amountTtc" in row) || !Number.isFinite(Number(row.amountTtc))) {
      throw new Error("Invalid budget audit entry");
    }
    return {
      devisId: row.devisId, title: row.title,
      amountHt: String(row.amountHt), amountTtc: String(row.amountTtc),
      reference: "reference" in row ? String(row.reference ?? "") : "",
      contractor: "contractor" in row ? String(row.contractor ?? "") : "",
    };
  });
}

/** Audit details are deliberately human-readable; never expose raw JSON. */
export function ClientBudgetAuditDetail({ detail }: { detail: string }) {
  let before: ClientBudgetEntry[];
  let after: ClientBudgetEntry[];
  let reviewed = false;
  try {
    const parsed = JSON.parse(detail);
    before = auditEntries(parsed.before);
    after = auditEntries(parsed.after);
    reviewed = parsed.alternativesReviewed === true;
  } catch {
    return <span>Client budget updated. Change details are unavailable.</span>;
  }
  const previous = new Map(before.map((entry) => [entry.devisId, entry]));
  const next = new Map(after.map((entry) => [entry.devisId, entry]));
  const changes = Array.from(new Set([...Array.from(previous.keys()), ...Array.from(next.keys())])).filter((id) => JSON.stringify(previous.get(id)) !== JSON.stringify(next.get(id)));
  return (
    <details className="min-w-0 flex-1">
      <summary className="cursor-pointer">Client budget updated · {after.length} selected · {changes.length} changed</summary>
      <div className="mt-2 space-y-2 rounded-md border border-[#c1a27b]/30 bg-[#c1a27b]/5 p-2">
        {changes.length === 0 && <p>No quotation title or amount changes.</p>}
        {changes.map((id) => (
          <div key={id} className="space-y-1 break-words border-b border-border/40 pb-2 last:border-0 last:pb-0">
            <p className="font-semibold">{!previous.has(id) ? "Added" : !next.has(id) ? "Removed" : "Updated"} · {next.get(id)?.title ?? previous.get(id)?.title}</p>
            {(["Before", "After"] as const).map((label) => {
              const entry = label === "Before" ? previous.get(id) : next.get(id);
              return entry ? <div key={label}><p className="text-muted-foreground">{label}: {entry.title} · {entry.contractor} · Ref: {entry.reference || "—"}</p><Amounts ht={entry.amountHt} ttc={entry.amountTtc} /></div> : null;
            })}
          </div>
        ))}
        <p className="text-muted-foreground">{reviewed ? "Preferred alternatives reviewed before saving." : "Alternatives review not recorded."}</p>
      </div>
    </details>
  );
}

/**
 * Both entry points use the same editor and project-scoped query. A row click
 * only stages a choice; it never writes to the server or publishes a devis.
 */
export function ClientBudgetControls({
  projectId,
  devisId,
  isArchived = false,
}: {
  projectId: string;
  devisId?: number;
  isArchived?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<Focus>();
  const [session, setSession] = useState(0);
  const closeGuard = useRef<() => boolean>(() => true);
  const { data, isLoading, isError, refetch, isFetching } = useQuery<ClientBudgetState>({
    queryKey: ["/api/projects", String(projectId), "client-budget"],
    queryFn: async () => (await apiRequest("GET", `/api/projects/${projectId}/client-budget`)).json(),
  });
  const candidate = data?.candidates.find((row) => row.devisId === devisId);
  const readOnly = isArchived || !!data?.readOnly;
  const blocked = !!candidate?.excluded || !!candidate?.blockedReason || !candidate?.current;
  const start = (nextFocus?: Focus) => {
    closeGuard.current = () => true;
    setFocus(nextFocus);
    setSession((value) => value + 1);
    setOpen(true);
  };
  const requestClose = () => {
    if (closeGuard.current()) setOpen(false);
  };

  return (
    <div className={devisId == null ? "rounded-xl border border-[#c1a27b]/30 bg-[#c1a27b]/5 p-3" : "min-w-0"} onClick={(event) => event.stopPropagation()}>
      {devisId == null ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[12px] font-semibold text-[#0B2545]">Client budget</p>
            <p className="text-[11px] text-muted-foreground">Share chosen costs, without publishing the quotation or its context.</p>
          </div>
          <Button type="button" variant="outline" size="sm" className="h-8 text-[11px]" onClick={() => start()} data-testid="manage-client-budget">
            Manage client budget
          </Button>
        </div>
      ) : isLoading ? (
        <Skeleton className="h-5 w-44" />
      ) : !candidate ? (
        <Button type="button" variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => start()}>
          {isError ? "Client budget unavailable · retry" : "View client budget"}
        </Button>
      ) : (
        <div className="space-y-1 text-[11px]">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!candidate.shared}
              disabled={readOnly || (blocked && !candidate.shared)}
              onChange={(event) => start({ devisId, included: event.target.checked })}
              className="h-4 w-4 shrink-0 accent-[#0B2545]"
              aria-describedby={`client-budget-note-${devisId}`}
              data-testid={`include-client-budget-${devisId}`}
            />
            Include in client budget
          </label>
          <p id={`client-budget-note-${devisId}`} className={`max-w-sm text-[10px] ${candidate.shared && blocked ? "text-amber-800" : "text-muted-foreground"}`}>
            {readOnly ? "Read-only budget." : candidate.excluded ? "Inactive quotation — excluded from the client budget. A saved entry can be removed." : blocked ? `${candidate.blockedReason ?? "Current amounts unavailable."}${candidate.shared && !candidate.signed ? " Saved valid amounts remain shared; you can retain or remove them." : ""}` : candidate.shared ? `${candidate.signed ? "Signed amounts are live." : "Saved budget amounts."} Detailed publication is separate.` : "Costs only. Review and confirm before sharing."}
          </p>
          {candidate.shared && (
            <button type="button" className="text-[10px] underline underline-offset-2" onClick={() => start({ devisId, included: true })}>
              {readOnly ? "View client budget" : "Review client budget"}
            </button>
          )}
        </div>
      )}
      <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
        <DialogContent className="flex max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-2xl flex-col overflow-y-auto p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-[#0B2545]">Manage client budget</DialogTitle>
            <DialogDescription className="text-xs">
              Choose the costs your client can see. Only the English title, contractor, reference and HT/TTC amounts are shared here.
              Full quotations, PDFs and context are not published by this selection. Existing detailed publication stays independent.
            </DialogDescription>
          </DialogHeader>
          {isLoading || (!data && isFetching) ? (
            <div className="space-y-3" aria-label="Loading client budget"><Skeleton className="h-20 w-full" /><Skeleton className="h-32 w-full" /></div>
          ) : !data ? (
            <div role="alert" className="space-y-3 rounded-lg border p-4 text-xs">
              <p>The client budget could not be loaded. No changes have been saved.</p>
              <Button type="button" variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>Retry loading</Button>
            </div>
          ) : (
            <>
            {isError && <div role="alert" className="space-y-2 rounded-lg border border-amber-300 p-3 text-xs"><p>The latest budget could not be loaded. Your existing draft is retained; saving still checks for changes on the server.</p><Button type="button" size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>Retry loading</Button></div>}
            <ClientBudgetEditor
              key={`${projectId}-${session}`}
              projectId={projectId}
              initialState={data}
              focus={focus}
              readOnly={readOnly}
              closeGuard={closeGuard}
              onClose={requestClose}
              onSaved={() => setOpen(false)}
            />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ClientBudgetEditor({
  projectId, initialState, focus, readOnly, closeGuard, onClose, onSaved,
}: {
  projectId: string;
  initialState: ClientBudgetState;
  focus?: Focus;
  readOnly: boolean;
  closeGuard: MutableRefObject<() => boolean>;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Deliberately local: query updates cannot overwrite an in-progress draft,
  // nor advance the version token used to protect that draft.
  const [snapshot, setSnapshot] = useState(initialState);
  const [draft, setDraft] = useState(() => initialDraft(initialState, focus));
  const [review, setReview] = useState(false);
  const [alternativesReviewed, setAlternativesReviewed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const [reloading, setReloading] = useState(false);
  const focusedRow = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const locked = readOnly || snapshot.readOnly;

  useEffect(() => {
    focusedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const save = useMutation({
    mutationFn: async (payload: ClientBudgetSave): Promise<ClientBudgetState> => {
      return (await apiRequest("PUT", `/api/projects/${projectId}/client-budget`, payload)).json();
    },
    onSuccess: (state) => {
      queryClient.setQueryData(["/api/projects", String(projectId), "client-budget"], state);
      void queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "client-share", "audit"] });
      toast({ title: "Client budget saved", description: "Detailed quotation publication has not changed." });
      onSaved();
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
    },
  });
  const busy = save.isPending || reloading;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft(snapshot));
  closeGuard.current = () => !busy && (!dirty || window.confirm("Discard your unsaved client budget changes?"));
  const update = (id: number, patch: Partial<DraftRow>) => {
    setDraft((previous) => ({ ...previous, [id]: { ...previous[id], ...patch } }));
    setAlternativesReviewed(false);
    save.reset();
  };
  const selected = snapshot.candidates.filter((candidate) => draft[candidate.devisId].included);
  const removed = snapshot.candidates.filter((candidate) => candidate.shared && !draft[candidate.devisId].included);
  const activeUnsigned = selected.filter((candidate) => !candidate.signed && !candidate.excluded);
  const unsigned = activeUnsigned.reduce((total, candidate) => {
    const entry = chosenEntry(candidate, draft[candidate.devisId]);
    return { ht: total.ht + Number(entry?.amountHt ?? 0), ttc: total.ttc + Number(entry?.amountTtc ?? 0) };
  }, { ht: 0, ttc: 0 });
  const invalid = selected.some((candidate) => !draft[candidate.devisId].title.trim()
    || (!candidate.shared && (candidate.excluded || !!candidate.blockedReason || !candidate.current)));
  const reload = async () => {
    if (!window.confirm("Reload the latest budget and discard your staged changes? Your draft will remain here if loading fails.")) return;
    setReloading(true);
    setReloadError("");
    try {
      const fresh: ClientBudgetState = await (await apiRequest("GET", `/api/projects/${projectId}/client-budget`)).json();
      queryClient.setQueryData(["/api/projects", String(projectId), "client-budget"], fresh);
      setSnapshot(fresh);
      setDraft(initialDraft(fresh));
      setConflict(false);
      setReview(false);
      setAlternativesReviewed(false);
      save.reset();
    } catch (error) {
      setReloadError(error instanceof Error ? error.message : "Unable to reload. Please try again.");
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="space-y-4 text-xs">
      {locked && <p role="status" className="rounded-lg border bg-muted/30 p-3">This project’s client budget is read-only. No changes can be saved.</p>}
      <section className="space-y-2 rounded-lg border border-[#c1a27b]/30 bg-[#c1a27b]/5 p-3" aria-label="Client budget total preview">
        <div className="flex flex-wrap justify-between gap-1"><span className="text-muted-foreground">Signed commitments</span><Amounts ht={snapshot.signedHt} ttc={snapshot.signedTtc} /></div>
        <div className="flex flex-wrap justify-between gap-1"><span className="text-muted-foreground">Selected unsigned quotations</span><Amounts ht={unsigned.ht} ttc={unsigned.ttc} /></div>
        <div className="flex flex-wrap justify-between gap-1 border-t border-[#c1a27b]/30 pt-2 font-semibold text-[#0B2545]"><span>Preview total</span><Amounts ht={snapshot.signedHt + unsigned.ht} ttc={snapshot.signedTtc + unsigned.ttc} /></div>
        <p className="text-[10px] text-muted-foreground">Signed quotations use live authoritative amounts and count only in signed commitments, never twice. Lifecycle-inactive entries are excluded; valid saved unsigned amounts remain shared if current amounts need correction. HT excludes VAT; TTC includes VAT.</p>
      </section>

      {conflict && (
        <div role="alert" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-950">
          <p className="font-semibold">The budget or quotation data changed elsewhere.</p>
          <p>Your draft has been retained and was not saved. Reload the latest budget before reviewing and saving again. Reloading will discard your staged changes.</p>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void reload()}>{reloading ? "Reloading…" : "Reload latest budget"}</Button>
          {reloadError && <p>{reloadError}</p>}
        </div>
      )}
      {save.isError && !conflict && <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-destructive">Could not save the budget. Your draft is retained. {save.error.message} Please try again.</p>}

      {review ? (
        <section className="space-y-3" aria-label="Confirm client budget">
          <h3 className="font-semibold text-[#0B2545]">Confirm what your client will see</h3>
          <p className="text-muted-foreground">These are the exact selected titles and amounts. Unsigned amounts stay frozen unless you explicitly chose current amounts. Signed amounts are live; their public English title stays as saved.</p>
          {selected.length === 0 && <p className="rounded-lg border border-dashed p-4">No quotations selected. The unsigned client budget will be empty.</p>}
          {selected.map((candidate) => {
            const row = draft[candidate.devisId];
            const entry = chosenEntry(candidate, row);
            return (
              <div key={candidate.devisId} className="space-y-1 break-words rounded-lg border p-3">
                <p className="font-semibold">{row.title.trim()}</p>
                <p>{entry?.contractor || "No contractor"} · Ref: {entry?.reference || "—"}</p>
                {entry && <Amounts ht={entry.amountHt} ttc={entry.amountTtc} />}
                <p className="text-[10px] text-muted-foreground">{candidate.excluded ? "Inactive — excluded from the client budget" : candidate.signed ? "Signed — live amounts, already counted in signed commitments" : "Under consideration"}</p>
                {!candidate.excluded && candidate.blockedReason && <p className="text-[10px] text-amber-800">{candidate.blockedReason}{!candidate.signed && candidate.shared ? " Saved valid amounts remain shared." : ""}</p>}
                {row.refresh && !candidate.signed && <p className="text-[10px] text-muted-foreground">Current amounts will be shared on confirmation.</p>}
              </div>
            );
          })}
          {removed.length > 0 && <div className="rounded-lg border border-dashed p-3"><p className="font-semibold">Remove from client budget</p><ul className="mt-1 list-inside list-disc">{removed.map((candidate) => <li key={candidate.devisId}>{candidate.shared?.title} · {candidate.shared?.contractor} · Ref: {candidate.shared?.reference}</li>)}</ul></div>}
          <label className="flex items-start gap-2 rounded-lg border border-[#c1a27b]/40 bg-[#c1a27b]/5 p-3">
            <input type="checkbox" checked={alternativesReviewed} disabled={locked || busy || conflict} onChange={(event) => setAlternativesReviewed(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#0B2545]" />
            <span><strong>I have reviewed alternatives.</strong> Only the preferred option for the same work is included. Competing quotations are alternatives, not additional costs; do not add both to the budget.</span>
          </label>
        </section>
      ) : (
        <details open={focus != null || undefined} className="rounded-lg border" key={snapshot.version}>
          <summary className="cursor-pointer px-3 py-3 font-semibold text-[#0B2545]">Quotation breakdown · {selected.length} selected</summary>
          <div className="space-y-3 border-t p-3">
            <p className="text-[11px] text-muted-foreground">Select only the preferred quotation for each scope of work. Competing options must not be added together.</p>
            {snapshot.candidates.length === 0 && <div className="rounded-lg border border-dashed p-5 text-center"><p className="font-semibold">No quotations available yet</p><p className="mt-1 text-muted-foreground">Add and review a quotation before choosing costs to share.</p></div>}
            {snapshot.candidates.map((candidate) => {
              const row = draft[candidate.devisId];
              const entry = chosenEntry(candidate, row);
              const blocked = candidate.excluded || !!candidate.blockedReason || !candidate.current;
              const disabled = locked || busy || conflict;
              return (
                <div key={candidate.devisId} ref={candidate.devisId === focus?.devisId ? focusedRow : undefined} className={`space-y-2 rounded-lg border p-3 ${candidate.devisId === focus?.devisId ? "border-[#c1a27b] bg-[#c1a27b]/5" : ""}`}>
                  <label className="flex items-start gap-2 font-semibold">
                    <input type="checkbox" checked={row.included} disabled={disabled || (blocked && !row.included)} onChange={(event) => update(candidate.devisId, { included: event.target.checked, refresh: event.target.checked && !candidate.shared ? true : row.refresh })} className="mt-0.5 h-4 w-4 shrink-0 accent-[#0B2545]" />
                    <span className="min-w-0 break-words">{(candidate.shared ?? candidate.current)?.title || `Quotation ${candidate.devisId}`} <span className="font-normal text-muted-foreground">· {candidate.signed ? "Signed" : "Unsigned"}</span></span>
                  </label>
                  <p className="break-words text-muted-foreground">{entry?.contractor || "No contractor"} · Ref: {entry?.reference || "—"}</p>
                  {entry && <Amounts ht={entry.amountHt} ttc={entry.amountTtc} />}
                  {blocked && <p className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">{candidate.blockedReason ?? "Current quotation amounts are unavailable."} {candidate.excluded ? "Lifecycle-inactive quotation — excluded from the client budget. A saved entry can be removed." : candidate.shared && !candidate.signed ? "Saved valid amounts remain shared. Retain or remove them; current amounts cannot be used until corrected." : "Current amounts cannot be included or refreshed until resolved."}</p>}
                  {row.included && (
                    <>
                      <label className="block space-y-1">
                        <span className="text-[11px] font-medium">Public English title <span className="text-muted-foreground">(required)</span></span>
                        <Input value={row.title} required maxLength={500} disabled={disabled || blocked} aria-invalid={!row.title.trim()} onChange={(event) => update(candidate.devisId, { title: event.target.value })} className="h-8 text-xs" />
                      </label>
                      {!row.title.trim() && <p className="text-[11px] text-destructive">Enter an English title before saving.</p>}
                      {candidate.signed && <p className="text-[11px] text-muted-foreground">Signed amounts are live authoritative amounts, not a frozen snapshot. The public English title is saved separately.</p>}
                      {candidate.shared && !blocked && !candidate.signed && (
                        <div className="space-y-2 text-[11px]">
                          <p className="text-muted-foreground">{row.refresh ? "Using current quotation amounts." : "Using saved client budget amounts."}{candidate.changed ? " The quotation has changed since it was shared." : ""}</p>
                          {candidate.changed && !row.refresh && <div className="rounded border border-dashed p-2"><p className="mb-1 text-muted-foreground">Current quotation · {candidate.current?.contractor} · Ref: {candidate.current?.reference}</p><Amounts ht={candidate.current!.amountHt} ttc={candidate.current!.amountTtc} /></div>}
                          {(candidate.changed || row.refresh) && <Button type="button" variant="outline" size="sm" className="h-auto min-h-7 whitespace-normal py-1 text-[11px]" disabled={disabled} onClick={() => update(candidate.devisId, { refresh: !row.refresh })}>{row.refresh ? "Keep saved amounts instead" : "Update client budget to current amounts"}</Button>}
                        </div>
                      )}
                      {!candidate.shared && !candidate.signed && <p className="text-[10px] text-muted-foreground">New inclusion · current amounts will be shared after confirmation.</p>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>{locked ? "Done" : "Cancel"}</Button>
        {review && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setReview(false); setAlternativesReviewed(false); }}>Back to selection</Button>}
        {!locked && (review ? (
          <Button type="button" size="sm" disabled={busy || conflict || invalid || !alternativesReviewed} onClick={() => save.mutate({
            version: snapshot.version,
            entries: selected.map((candidate) => ({ devisId: candidate.devisId, title: draft[candidate.devisId].title.trim(), refresh: draft[candidate.devisId].refresh })),
            alternativesReviewed: true,
          })}>{save.isPending ? "Saving…" : "Confirm and save client budget"}</Button>
        ) : <Button type="button" size="sm" disabled={busy || conflict || invalid} onClick={() => setReview(true)}>Review changes</Button>)}
      </div>
    </div>
  );
}
