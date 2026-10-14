import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, projectScopedKey, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Devis } from "@shared/schema";

export type StageRecoveryRequest =
  | { action: "reopen"; expectedStage: string; targetStage: string; targetLabel: string }
  | { action: "restore"; expectedStage: string };

/** Mounted per request: cancel/reopen never retains a previous audit reason. */
export function StageRecoveryDialog({ devisId, projectId, request, onClose }: {
  devisId: number;
  projectId: string;
  request: StageRecoveryRequest;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const trimmedReason = reason.trim();
  const valid = trimmedReason.length >= 10 && reason.length <= 2000;
  const restoring = request.action === "restore";
  const mutation = useMutation({
    mutationFn: async () => {
      if (!valid) throw new Error("Provide a reason between 10 and 2000 characters.");
      const body = {
        action: request.action,
        expectedStage: request.expectedStage,
        confirmed: true,
        reason: trimmedReason,
        ...(request.action === "reopen" ? { targetStage: request.targetStage } : {}),
      };
      const res = await apiRequest("POST", `/api/devis/${devisId}/stage-recovery`, body);
      return res.json() as Promise<Devis>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["/api/devis", devisId], updated);
      for (const resource of ["devis", "devis-readiness", "financial-summary", "intake", "accounting-status"]) {
        void queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, resource) });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId] });
      toast({ title: restoring ? "Signed status restored" : "Quotation reopened for review" });
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message);
      // A stale expectedStage may have been rejected: refresh, never overwrite.
      void queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "devis") });
      void queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId] });
    },
  });

  return <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent className="max-w-md" data-testid={`dialog-stage-recovery-${devisId}`}>
      <DialogHeader>
        <DialogTitle>{restoring ? "Restore signed status" : "Reopen quotation for review"}</DialogTitle>
        <DialogDescription>
          {request.action === "reopen"
            ? `Move the internal review stage back to ${request.targetLabel}. Any recorded signature and signed PDF remain preserved.`
            : "Restore the signed status using the existing signed PDF. This does not request a new signature or send emails. Original signature dates are preserved; insurance requirements are not overridden."}
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        if (valid && !mutation.isPending) { setError(""); mutation.mutate(); }
      }}>
        <div className="space-y-2">
          <label htmlFor={`stage-recovery-reason-${devisId}`} className="text-sm font-medium">Reason (required)</label>
          <Textarea id={`stage-recovery-reason-${devisId}`} value={reason}
            onChange={(event) => setReason(event.target.value)} required minLength={10} maxLength={2000}
            disabled={mutation.isPending} rows={4} aria-describedby={`stage-recovery-hint-${devisId}`}
            data-testid={`input-stage-recovery-reason-${devisId}`} />
          <p id={`stage-recovery-hint-${devisId}`} className="text-xs text-muted-foreground">
            Minimum 10 characters. {reason.length} / 2000. This reason is recorded in the audit history.
          </p>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!valid || mutation.isPending} data-testid={`button-stage-recovery-confirm-${devisId}`}>
            {mutation.isPending ? "Saving…" : restoring ? "Restore signed status" : "Confirm reopening"}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
