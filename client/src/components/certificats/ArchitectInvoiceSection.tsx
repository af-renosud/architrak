import { useRef, useState } from "react";
import { Paperclip, Upload, Trash2, ExternalLink, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { useArchitectInvoice, useArchitectInvoiceMutation } from "@/hooks/use-architect-invoice";
import { architectInvoiceDeliveryLabel } from "@/lib/architect-invoice";
import { useToast } from "@/hooks/use-toast";

export function ArchitectInvoiceSection({ certId }: { certId: number }) {
  const query = useArchitectInvoice(certId);
  const mutation = useArchitectInvoiceMutation(certId);
  const input = useRef<HTMLInputElement>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const { toast } = useToast();
  const change = (file: File | null) => mutation.mutate(file, {
    onSuccess: () => toast({ title: file ? "Facture d’architecte jointe" : "Facture d’architecte retirée" }),
    onError: (error) => toast({ title: "Pièce jointe non modifiée", description: error.message, variant: "destructive" }),
  });
  const status = query.data;
  const disabled = !status || status.locked || mutation.isPending || query.isFetching;
  return (
    <section className="space-y-3 rounded-xl border border-border p-4" data-testid={`architect-invoice-section-${certId}`}>
      <div className="flex items-center gap-2"><Paperclip size={13} /><TechnicalLabel>Facture d’architecte</TechnicalLabel></div>
      {query.isLoading ? <Skeleton className="h-10 w-full" /> : query.isError ? (
        <div className="text-[11px] text-destructive"><p>Impossible de vérifier la pièce jointe : {query.error.message}</p><Button variant="outline" size="sm" onClick={() => query.refetch()}>Réessayer</Button></div>
      ) : status && (
        <>
          <p className={`text-[11px] font-semibold ${status.attached ? "text-foreground" : "text-amber-700 dark:text-amber-300"}`} data-testid={`architect-invoice-status-${certId}`}>
            {status.attached ? "Facture jointe" : "Aucune facture jointe"}
          </p>
          {status.fileName && <p className="break-all text-[11px] text-muted-foreground">{status.fileName}</p>}
          {architectInvoiceDeliveryLabel(status) && <p className="text-[11px] text-muted-foreground">{architectInvoiceDeliveryLabel(status)}</p>}
          {status.locked ? (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground"><Lock size={12} className="mt-0.5 shrink-0" />Envoi préparé, en file d’attente ou déjà effectué : la pièce jointe est verrouillée.</p>
          ) : (
            <p className="text-[11px] text-muted-foreground">Joignez votre facture préparée en dehors d’ArchiTrak. Elle accompagnera le certificat à l’envoi. PDF, 10 Mo maximum. Les montants du certificat restent inchangés.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input ref={input} type="file" accept=".pdf,application/pdf" className="sr-only" aria-label="Joindre une facture d’architecte PDF" disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) change(file); }} />
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => input.current?.click()} data-testid={`upload-architect-invoice-${certId}`}><Upload size={12} />{mutation.isPending ? "Enregistrement…" : status.attached ? "Remplacer le PDF" : "Joindre un PDF"}</Button>
            {status.attached && (
              <>
                <Button variant="outline" size="sm" asChild><a href={`/api/certificats/${certId}/architect-invoice/pdf`} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} />Voir / télécharger</a></Button>
                <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setRemoveOpen(true)} data-testid={`remove-architect-invoice-${certId}`}><Trash2 size={12} />Retirer</Button>
              </>
            )}
          </div>
        </>
      )}
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Retirer la facture d’architecte ?</AlertDialogTitle><AlertDialogDescription>Le certificat ne sera plus accompagné de cette facture. Vous pourrez joindre un autre PDF avant la préparation de l’envoi.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Annuler</AlertDialogCancel><AlertDialogAction disabled={disabled} onClick={() => change(null)}>Retirer la facture</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export function ArchitectInvoiceManager({ certId, onClose }: { certId: number; onClose: () => void }) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>Facture d’architecte</DialogTitle><DialogDescription>Pièce jointe du certificat #{certId} — indépendante de la comptabilité.</DialogDescription></DialogHeader><ArchitectInvoiceSection certId={certId} /></DialogContent></Dialog>;
}

export function ArchitectInvoiceBadge({ certId }: { certId: number }) {
  const query = useArchitectInvoice(certId);
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[9px] text-muted-foreground hover:bg-accent text-left" onClick={() => setOpen(true)} data-testid={`architect-invoice-badge-${certId}`} title="Gérer la facture d’architecte">
      <Paperclip size={10} />
      {query.isLoading ? "Facture : vérification…" : query.isError ? "Facture : statut indisponible" : query.data ? architectInvoiceDeliveryLabel(query.data) ?? (query.data.attached ? "Facture d’architecte jointe" : "Sans facture d’architecte") : "Facture : statut indisponible"}
    </button>
    {open && <ArchitectInvoiceManager certId={certId} onClose={() => setOpen(false)} />}
  </>;
}
