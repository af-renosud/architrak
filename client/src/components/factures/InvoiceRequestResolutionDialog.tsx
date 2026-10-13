import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency as fmt } from "@/lib/utils";
import type { Invoice } from "@shared/schema";
import { parseReviewAmount } from "./invoice-review-amounts";

interface ResolutionPreview {
  expectedVersion: string;
  amountHt: number;
  amountTtc: number;
  certificates: { id: number; reference: string; amountHt: string | number; status: string }[];
  hasExternalInvoice: boolean;
  feeRates: number[];
}

function ResolutionForm({ preview, invoice, refreshing, onRefresh, onClose, onPendingChange }: {
  preview: ResolutionPreview;
  invoice: Invoice;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const { toast } = useToast();
  const [amountHt, setAmountHt] = useState(Number(preview.amountHt).toFixed(2));
  const [amountTtc, setAmountTtc] = useState(Number(preview.amountTtc).toFixed(2));
  const [reason, setReason] = useState("");
  const [reconcile, setReconcile] = useState(false);
  const [externalInvoiceUnsent, setExternalInvoiceUnsent] = useState(false);
  const ht = parseReviewAmount(amountHt);
  const ttc = parseReviewAmount(amountTtc);
  const validAmounts = ht != null && ttc != null && ht > 0 && ttc >= ht &&
    Math.abs(ht * 100 - Math.round(ht * 100)) < 0.000001 &&
    Math.abs(ttc * 100 - Math.round(ttc * 100)) < 0.000001;
  const certificate = preview.certificates.length === 1 ? preview.certificates[0] : null;
  const blocked = !validAmounts || reason.trim().length < 20 || reason.trim().length > 4000 ||
    preview.certificates.length > 1 || (!!certificate && !reconcile) ||
    (preview.hasExternalInvoice && !externalInvoiceUnsent);
  const mutation = useMutation({
    mutationFn: async () => {
      if (blocked || refreshing) throw new Error("Review the amounts, documentary reason and required acknowledgements before recording this decision.");
      onPendingChange(true);
      try {
        const response = await apiRequest("POST", `/api/invoices/${invoice.id}/request-resolution`, {
          expectedVersion: preview.expectedVersion,
          amountHt: ht,
          amountTtc: ttc,
          reason: reason.trim(),
          ...(certificate ? { reconcileCertificateId: certificate.id } : {}),
          ...(preview.hasExternalInvoice ? { externalInvoiceUnsent } : {}),
        });
        const result = await response.json();
        if (result.corrected !== true) throw new Error("The server did not confirm that the request decision was recorded. Refresh the preview before trying again.");
        return result as { corrected: true; attachmentReviewRequired?: boolean };
      } catch (error) {
        onPendingChange(false);
        throw error;
      }
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.some((part) =>
          typeof part === "string" && /invoice|certificat|fee|honoraire|financial-summary|accounting-status|devis|intake|dashboard/.test(part)),
      });
      toast({
        title: "Audited request decision recorded",
        description: result.attachmentReviewRequired
          ? "The architect invoice was detached for review. Reattach the checked original before sending the certificate."
          : "Amounts and existing fee entries were updated. This does not approve, pay or send the invoice.",
      });
      onPendingChange(false);
      onClose();
    },
  });
  const locked = refreshing || mutation.isPending;

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!blocked && !locked) mutation.mutate(); }}>
      <div className="rounded-lg border border-[#c1a27b]/40 bg-[#c1a27b]/10 p-3 text-[12px] leading-relaxed">
        <p className="font-semibold text-[#0B2545]">A documentary decision, not a normal review acknowledgement</p>
        <p>This records an audited resolution bound to the source evidence and these exact amounts. Verify the original PDF and explain why this is the amount requested. It does not confirm, approve, pay or send this invoice; its current status is retained.</p>
      </div>
      <fieldset disabled={locked} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-[13px] font-semibold text-[#0B2545]">Amount requested on this invoice</legend>
        <div>
          <label htmlFor="request-resolution-ht" className="mb-1 block text-[12px]">Requested amount HT</label>
          <Input id="request-resolution-ht" type="number" min="0.01" step="0.01" value={amountHt} onChange={(event) => setAmountHt(event.target.value)} />
        </div>
        <div>
          <label htmlFor="request-resolution-ttc" className="mb-1 block text-[12px]">Requested amount TTC</label>
          <Input id="request-resolution-ttc" type="number" min="0.01" step="0.01" value={amountTtc} onChange={(event) => setAmountTtc(event.target.value)} />
        </div>
        <p className="text-[11px] text-muted-foreground sm:col-span-2">
          Enter both positive amounts to the nearest cent; TTC must be at least HT. No tax rate is assumed.
          {validAmounts && <> Derived TVA: {fmt(ttc! - ht!)}.</>}
        </p>
      </fieldset>
      <div className="rounded-lg border border-border p-3 text-[12px] space-y-2" data-testid="request-resolution-fee-preview">
        <p className="font-semibold">Expected fee impact — existing entries only</p>
        {preview.feeRates.length ? (
          <>
            {preview.feeRates.map((rate, index) => (
              <p key={index} className="flex justify-between gap-3">
                <span>Fee entry {index + 1} · {rate}% of requested HT</span>
                <strong className="tabular-nums">{validAmounts ? fmt(Math.round(ht! * rate) / 100) : "Enter valid amounts"}</strong>
              </p>
            ))}
            <p className="text-muted-foreground">Estimate only: each existing fee entry is recalculated from the requested HT at its recorded rate. No new fee entry is created by this decision.</p>
          </>
        ) : <p className="text-muted-foreground">No existing fee entries to recalculate. The usual approval workflow determines fees later.</p>}
      </div>
      <div>
        <label htmlFor="request-resolution-reason" className="mb-1 block text-[12px] font-semibold">Documentary reason for this decision</label>
        <Textarea id="request-resolution-reason" value={reason} disabled={locked} maxLength={4000} onChange={(event) => setReason(event.target.value)} placeholder="Identify the source PDF, page or printed request, the intended claim and how its HT, TTC and tax breakdown were verified." aria-describedby="request-resolution-reason-help" />
        <p id="request-resolution-reason-help" className="mt-1 text-[11px] text-muted-foreground">At least 20 characters; recorded in the audit with the before/after state. {reason.trim().length}/4000</p>
      </div>
      {preview.certificates.length > 0 && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[12px] leading-relaxed space-y-2">
          <p className="font-semibold text-amber-950">Existing certificate reconciliation</p>
          {preview.certificates.map((item) => <p key={item.id}>{item.reference} · {item.status} · {fmt(Number(item.amountHt))} HT</p>)}
          <p>Certificate amounts and retention remain unchanged. This decision links the invoice to the existing certificate; it must not create a second claim. The server verifies whether the existing certificate can safely be retained.</p>
          {certificate ? (
            <label className="flex items-start gap-2">
              <Checkbox checked={reconcile} disabled={locked} onCheckedChange={(value) => setReconcile(value === true)} />
              <span>I explicitly reconcile this request with certificate {certificate.reference}, keeping its amounts and retention unchanged.</span>
            </label>
          ) : <p role="alert" className="font-semibold text-destructive">Multiple certificates are affected. This dialog supports reconciliation with only one existing certificate. Resolve the certificate scope before recording this decision.</p>}
        </section>
      )}
      {preview.hasExternalInvoice && (
        <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[12px] leading-relaxed space-y-2">
          <p className="font-semibold">External architect invoice requires review</p>
          <p>The existing architect invoice will be detached from the outbound certificate package for review. The original is preserved in the audit, not deleted. Reattach the checked original before sending; this decision does not authorize delivery.</p>
          <label className="flex items-start gap-2">
            <Checkbox checked={externalInvoiceUnsent} disabled={locked} onCheckedChange={(value) => setExternalInvoiceUnsent(value === true)} />
            <span>I verified that the external architect invoice has not been sent or paid.</span>
          </label>
        </section>
      )}
      {mutation.error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[12px] text-destructive">{mutation.error.message}</p>}
      <p className="text-[11px] text-muted-foreground">If the invoice or dependent records changed, refresh the preview and review again. Refreshing resets the amounts, reason and acknowledgements.</p>
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="outline" disabled={locked} onClick={onRefresh} className="gap-1.5"><RefreshCw size={14} />Refresh preview</Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={locked} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={blocked || locked}>{mutation.isPending ? "Recording decision…" : "Record audited decision"}</Button>
        </div>
      </div>
    </form>
  );
}

