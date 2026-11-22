import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import type { ArchitectCorrectionDraft } from "./architect-correction-model";

export interface RecoveredContent {
  attemptId: number;
  sourceDigest: string;
  expectedVersion: string;
  headerFr: string;
  lines: Array<{ index: number; descriptionFr: string; quantity: string | number | null; unit: string | null; unitPriceHt: string | number | null; totalHt: string | number | null }>;
}

export function RecoveredWordingComparison({ devisId, draft, version, disabled, onIncorporate }: {
  devisId: number; draft: ArchitectCorrectionDraft; version: string; disabled: boolean;
  onIncorporate: (candidate: RecoveredContent, wording: string, target: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [version]);
  const recovery = useQuery<{ candidate: RecoveredContent | null }>({
    queryKey: ["/api/devis", devisId, "architect-correction", "recovered-content", version],
    enabled: open,
    queryFn: async () => (await apiRequest("GET", `/api/devis/${devisId}/architect-correction/recovered-content`)).json(),
    retry: false,
  });
  const candidate = recovery.data?.candidate;
  const sourceLine = candidate?.lines.find((_, index) => source === `line:${index}`);
  const wording = source === "header" ? candidate?.headerFr ?? "" : sourceLine?.descriptionFr ?? "";
  const targetLine = draft.lines.find(line => target === `row:${line.clientKey}`);
  const currentWording = target === "header" ? draft.headerFr : targetLine?.descriptionFr ?? "";
  const validTarget = target === "header" || target === "new-context" || !!targetLine;
  const mismatched = !!candidate && candidate.expectedVersion !== version;
  return <section className="rounded-lg border border-[#c1a27b]/40 p-3 space-y-3 text-xs" aria-label="Recovered wording comparison">
    <Button type="button" size="sm" variant="outline" aria-expanded={open} aria-controls={`${id}-comparison`}
      onClick={() => setOpen(value => !value)}>{open ? "Hide recovered content comparison" : "Compare recovered content (optional)"}</Button>
    {open && <div id={`${id}-comparison`} className="space-y-3">
      <p>Recover French wording without replacing your working quotation. English, explanations, images, row identities and financial values stay unchanged. Manual figure editing still requires reconciliation with the original source total.</p>
      {recovery.isLoading ? <Skeleton className="h-24 w-full" aria-label="Loading recovered wording" /> :
        recovery.isError ? <div role="alert"><p>Recovered content could not be loaded. Your draft is unchanged.</p><Button type="button" size="sm" variant="outline" onClick={() => void recovery.refetch()}>Retry recovered content</Button></div> :
        !candidate ? <p className="rounded-md border border-dashed p-3">No recovered candidate is available. You can still draft wording in the header or a context-only row.</p> : <>
          {mismatched && <div role="alert" className="space-y-2"><p>The candidate belongs to a different working version. No wording can be copied. Refresh the comparison; your draft stays here.</p><Button type="button" size="sm" variant="outline" disabled={recovery.isFetching} onClick={() => { setSource(""); setCopied(false); void recovery.refetch(); }}>Refresh comparison</Button></div>}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor={`${id}-source`} className="font-semibold">Recovered source passage</label>
              <select id={`${id}-source`} className="w-full rounded-md border bg-background p-2" value={source} onChange={event => { setSource(event.target.value); setCopied(false); }}>
                <option value="">Choose recovered source…</option>
                <option value="header">Recovered French header</option>
                {candidate.lines.map((line, index) => <option key={index} value={`line:${index}`}>Source row {line.index + 1} · {line.descriptionFr.slice(0, 65)}</option>)}
              </select>
              <p className="whitespace-pre-wrap break-words rounded-md border p-3">{wording || "Select a source passage to preview its French wording."}</p>
              {sourceLine && <p className="text-muted-foreground">Comparison only · Quantity: {sourceLine.quantity ?? "unavailable"} · Unit: {sourceLine.unit || "unavailable"} · Unit price HT: {sourceLine.unitPriceHt ?? "unavailable"} · Total HT: {sourceLine.totalHt ?? "unavailable"}. These values will not be copied.</p>}
            </div>
            <div className="space-y-2">
              <label htmlFor={`${id}-target`} className="font-semibold">Current target</label>
              <select id={`${id}-target`} className="w-full rounded-md border bg-background p-2" value={target} onChange={event => { setTarget(event.target.value); setCopied(false); }}>
                <option value="">Choose current target…</option>
                <option value="header">Current French header</option>
                {draft.lines.map((line, index) => <option key={line.clientKey} value={`row:${line.clientKey}`}>Current row {index + 1} · {line.descriptionFr.slice(0, 65) || "Untitled context"}</option>)}
                <option value="new-context">Add a new context-only row (no charge)</option>
              </select>
              <p className="whitespace-pre-wrap break-words rounded-md border p-3">{!validTarget ? "Select a target to preview its current French wording." : target === "new-context" ? "A genuine context-only row will be added, with no priced item." : currentWording || "This target has no French wording yet."}</p>
              {targetLine?.kind === "priced" && <p className="text-muted-foreground">Current quantity: {targetLine.quantity || "unavailable"} · Unit price HT: {targetLine.unitPriceHt || "unavailable"} · Total HT: {targetLine.totalHt || "unavailable"}. All figures stay in place.</p>}
            </div>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={disabled || mismatched || recovery.isFetching || recovery.isError || !wording.trim() || !validTarget}
            onClick={() => { if (!disabled && !mismatched && validTarget && wording.trim()) { onIncorporate(candidate, wording, target); setCopied(true); } }}>
            {target === "new-context" ? "Add French wording as context only" : "Append French wording to selected target"}
          </Button>
          {copied && <p role="status">French wording added to your unsaved draft. Review it, then use Save correction. No recovered financial values were copied.</p>}
        </>}
    </div>}
  </section>;
}
