import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCertificatPaymentContext } from "@/hooks/use-certificat-payment-context";
import { CertificatPaymentsSection } from "./CertificatDetailDialog";

export function InvoicePaymentDialog({ certificatId, invoiceId, invoiceNumber, onClose }: {
  certificatId: number;
  invoiceId: number;
  invoiceNumber: string;
  onClose: () => void;
}) {
  const context = useCertificatPaymentContext(certificatId);
  return <Dialog open modal={false} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPortal><div aria-hidden="true" className="fixed inset-0 z-50 bg-black/80" /></DialogPortal>
    <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" data-testid="dialog-invoice-payment" onInteractOutside={(event) => {
      if ((event.target as HTMLElement)?.closest?.('[data-testid^="dialog-pdf-popout-payment-evidence-"]')) event.preventDefault();
    }}>
      <DialogHeader>
        <DialogTitle>Paiement client — Facture #{invoiceNumber}</DialogTitle>
        <DialogDescription>Le paiement est enregistré dans le journal du certificat lié, sans créer de journal distinct pour cette facture.</DialogDescription>
      </DialogHeader>
      {context.isLoading ? <div className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-28 w-full" /></div>
        : context.error ? <div role="alert" className="space-y-2 text-[12px] text-destructive"><p>Impossible de charger le certificat : {context.error.message}</p><Button variant="outline" onClick={() => void context.refetch()}>Réessayer</Button></div>
        : context.data ? <><p className="text-[11px] text-muted-foreground">Certificat {context.data.cert.certificateRef}</p><CertificatPaymentsSection cert={context.data.cert} initialInvoiceId={invoiceId} /></> : null}
    </DialogContent>
  </Dialog>;
}