export function InvoiceRequestResolutionDialog({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const preview = useQuery<ResolutionPreview>({
    queryKey: ["/api/invoices", invoice.id, "request-resolution"],
    queryFn: async () => (await apiRequest("GET", `/api/invoices/${invoice.id}/request-resolution`)).json(),
    staleTime: 0,
    retry: false,
  });
  const refresh = async () => {
    const result = await preview.refetch();
    if (!result.error) setRevision((value) => value + 1);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto" data-testid="dialog-invoice-request-resolution">
        <DialogHeader>
          <DialogTitle>Resolve invoice request — #{invoice.invoiceNumber}</DialogTitle>
          <DialogDescription>Audited request decision for this {invoice.status} invoice. Approved invoices can be corrected only while unpaid and subject to accounting safeguards.</DialogDescription>
        </DialogHeader>
        {preview.isFetching && !preview.data ? <div className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-20 w-full" /></div> : preview.error ? (
          <div className="space-y-3">
            <p role="alert" className="flex items-start gap-2 text-[12px] text-destructive"><AlertTriangle size={16} className="shrink-0" />{preview.error.message}</p>
            <Button variant="outline" onClick={() => { void refresh(); }}>Refresh preview</Button>
          </div>
        ) : preview.data ? (
          <ResolutionForm key={`${preview.data.expectedVersion}:${revision}`} preview={preview.data} invoice={invoice} refreshing={preview.isFetching || pending} onRefresh={() => { void refresh(); }} onClose={onClose} onPendingChange={setPending} />
        ) : <p role="alert" className="text-destructive text-[12px]">No request-resolution preview is available.</p>}
      </DialogContent>
    </Dialog>
  );
}
