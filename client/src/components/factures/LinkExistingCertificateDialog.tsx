import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link2, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Amount } from "@/components/ui/amount";
import { ApiError, apiRequest, invalidateCertificatPaymentData, projectScopedKey, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ExistingCertificatePreview {
  invoice: { id: number; invoiceNumber: string; amountHt: string | number; amountTtc: string | number; devisId: number | null };
  candidates: Array<{
    id: number;
    certificateRef: string;
    status: string;
    dateIssued: string | null;
    netToPayHt: string | number;
    netToPayTtc: string | number;
    reason: string | null;
  }>;
  expectedVersion: string;
}

function AmountPair({ ht, ttc }: { ht: string | number; ttc: string | number }) {
  return (
    <div className="grid grid-cols-2 gap-3 text-[12px] tabular-nums">
      <Amount value={Number(ht)} denomination="HT" />
      <Amount value={Number(ttc)} denomination="TTC" />
    </div>
  );
}

function LinkForm({ preview, projectId, refreshing, unavailable, onRefresh, onClose, onPendingChange }: {
  preview: ExistingCertificatePreview;
  projectId: string;
  refreshing: boolean;
  unavailable: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const selected = preview.candidates.find((candidate) => candidate.id === selectedId);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!selected || selected.reason != null || !confirmed || reason.trim().length < 10 || refreshing || unavailable) {
        throw new Error("Choisissez un certificat disponible, renseignez le motif et confirmez la correspondance des travaux.");
      }
      onPendingChange(true);
      try {
        await apiRequest("POST", `/api/invoices/${preview.invoice.id}/existing-certificates`, {
          certificatId: selected.id,
          expectedVersion: preview.expectedVersion,
          reason: reason.trim(),
          confirmed: true,
        });
        return selected.id;
      } finally {
        onPendingChange(false);
      }
    },
    onSuccess: (certificatId) => {
      for (const resource of ["certificat-invoice-links", "invoices", "certificats", "certificat-payments"]) {
        void queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, resource) });
      }
      invalidateCertificatPaymentData();
      void queryClient.invalidateQueries({ queryKey: ["/api/certificats", String(certificatId), "late-invoices"] });
      toast({ title: "Facture liée au certificat existant", description: "Le PDF émis, les montants et le statut de paiement sont inchangés." });
      onClose();
    },
  });
  const stale = mutation.error instanceof ApiError && mutation.error.status === 409;
  const locked = refreshing || mutation.isPending || unavailable;
  const valid = !!selected && selected.reason == null && reason.trim().length >= 10 && confirmed && !stale;

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (valid && !locked) mutation.mutate(); }}>
      <div className="rounded-lg border border-border/60 bg-muted/40 p-3 space-y-2">
        <p className="text-[11px] font-semibold">Facture #{preview.invoice.invoiceNumber}</p>
        <AmountPair ht={preview.invoice.amountHt} ttc={preview.invoice.amountTtc} />
        <a className="block text-[12px] underline" href={`/api/invoices/${preview.invoice.id}/pdf`} target="_blank" rel="noopener noreferrer">Ouvrir la facture originale</a>
      </div>
      <div className="rounded-lg border border-[#c1a27b]/40 bg-[#c1a27b]/10 p-3 text-[12px] leading-relaxed">
        Rapprochement documentaire uniquement. Le PDF émis, les montants du certificat et le statut de paiement restent inchangés. Aucune nouvelle autorisation de paiement n'est créée.
      </div>
      <fieldset disabled={locked || stale} className="space-y-2">
        <legend className="mb-2 text-[12px] font-semibold">Choisir le certificat déjà émis</legend>
        {preview.candidates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-[12px] text-muted-foreground">
            <p className="font-semibold text-foreground">Aucun certificat existant disponible</p>
            <p className="mt-1">Aucun candidat pour cette facture. Vérifiez le devis et les certificats du projet.</p>
          </div>
        ) : preview.candidates.map((candidate) => (
          <label key={candidate.id} className={`flex items-start gap-3 rounded-lg border p-3 ${candidate.reason != null ? "border-border/60 bg-muted/30" : selectedId === candidate.id ? "border-[#0B2545]/50 bg-[#0B2545]/5" : "border-border cursor-pointer"}`}>
            <input
              type="radio"
              name="existing-certificate"
              className="mt-1 accent-[#0B2545]"
              value={candidate.id}
              checked={selectedId === candidate.id}
              disabled={candidate.reason != null}
              onChange={() => { setSelectedId(candidate.id); setConfirmed(false); mutation.reset(); }}
              aria-describedby={candidate.reason != null ? `blocked-certificate-${candidate.id}` : undefined}
            />
            <div className="min-w-0 flex-1 space-y-2">
              <span className="flex flex-wrap justify-between gap-1 text-[12px]">
                <strong>{candidate.certificateRef}</strong>
                <span className="text-muted-foreground">{candidate.status}</span>
              </span>
              <span className="block text-[11px] text-muted-foreground">Émis le {candidate.dateIssued ? new Date(candidate.dateIssued).toLocaleDateString("fr-FR") : "—"} · Net à payer</span>
              <AmountPair ht={candidate.netToPayHt} ttc={candidate.netToPayTtc} />
              {candidate.reason != null && <span id={`blocked-certificate-${candidate.id}`} className="block text-[11px] text-destructive">Indisponible — {candidate.reason}</span>}
            </div>
          </label>
        ))}
      </fieldset>
      {selected && <a className="block text-[12px] underline" href={`/api/certificats/${selected.id}/pdf`} target="_blank" rel="noopener noreferrer">Ouvrir le certificat émis {selected.certificateRef}</a>}
      <div>
        <label htmlFor="existing-certificate-reason" className="mb-1 block text-[12px] font-semibold">Motif du rapprochement</label>
        <Textarea id="existing-certificate-reason" disabled={locked || stale} value={reason} onChange={(event) => setReason(event.target.value)} aria-describedby="existing-certificate-reason-help" placeholder="Précisez les pièces vérifiées et les travaux concernés." />
        <p id="existing-certificate-reason-help" className="mt-1 text-[11px] text-muted-foreground">10 caractères minimum. Ce motif sera conservé dans l'historique.</p>
      </div>
      <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-[12px] leading-relaxed">
        <Checkbox className="mt-0.5" disabled={locked || stale || !selected} checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
        <span>J'ai vérifié que le certificat original{selected ? ` ${selected.certificateRef}` : ""} et cette facture correspondent aux mêmes travaux. Ce lien ne constitue pas une nouvelle autorisation de paiement.</span>
      </label>
      {unavailable && <p role="alert" className="text-[12px] text-destructive">Action indisponible : projet archivé ou statut de la facture ou du certificat à vérifier. Fermez cette fenêtre et actualisez les données.</p>}
      {mutation.error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[12px] text-destructive">
        <p>{mutation.error.message}</p>
        {stale && <p className="mt-1">Les données ont changé ou ne correspondent plus. Aucun lien n'a été enregistré. Actualisez la liste puis vérifiez et confirmez à nouveau.</p>}
      </div>}
      <div className="flex flex-wrap justify-between gap-2 border-t border-border/60 pt-3">
        <Button type="button" variant="outline" disabled={locked} onClick={onRefresh} className="gap-1.5"><RefreshCw size={14} />Actualiser</Button>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={!valid || locked} className="bg-[#0B2545] text-white hover:bg-[#0B2545]/90" data-testid="button-confirm-link-existing-certificate">{mutation.isPending ? "Enregistrement…" : "Lier au certificat"}</Button>
        </div>
      </div>
    </form>
  );
}

