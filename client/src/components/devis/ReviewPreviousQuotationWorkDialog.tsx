import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { CarryForwardSelection } from "@shared/quotation-carry-forward";
import { QuotationCarryForwardPanel } from "./QuotationCarryForwardPanel";
import { hasCarryWork, invalidateQuotationCarryForward, selectedCarryWork, useQuotationCarryForward } from "./use-quotation-carry-forward";

export function ReviewPreviousQuotationWorkDialog({ sourceId, targetId, sourceLabel, targetLabel, projectId, onClose }: {
  sourceId: number; targetId: number; sourceLabel: string; targetLabel: string; projectId: string; onClose: () => void;
}) {
  const carry = useQuotationCarryForward(sourceId, targetId);
  const { toast } = useToast();
  const [review, setReview] = useState<CarryForwardSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const mutation = useMutation({
    mutationFn: async (selection: CarryForwardSelection) => {
      await apiRequest("POST", `/api/devis/${sourceId}/carry-forward`, { targetId, selection });
    },
    onSuccess: () => {
      invalidateQuotationCarryForward(projectId, sourceId, targetId);
      toast({ title: "Previous work carried forward", description: "Selected work was copied. Review the replacement draft before approval or signature. Unassigned content remains on the original." });
      onClose();
    },
    onError: async (failure: Error) => {
      setReview(null);
      if (failure instanceof ApiError && failure.status === 409) {
        setError("The quotations changed. Stale selections were cleared. Review the refreshed previous work before trying again.");
        await carry.reload();
      } else setError(failure.message || "Could not copy previous work. Nothing has been discarded. Try again.");
    },
    onSettled: () => { submitting.current = false; },
  });
  const pending = mutation.isPending;
  const ready = !!carry.preview.data && !carry.preview.data.blockedReason && !carry.preview.isFetching && !carry.preview.isError && !!carry.selection && hasCarryWork(carry.selection);
  const reviewCurrent = !!review && review.version === carry.preview.data?.version;
  return <Dialog open onOpenChange={open => { if (!open && !pending && !submitting.current) onClose(); }}>
    <DialogContent className={`max-h-[90dvh] overflow-y-auto sm:max-w-4xl ${pending ? "[&>button]:hidden" : ""}`}
      onEscapeKeyDown={event => { if (pending || submitting.current) event.preventDefault(); }}
      onPointerDownOutside={event => { if (pending || submitting.current) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>{review ? "Confirm previous work carry-forward" : "Previous context awaiting assignment"}</DialogTitle>
        <DialogDescription>{sourceLabel} → {targetLabel}. Review previous work without changing the existing replacement link. Nothing is deleted from the original.</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
      {carry.preview.isFetching && <div aria-label="Loading previous work" className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-48 w-full" /></div>}
      {carry.preview.isError && <div role="alert" className="space-y-2 text-sm"><p>Could not load previous work. {carry.preview.error.message}</p><Button variant="outline" disabled={carry.preview.isFetching} onClick={() => { setReview(null); void carry.reload(); }}>Retry loading previous work</Button></div>}
      {!carry.preview.isFetching && !carry.preview.isError && carry.preview.data && carry.selection && <QuotationCarryForwardPanel preview={carry.preview.data} selection={review ?? carry.selection} onChange={carry.setSelection} readOnly={!!review || pending} />}
      <DialogFooter className="gap-2">
        <Button variant="outline" disabled={pending} onClick={() => { if (!submitting.current) onClose(); }}>Close</Button>
        {review ? <>
          <Button variant="outline" disabled={pending} onClick={() => setReview(null)}>Back to assignment</Button>
          <Button disabled={!ready || !reviewCurrent || pending} onClick={() => {
            if (!ready || !review || !reviewCurrent || submitting.current || pending) return;
            submitting.current = true;
            mutation.mutate(review);
          }}>{pending ? "Copying previous work…" : "Confirm carry-forward"}</Button>
        </> : <Button disabled={!ready || pending} onClick={() => { if (ready && carry.selection) { setError(null); setReview(selectedCarryWork(carry.selection)); } }}>Review selected work</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
