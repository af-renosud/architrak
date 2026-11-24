import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ReplaceQuotationRequest, ReplacementOptions, ReplacementQuotation } from "@shared/quotation-replacement";
import type { CarryForwardPreview, CarryForwardSelection } from "@shared/quotation-carry-forward";
import { invalidateQuotationReplacement, useQuotationReplacementOptions } from "./use-quotation-replacement";
import { hasCarryWork, invalidateQuotationCarryForward, selectedCarryWork, useQuotationCarryForward } from "./use-quotation-carry-forward";
import { QuotationCarryForwardPanel } from "./QuotationCarryForwardPanel";

const euros = (value: string) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value));

function QuotationSummary({ quotation }: { quotation: ReplacementQuotation }) {
  return (
    <span className="block space-y-1 text-left text-xs">
      <span className="block font-semibold">{quotation.devisCode}{quotation.devisNumber ? ` · N° ${quotation.devisNumber}` : ""}</span>
      <span className="block break-words">{quotation.descriptionFr}</span>
      <span className="block text-muted-foreground">{quotation.contractorName}</span>
      <span className="block tabular-nums">{euros(quotation.amountHt)} HT · {euros(quotation.amountTtc)} TTC</span>
      <span className="block font-medium">{quotation.signed ? "Signed" : "Unsigned — not committed"}</span>
    </span>
  );
}

