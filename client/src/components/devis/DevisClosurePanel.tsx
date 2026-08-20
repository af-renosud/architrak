import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileCheck2, Loader2, LockKeyhole } from "lucide-react";
import type { Devis, Marche } from "@shared/schema";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, projectScopedKey, queryClient } from "@/lib/queryClient";

function formatClosedAt(value: Date | string | null): string {
  if (!value) return "date inconnue";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function DevisClosurePanel({
  devis,
  projectId,
  isArchived,
}: {
  devis: Devis;
  projectId: string;
  isArchived: boolean;
}) {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { data: marches = [] } = useQuery<Marche[]>({
    queryKey: projectScopedKey(projectId, "marches"),
  });

  const linkedMarche =
    devis.marcheId == null ? null : marches.find((marche) => marche.id === devis.marcheId) ?? null;
  const relationshipMatches =
    linkedMarche != null &&
    linkedMarche.projectId === devis.projectId &&
    linkedMarche.contractorId === devis.contractorId;
  const pvApproved =
    relationshipMatches &&
    linkedMarche.pvReceptionStatus === "approved" &&
    linkedMarche.receptionDate != null;

  const closeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/devis/${devis.id}/close`);
      return response.json() as Promise<Devis & { alreadyClosed?: boolean }>;
    },
    onSuccess: (closed) => {
      setConfirmOpen(false);
      queryClient.setQueryData(["/api/devis", devis.id], closed);
      queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "devis") });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "financial-summary") });
      toast({
        title: closed.alreadyClosed ? "Devis déjà clôturé" : "Devis clôturé",
        description: "Le PV de réception approuvé a été vérifié et la clôture a été enregistrée.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Clôture refusée",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (devis.closureState === "closed") {
    return (
      <div
        className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-900"
        data-testid={`panel-devis-closed-${devis.id}`}
      >
        <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" />
        <div>
          <p className="text-[11px] font-bold uppercase tracking-widest">Travaux clôturés</p>
          <p className="mt-0.5 text-[10px] text-emerald-800">
            Clôture enregistrée le {formatClosedAt(devis.closedAt)} après contrôle du PV de réception.
          </p>
        </div>
      </div>
    );
  }

  const eligibleState =
    devis.accountingState === "active" &&
    devis.status !== "void" &&
    devis.signOffStage === "client_signed_off";
  if (!eligibleState) return null;

  let blockedMessage: string | null = null;
  if (devis.marcheId == null) {
    blockedMessage =
      "Ce devis n'est lié à aucun marché. Liez-le au marché correspondant avant de clôturer les travaux.";
  } else if (!relationshipMatches) {
    blockedMessage =
      "Le marché lié ne correspond pas au même projet et à la même entreprise. Corrigez le lien avant la clôture.";
  } else if (linkedMarche.pvReceptionStatus === "draft") {
    blockedMessage = "Le PV de réception du marché est encore en brouillon et doit être approuvé.";
  } else if (!pvApproved) {
    blockedMessage =
      "Un PV de réception approuvé avec sa date de réception est obligatoire avant la clôture.";
  }

  const pvHref = linkedMarche
    ? `/projets/${projectId}?tab=marche&pvMarche=${linkedMarche.id}#marche-${linkedMarche.id}`
    : `/projets/${projectId}?tab=marche`;

  return (
    <>
      <div
        className={`rounded-xl border px-3 py-3 ${
          pvApproved
            ? "border-[#0B2545]/20 bg-[#0B2545]/[0.03]"
            : "border-amber-200 bg-amber-50"
        }`}
        data-testid={`panel-devis-closure-${devis.id}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            {pvApproved ? (
              <FileCheck2 size={17} className="mt-0.5 shrink-0 text-emerald-600" />
            ) : (
              <LockKeyhole size={17} className="mt-0.5 shrink-0 text-amber-600" />
            )}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-[#0B2545]">
                Clôture des travaux
              </p>
              <p className={`mt-0.5 text-[10px] ${pvApproved ? "text-muted-foreground" : "text-amber-800"}`}>
                {blockedMessage ??
                  `PV approuvé le ${linkedMarche?.receptionDate}. Le devis peut maintenant être clôturé.`}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {blockedMessage && (
              <a
                href={pvHref}
                className="inline-flex h-8 items-center rounded-md border border-amber-300 bg-white px-3 text-[9px] font-bold uppercase tracking-widest text-amber-800 hover:bg-amber-100"
                data-testid={`link-devis-closure-pv-${devis.id}`}
              >
                {linkedMarche ? "Ouvrir le PV" : "Ouvrir les marchés"}
              </a>
            )}
            <Button
              type="button"
              size="sm"
              disabled={!pvApproved || isArchived || closeMutation.isPending}
              onClick={() => setConfirmOpen(true)}
              className="h-8 text-[9px] font-bold uppercase tracking-widest"
              data-testid={`button-close-devis-${devis.id}`}
            >
              {closeMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              Clôturer le devis
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid={`dialog-close-devis-${devis.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Clôturer définitivement ce devis ?</AlertDialogTitle>
            <AlertDialogDescription>
              ArchiTrak vérifiera de nouveau le lien vers le marché et son PV de réception approuvé.
              La clôture sera horodatée et enregistrée à votre nom.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closeMutation.isPending}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              disabled={closeMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                closeMutation.mutate();
              }}
              data-testid={`button-confirm-close-devis-${devis.id}`}
            >
              {closeMutation.isPending ? "Clôture…" : "Confirmer la clôture"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}