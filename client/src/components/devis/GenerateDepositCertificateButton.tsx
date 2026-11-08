import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";

export function GenerateDepositCertificateButton({ devisId, quotation, deposit, onConfirm }: {
  devisId: number;
  quotation: string;
  deposit: string;
  onConfirm: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  async function confirm() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the certificate. Please try again.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => {
      if (!submitting.current) { setOpen(next); setError(null); }
    }}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm"
          className="h-7 min-h-7 text-[10px] font-semibold"
          onClick={(event) => event.stopPropagation()}
          data-testid={`button-acompte-generate-cert-${devisId}`}>
          Generate Certificate
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent onClick={(event) => event.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Generate deposit certificate — are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This will create a draft deposit certificate for quotation {quotation} ({deposit}).
            It will not send anything to the client or record a payment.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button type="button" disabled={pending} onClick={confirm}
            data-testid={`button-confirm-acompte-cert-${devisId}`}>
            {pending ? "Generating…" : "Yes, generate certificate"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