/** Mounted only while open: options are never fetched for collapsed list rows. */
export function ReplaceQuotationDialog({ devisId, projectId, localBlockedReason, onClose }: {
  devisId: number;
  projectId: string;
  localBlockedReason: string | null;
  onClose: () => void;
}) {
  const options = useQuotationReplacementOptions(devisId);
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [step, setStep] = useState<"selection" | "retain">("selection");
  const carry = useQuotationCarryForward(devisId, selectedId);
  const [review, setReview] = useState<{ options: ReplacementOptions; target: ReplacementQuotation; carryForward?: CarryForwardSelection; carryPreview?: CarryForwardPreview } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const submitting = useRef(false);
  const mutation = useMutation({
    mutationFn: async (request: ReplaceQuotationRequest) => {
      await apiRequest("POST", `/api/devis/${devisId}/mark-replaced`, request);
    },
    onSuccess: (_result, request) => {
      invalidateQuotationCarryForward(projectId, devisId, request.replacementDevisId);
      toast({ title: "Quotation replaced", description: hasCarryWork(request.carryForward)
        ? "Unchanged items retained previous work automatically; additional selected work was carried forward. Existing replacement content was protected. Review the target draft. No signatures, approvals or financial history were transferred."
        : "Unchanged items retained previous work automatically where the replacement had no existing work. No additional copying was requested. Review the target draft; no signatures, approvals or financial history were transferred." });
      onClose();
    },
    onError: async (error: Error) => {
      setReview(null);
      if (error instanceof ApiError && error.status === 409) {
        setSelectedId(null);
        setStep("selection");
        setAcknowledged(false);
        void carry.reload();
        setSaveError("The quotation or previous work changed. Stale copy selections have been cleared. Select the replacement and review the refreshed work again; your internal note has been kept.");
        invalidateQuotationReplacement(projectId);
        await options.refetch();
      } else {
        setSaveError(error.message || "Could not replace the quotation. Please try again.");
      }
    },
    onSettled: () => { submitting.current = false; },
  });
  const data = options.data;
  const selected = data?.candidates.find(candidate => candidate.id === selectedId);
  const blocked = localBlockedReason || data?.blockedReason || data?.source.blockedReason;
  const differentContractor = !!selected && selected.contractorId !== data?.source.contractorId;
  const valid = !!data && !!selected && !blocked && !selected.blockedReason && !!note.trim()
    && note.length <= 2000 && (!differentContractor || acknowledged) && !options.isFetching && !options.isError;
  const candidates = data?.candidates.filter(candidate =>
    `${candidate.devisCode} ${candidate.devisNumber ?? ""} ${candidate.descriptionFr} ${candidate.contractorName}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  ) ?? [];
  const pending = mutation.isPending;
   const carryReady = !!carry.preview.data && !!carry.selection && !carry.preview.data.blockedReason && !carry.preview.isError && !carry.preview.isFetching;
   const reviewCurrent = !!review && review.options === data && !!review.carryPreview &&
     review.carryPreview.version === carry.preview.data?.version && carryReady;

  function submit() {
    if (!review || !valid || submitting.current || pending || !reviewCurrent) return;
    submitting.current = true;
    mutation.mutate({
      replacementDevisId: review.target.id,
      note: note.trim(),
      sourceVersion: review.options.source.version,
      targetVersion: review.target.version,
      impactVersion: review.options.impactVersion,
      differentContractorAcknowledged: differentContractor && acknowledged,
      ...(review.carryForward ? { carryForward: review.carryForward } : {}),
    });
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !submitting.current && !pending) onClose(); }}>
      <DialogContent
        className={`max-h-[90dvh] overflow-y-auto ${step === "retain" ? "sm:max-w-4xl" : "sm:max-w-2xl"} ${pending ? "[&>button]:hidden" : ""}`}
        data-testid={`dialog-mark-replaced-${devisId}`}
        onEscapeKeyDown={event => { if (pending || submitting.current) event.preventDefault(); }}
        onPointerDownOutside={event => { if (pending || submitting.current) event.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>{review ? "Confirm quotation replacement" : step === "retain" ? "Retain previous work" : "Replace quotation"}</DialogTitle>
          <DialogDescription>{review ? "Check the old → new record, automatic retention, additional selections and financial impact." : step === "retain" ? "Unchanged items retain previous work automatically. Review changed items and choose any additional copying." : "Choose a processed quotation in this project. Nothing changes until you confirm."}</DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">1. Selection → 2. Retain previous work → 3. Review → 4. Confirm</p>
        {blocked && <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{blocked}</p>}
        {saveError && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{saveError}</p>}
        {options.isLoading && <div aria-label="Loading replacement options" className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-32 w-full" /></div>}
        {options.isError && <div role="alert" className="space-y-2 text-sm"><p>Replacement options could not be loaded. {options.error.message}</p><Button variant="outline" disabled={options.isFetching} onClick={() => { setReview(null); void options.refetch(); }}>Retry loading options</Button></div>}
        {data && !options.isError && (review ? (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border bg-muted/30 p-3"><p className="mb-2 font-semibold">Old → Replaced</p><QuotationSummary quotation={review.options.source} /></div>
              <div className="rounded-md border border-[#0B2545]/30 p-3"><p className="mb-2 font-semibold">New → Replacement</p><QuotationSummary quotation={review.target} /></div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="font-semibold">Records staying with the old quotation</p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                {([
                  ["Invoices", review.options.impact.invoices], ["Situations", review.options.impact.situations],
                  ["Marché documents", review.options.impact.marcheDocuments], ["Certificates", review.options.impact.certificates],
                  ["Payments", review.options.impact.payments],
                ] as const).map(([label, count]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-semibold tabular-nums">{count}</dd></div>)}
              </dl>
            </div>
            <p>Prior signatures, documents and payments remain on the old record. There is no financial transfer. The old quotation no longer counts toward Contracted totals; a new unsigned quotation is not committed.</p>
            {differentContractor && <p className="font-semibold text-amber-800">Different contractor acknowledged: {review.options.source.contractorName} → {review.target.contractorName}.</p>}
            <div><p className="font-semibold">Internal context</p><p className="mt-1 whitespace-pre-wrap break-words">{note.trim()}</p></div>
            {review.carryPreview && <QuotationCarryForwardPanel preview={review.carryPreview} selection={review.carryForward ?? {
              version: review.carryPreview.version, setup: [], header: false, supportingPdfIds: [], lines: [],
            }} onChange={() => {}} readOnly />}
          </div>
        ) : step === "retain" ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-md border p-3"><p className="mb-2 text-xs font-semibold">Original</p><QuotationSummary quotation={data.source} /></div>{selected && <div className="rounded-md border p-3"><p className="mb-2 text-xs font-semibold">Replacement</p><QuotationSummary quotation={selected} /></div>}</div>
            {carry.preview.isFetching && <div aria-label="Loading previous work" className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-48 w-full" /></div>}
            {carry.preview.isError && <div role="alert" className="space-y-2 rounded-md border border-destructive/30 p-3 text-sm"><p>Previous work could not be loaded. {carry.preview.error.message}</p><p>Reload the preview to review automatic retention and any additional selections. Nothing has changed.</p><Button variant="outline" disabled={carry.preview.isFetching} onClick={() => { void carry.reload(); }}>Retry loading previous work</Button></div>}
            {!carry.preview.isFetching && !carry.preview.isError && carry.preview.data && carry.selection && <QuotationCarryForwardPanel preview={carry.preview.data} selection={carry.selection} onChange={carry.setSelection} />}
            {carry.preview.data?.blockedReason && <Button variant="outline" disabled={carry.preview.isFetching} onClick={() => { void carry.reload(); }}>Refresh previous work</Button>}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3"><p className="mb-2 text-xs font-semibold">Quotation being replaced</p><QuotationSummary quotation={data.source} /></div>
            {!data.candidates.length ? (
              <div className="rounded-md border border-dashed p-4 text-sm" data-testid="replacement-empty">
                <p className="font-semibold">No processed replacement quotation available</p>
                <p className="mt-1 text-muted-foreground">Upload and process the revised PDF in this project first, then return here to replace this quotation.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p id={`replacement-label-${devisId}`} className="text-sm font-semibold">Replacement quotation</p>
                <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" role="combobox" aria-expanded={pickerOpen} aria-labelledby={`replacement-label-${devisId}`} disabled={!!blocked || options.isFetching} className="h-auto min-h-10 w-full justify-between whitespace-normal py-3" data-testid="replacement-select">
                      {selected ? <QuotationSummary quotation={selected} /> : "Search processed quotations…"}<ChevronDown size={15} className="ml-2 shrink-0" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[min(36rem,calc(100vw-3rem))] p-2" align="start">
                    <Input aria-label="Search processed quotations" placeholder="Reference, title or contractor…" value={search} onChange={event => setSearch(event.target.value)} />
                    <div role="listbox" aria-label="Processed quotations" className="mt-2 max-h-64 overflow-y-auto">
                      {!candidates.length && <p className="p-3 text-sm text-muted-foreground">No quotations match your search.</p>}
                      {candidates.map(candidate => (
                        <button type="button" role="option" aria-selected={selectedId === candidate.id} key={candidate.id} disabled={!!candidate.blockedReason}
                          className="w-full rounded-md border-b p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60"
                           onClick={() => { setSelectedId(candidate.id); setAcknowledged(false); setPickerOpen(false); setSaveError(null); }}>
                          <QuotationSummary quotation={candidate} />
                          {candidate.blockedReason && <span className="mt-1 block text-xs text-destructive">{candidate.blockedReason}</span>}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            )}
            {differentContractor && <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /> <span>I acknowledge that the replacement is from a different contractor: {data.source.contractorName} → {selected?.contractorName}.</span></label>}
            <div className="space-y-1">
              <label htmlFor={`replacement-note-${devisId}`} className="text-sm font-semibold">Internal context (required)</label>
              <Textarea id={`replacement-note-${devisId}`} required maxLength={2000} rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="Why is this quotation being replaced? Record the revision and any decisions for the project team." aria-describedby={`replacement-note-help-${devisId}`} />
              <p id={`replacement-note-help-${devisId}`} className="text-xs text-muted-foreground">Saved in replacement history for the project team. {note.length}/2000 characters.</p>
            </div>
          </div>
        ))}
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={pending} onClick={() => { if (!submitting.current) onClose(); }}>Cancel</Button>
          {review ? <>
            <Button variant="outline" disabled={pending} onClick={() => setReview(null)}>Back to previous work</Button>
            <Button disabled={!valid || pending || !reviewCurrent} onClick={submit} data-testid="button-confirm-mark-replaced">{pending ? "Replacing quotation…" : "Confirm replacement"}</Button>
          </> : step === "retain" ? <>
            <Button variant="outline" disabled={pending} onClick={() => setStep("selection")}>Back to selection</Button>
            <Button disabled={!valid || pending || !carryReady} onClick={() => {
              if (!data || !selected || !valid || !carryReady) return;
              const work = carry.selection && hasCarryWork(carry.selection) ? selectedCarryWork(carry.selection) : undefined;
              setReview({ options: data, target: selected, carryForward: work, carryPreview: carry.preview.data });
            }} data-testid="button-review-replacement">Review replacement</Button>
          </> : <Button disabled={!valid || pending} onClick={() => { if (valid) setStep("retain"); }} data-testid="button-retain-previous-work">Continue to previous work</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
