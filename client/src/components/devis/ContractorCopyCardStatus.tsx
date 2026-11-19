import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ContractorCopySend } from "./ContractorCopySend";
import type { ExternalDelivery } from "./ContractorCopyExternalRecord";

type Delivery = { id: number; status: string; currentDocument: boolean; recipientEmail: string | null; sentAt: string | null };
export function contractorCardState(deliveries: Delivery[], externalDeliveries: ExternalDelivery[] = []) {
  const current = deliveries.filter(d => d.currentDocument).sort((a, b) => b.id - a.id);
  const latest = current[0];
  if (current.some(d => d.status === "reconciling")) return { label: "Checking send result", tone: "amber" };
   if (current.some(d => ["queued", "sending", "pending_pdf", "pending", "processing"].includes(d.status))) return { label: "Sending to contractor…", tone: "amber" };
   if (externalDeliveries.some(d => d.currentDocument)) return { label: "Sent to contractor — recorded manually", tone: "green" };
   if (latest && ["failed", "blocked"].includes(latest.status)) return { label: "Contractor copy needs attention", tone: "red" };
  if (current.some(d => d.status === "sent" && d.sentAt)) return { label: "Sent to contractor", tone: "green" };
  if (latest) return { label: "Contractor copy needs attention", tone: "amber" };
  return { label: "Send signed copy to contractor", tone: "amber" };
}

export function ContractorCopyCardStatus({ devisId, projectId, isSigned, isArchived, inactive = false }: {
  devisId: number; projectId: number; isSigned: boolean; isArchived: boolean; inactive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery<{ deliveries: Delivery[]; externalDeliveries?: ExternalDelivery[] }>({
    queryKey: ["/api/devis", devisId, "contractor-copy-status"],
    enabled: isSigned,
    staleTime: 15000,
    refetchOnWindowFocus: false,
    refetchInterval: q => q.state.data?.deliveries.some(d => d.currentDocument && ["queued", "sending", "pending_pdf", "reconciling", "pending", "processing"].includes(d.status)) ? 5000 : false,
  });
  const state = !isSigned ? { label: "Awaiting signature", tone: "grey" }
    : query.isError ? { label: "Contractor copy status unavailable", tone: "grey" }
    : !query.data ? { label: "Checking contractor copy…", tone: "grey" }
    : contractorCardState(query.data.deliveries, query.data.externalDeliveries);
  const colors = state.tone === "green" ? "border-emerald-300 bg-emerald-50 text-emerald-800"
    : state.tone === "red" ? "border-red-300 bg-red-50 text-red-800"
    : state.tone === "amber" ? "border-amber-300 bg-amber-50 text-amber-900" : "text-muted-foreground";
  return <span className="inline-flex max-w-full" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <Button type="button" variant="outline" size="sm" className={`h-auto min-h-7 whitespace-normal text-left text-[11px] ${colors}`}
      data-testid={`contractor-card-status-${devisId}`} onClick={() => setOpen(true)}>
      {state.tone === "green" ? <MailCheck className="mr-1.5 h-3.5 w-3.5 shrink-0" /> : <Mail className="mr-1.5 h-3.5 w-3.5 shrink-0" />}
      {state.label}
    </Button>
    <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value && isSigned) void query.refetch(); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Signed quotation — contractor copy</DialogTitle>
          <DialogDescription>Review the recipient and delivery history. Email sending requires confirmation; provider acceptance does not confirm receipt. Deliveries by other means are recorded by an operator, not verified receipt, and do not send an email.</DialogDescription>
        </DialogHeader>
        {query.isError && <Button variant="outline" onClick={() => query.refetch()}>Refresh status</Button>}
        {inactive && <p className="text-sm text-muted-foreground">This quotation is no longer current. Delivery history is retained; sending is disabled.</p>}
        {open && <ContractorCopySend devisId={devisId} projectId={projectId} isSigned={isSigned} isArchived={isArchived || inactive} />}
      </DialogContent>
    </Dialog>
  </span>;
}