export function LinkExistingCertificateDialog({ invoiceId, projectId, unavailable = false, onClose }: {
  invoiceId: number;
  projectId: string;
  unavailable?: boolean;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const preview = useQuery<ExistingCertificatePreview>({
    queryKey: ["/api/invoices", invoiceId, "existing-certificates"],
    queryFn: async () => (await apiRequest("GET", `/api/invoices/${invoiceId}/existing-certificates`)).json(),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const refresh = async () => {
    const result = await preview.refetch();
    if (!result.error) setRevision((value) => value + 1);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto" data-testid="dialog-link-existing-certificate" onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }} onInteractOutside={(event) => { if (pending) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Link2 size={18} className="shrink-0 text-[#c1a27b]" />Lier à un certificat existant</DialogTitle>
          <DialogDescription>Rattacher une facture approuvée après l'émission du certificat, sans créer un second certificat.</DialogDescription>
        </DialogHeader>
        {preview.isLoading ? <div className="space-y-3" aria-label="Chargement des certificats"><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div> : preview.error ? (
          <div className="space-y-3"><p role="alert" className="text-[12px] text-destructive">Impossible de charger les certificats : {preview.error.message}</p><Button variant="outline" disabled={preview.isFetching} onClick={() => { void refresh(); }}>Réessayer</Button></div>
        ) : preview.data ? (
          <LinkForm key={`${invoiceId}:${preview.data.expectedVersion}:${revision}`} preview={preview.data} projectId={projectId} unavailable={unavailable} refreshing={preview.isFetching} onRefresh={() => { void refresh(); }} onClose={onClose} onPendingChange={setPending} />
        ) : <p role="alert" className="text-[12px] text-destructive">Aucune donnée de rapprochement disponible.</p>}
      </DialogContent>
    </Dialog>
  );
}
