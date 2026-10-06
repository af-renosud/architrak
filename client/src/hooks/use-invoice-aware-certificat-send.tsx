import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { architectInvoiceKey, isArchitectInvoiceConfirmationRequired, type ArchitectInvoiceStatus } from "@/lib/architect-invoice";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ArchitectInvoiceManager } from "@/components/certificats/ArchitectInvoiceSection";

interface SendTarget { certId: number; projectId: number | string }
interface SendOptions<TData, TVariables> {
  target: (variables: TVariables) => SendTarget;
  onSuccess: (data: TData, variables: TVariables) => void;
  onError: (error: Error) => void;
}

/** Gate every send surface without changing its existing success/error handling. */
export function useInvoiceAwareCertificatSend<TData = unknown, TVariables = void>(options: SendOptions<TData, TVariables>) {
  const [pending, setPending] = useState<{ variables: TVariables; target: SendTarget } | null>(null);
  const [managing, setManaging] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);
  const mutation = useMutation({
    mutationFn: async ({ variables, confirmed }: { variables: TVariables; confirmed: boolean }) => {
      const target = options.target(variables);
      const response = await apiRequest("POST", `/api/projects/${target.projectId}/certificats/${target.certId}/send`,
        confirmed ? { confirmWithoutArchitectInvoice: true } : {});
      return response.json() as Promise<TData>;
    },
    onSuccess: (data, { variables }) => {
      queryClient.invalidateQueries({ queryKey: architectInvoiceKey(options.target(variables).certId) });
      options.onSuccess(data, variables);
    },
    onError: (error: Error, { variables }) => {
      if (isArchitectInvoiceConfirmationRequired(error)) {
        queryClient.invalidateQueries({ queryKey: architectInvoiceKey(options.target(variables).certId) });
        setPending({ variables, target: options.target(variables) });
      } else options.onError(error);
    },
    onSettled: () => { busy.current = false; },
  });
  const mutate = async (variables: TVariables) => {
    if (busy.current || pending || managing !== null) return;
    busy.current = true;
    setChecking(true);
    const target = options.target(variables);
    try {
      // Always read freshly; the send endpoint still guards an attachment race.
      const status = await queryClient.fetchQuery<ArchitectInvoiceStatus>({
        queryKey: architectInvoiceKey(target.certId), staleTime: 0,
      });
      if (!status.attached && !status.locked) {
        setPending({ variables, target });
        busy.current = false;
      } else mutation.mutate({ variables, confirmed: false });
    } catch (error) {
      busy.current = false;
      options.onError(error instanceof Error ? error : new Error("Impossible de vérifier la facture d’architecte."));
    } finally { setChecking(false); }
  };
  return {
    mutate,
    isPending: checking || mutation.isPending,
    confirmationDialog: <>
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <AlertDialogContent data-testid="architect-invoice-send-reminder">
          <AlertDialogHeader><AlertDialogTitle>Envoyer sans facture d’architecte ?</AlertDialogTitle><AlertDialogDescription>Aucune facture d’architecte n’est jointe à ce certificat. Vous pouvez annuler pour joindre votre PDF, ou confirmer explicitement l’envoi sans cette facture. Après préparation de l’envoi, la pièce jointe sera verrouillée.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter className="flex-wrap gap-2">
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <Button variant="outline" onClick={() => { if (pending) setManaging(pending.target.certId); setPending(null); }}>Gérer la facture</Button>
            <AlertDialogAction onClick={() => { if (pending) { busy.current = true; mutation.mutate({ variables: pending.variables, confirmed: true }); } setPending(null); }} data-testid="send-without-architect-invoice">Envoyer sans facture</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {managing !== null && <ArchitectInvoiceManager certId={managing} onClose={() => setManaging(null)} />}
    </>,
  };
}
