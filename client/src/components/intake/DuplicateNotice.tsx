import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { IntakeDuplicateSummary } from "@shared/intake-duplicate";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";

export function DuplicateNotice({ summary, projectId }: { summary: IntakeDuplicateSummary; projectId: string }) {
  const [confirm, setConfirm] = useState(false);
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/intake-documents/${summary.intakeId}/recover-duplicate`, { confirmed: true, version: summary.version }),
    onSuccess: () => {
      for (const resource of ["intake", "devis", "invoices", "documents", "financial-summary"]) {
        queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), resource] });
      }
      setConfirm(false);
      toast({ title: summary.recovery === "draft" ? "New draft ready for review" : "Original intake queued", description: "The original record and history have been preserved." });
    },
    onError: (error: Error) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "intake", "duplicates"] });
      toast({ title: "Recovery not performed", description: error.message, variant: "destructive" });
    },
  });
  return <div className="mt-2 text-xs space-y-2" data-testid={`duplicate-summary-${summary.intakeId}`}>
    <p className="font-medium">{summary.label}</p>
    <p className="text-muted-foreground">{summary.match === "exact" ? "Identical PDF. " : summary.match === "content" ? "Matching extracted content. " : ""}{summary.explanation}</p>
    <div className="flex flex-wrap gap-2">
      {summary.href && <Button asChild size="sm" variant="outline"><a href={summary.href}>View existing document</a></Button>}
      {summary.evidenceHref && <Button asChild size="sm" variant="outline"><a href={summary.evidenceHref} target="_blank" rel="noreferrer">View exact evidence PDF</a></Button>}
      {summary.originalHref && <Button asChild size="sm" variant="outline"><a href={summary.originalHref}>View original intake</a></Button>}
      {summary.recovery && <Button size="sm" variant="outline" onClick={() => setConfirm(true)} data-testid={`recover-duplicate-${summary.intakeId}`}>
        {summary.recovery === "draft" ? "Recover as new draft" : "Resume original intake"}
      </Button>}
    </div>
    {!summary.recovery && summary.blockedReason && <p className="text-muted-foreground">{summary.blockedReason}</p>}
    <AlertDialog open={confirm} onOpenChange={setConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{summary.recovery === "draft" ? "Recover as a new reviewed draft?" : "Resume the original intake?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {summary.recovery === "draft"
              ? "The historical record stays void and unchanged. A new draft will require a full review before confirmation. This does not approve a quotation, record payment, or send any email."
              : "The earlier retained copy will be queued for normal analysis and routing. This upload will remain linked to that original, rather than create parallel work."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={mutation.isPending} onClick={e => { e.preventDefault(); mutation.mutate(); }}>
            {mutation.isPending ? "Recovering…" : "Confirm recovery"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
