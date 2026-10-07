import { useId, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { BulkDocumentsSelection } from "@/hooks/use-bulk-documents";

export function BulkDocumentCheckbox({ selection, id, name, eligible, disabled = false }: {
  selection: BulkDocumentsSelection; id: number; name: string; eligible: boolean; disabled?: boolean;
}) {
  return <span className="inline-flex shrink-0 items-center justify-center min-h-9 min-w-9" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <Checkbox aria-label={`Select ${name}`} checked={selection.ids.has(id)} disabled={!eligible || disabled || selection.pending}
      onCheckedChange={(checked) => selection.toggle(id, checked === true)} data-testid={`checkbox-bulk-document-${id}`} />
  </span>;
}

/** Uses the host application's navy/brass, technical-label visual language. */
export function BulkDocumentActions({ selection, action, description, eligibilityHint, requireReason = false, disabled = false }: {
  selection: BulkDocumentsSelection; action: string; description: string; eligibilityHint: string; requireReason?: boolean; disabled?: boolean;
}) {
  const [reason, setReason] = useState("");
  const reasonId = useId();
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2" aria-label={`${action} document selection`}>
      <div className="min-w-0">
        <label className="flex min-h-9 items-center gap-2 text-xs font-medium">
          <Checkbox aria-label="Select all eligible documents shown" checked={selection.allChecked} disabled={disabled || selection.pending || !selection.eligibleCount}
            onCheckedChange={(checked) => selection.selectAll(checked === true)} />
          Select all shown ({selection.eligibleCount} eligible)
        </label>
        <p className="text-[10px] text-muted-foreground">{eligibilityHint}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums" role="status">{selection.ids.size} selected</span>
        {selection.ids.size > 0 && <Button type="button" variant="ghost" size="sm" disabled={selection.pending} onClick={selection.clear}>Clear</Button>}
        <Button type="button" variant="destructive" size="sm" disabled={disabled || selection.pending || !selection.ids.size}
          onClick={() => { setReason(""); selection.openConfirmation(); }}>{selection.pending ? "Processing…" : `${action} selected`}</Button>
      </div>
    </div>
    {selection.result && <div role={selection.result.failures.length ? "alert" : "status"} className="rounded-lg border border-border p-3 text-xs">
      <p className="font-semibold">{selection.result.succeeded} completed · {selection.result.failures.length} failed</p>
      {selection.result.failures.length > 0 && <><p className="mt-1 text-muted-foreground">Failed documents remain selected while visible and eligible. Review each error before retrying.</p>
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-destructive">{selection.result.failures.map((failure) => <li key={failure.id} className="break-words"><strong>{failure.name}:</strong> {failure.message}</li>)}</ul></>}
    </div>}
    {selection.refreshError && <p role="alert" className="text-xs text-destructive">Documents were processed, but refreshing failed: {selection.refreshError}</p>}
    <AlertDialog open={selection.confirmationOpen} onOpenChange={(open) => { if (!open) selection.closeConfirmation(); }}>
      <AlertDialogContent className="max-h-[85dvh] overflow-y-auto" data-testid="dialog-bulk-documents">
        <AlertDialogHeader>
          <AlertDialogTitle>{action} {selection.confirmationItems.length} document{selection.confirmationItems.length === 1 ? "" : "s"}?</AlertDialogTitle>
          <AlertDialogDescription>{description} Each document is checked by the server; protected documents will not be changed.</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-xs" aria-label="Documents to process">
          {selection.confirmationItems.map((item) => <li className="break-words" key={item.id}>{item.name}</li>)}
        </ul>
        {requireReason && <div className="space-y-2"><label htmlFor={reasonId} className="text-xs font-semibold">Reason for voiding (required for every selected quotation)</label>
          <Textarea id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)} disabled={selection.pending} required /></div>}
        <AlertDialogFooter>
          <Button type="button" variant="outline" disabled={selection.pending} onClick={selection.closeConfirmation}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={disabled || selection.pending || !selection.confirmationItems.length || (requireReason && !reason.trim())}
            onClick={() => void selection.confirm(reason)}>{selection.pending ? "Processing…" : `${action} ${selection.confirmationItems.length} document${selection.confirmationItems.length === 1 ? "" : "s"}`}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
