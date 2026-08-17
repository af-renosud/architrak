import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@/hooks/use-upload";
import { apiRequest, queryClient, projectScopedKey } from "@/lib/queryClient";
import { FileCheck, Upload, CheckCircle2 } from "lucide-react";
import type { Marche } from "@shared/schema";

/**
 * Task #566 — PV de réception per marché.
 *
 * Records the procès-verbal de réception (uploaded document OR manual
 * attestation) with its reception date as a DRAFT, then lets the architect
 * approve it. Approval is what unlocks the final-payment (solde) gate on
 * certificats: until then the server refuses solde creation/seal/send.
 */
export function PvReceptionBadge({ marche }: { marche: Marche }) {
  if (marche.pvReceptionStatus === "approved") {
    return (
      <span
        className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 inline-flex items-center gap-1"
        data-testid={`badge-marche-pv-approved-${marche.id}`}
      >
        <CheckCircle2 size={10} /> PV approuvé
      </span>
    );
  }
  if (marche.pvReceptionStatus === "draft") {
    return (
      <span
        className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
        data-testid={`badge-marche-pv-draft-${marche.id}`}
      >
        PV brouillon
      </span>
    );
  }
  return (
    <span
      className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
      data-testid={`badge-marche-pv-none-${marche.id}`}
    >
      Sans PV
    </span>
  );
}

export function PvReceptionDialog({
  marche,
  projectId,
  disabled,
}: {
  marche: Marche;
  projectId: string;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [receptionDate, setReceptionDate] = useState(marche.receptionDate ?? "");
  const [attestationNote, setAttestationNote] = useState(marche.pvAttestationNote ?? "");
  const [uploaded, setUploaded] = useState<{ storageKey: string; fileName: string } | null>(
    marche.pvDocumentStorageKey && marche.pvDocumentFileName
      ? { storageKey: marche.pvDocumentStorageKey, fileName: marche.pvDocumentFileName }
      : null,
  );

  const { uploadFile, isUploading } = useUpload({
    onError: (err) => toast({ title: "Téléversement échoué", description: err.message, variant: "destructive" }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "marches") });
  };

  const saveDraftMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/marches/${marche.id}/pv`, {
        receptionDate,
        ...(uploaded
          ? { documentStorageKey: uploaded.storageKey, documentFileName: uploaded.fileName }
          : {}),
        ...(attestationNote.trim() ? { attestationNote: attestationNote.trim() } : {}),
      });
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "PV de réception enregistré (brouillon)" });
    },
    onError: (error: Error) =>
      toast({ title: "Enregistrement échoué", description: error.message, variant: "destructive" }),
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/marches/${marche.id}/pv/approve`);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setOpen(false);
      toast({
        title: "PV de réception approuvé",
        description: "Le certificat de solde de ce marché est maintenant débloqué.",
      });
    },
    onError: (error: Error) =>
      toast({ title: "Approbation échouée", description: error.message, variant: "destructive" }),
  });

  const approved = marche.pvReceptionStatus === "approved";
  const canSaveDraft =
    !approved && receptionDate.length === 10 && (uploaded != null || attestationNote.trim().length > 0);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setReceptionDate(marche.receptionDate ?? "");
          setAttestationNote(marche.pvAttestationNote ?? "");
          setUploaded(
            marche.pvDocumentStorageKey && marche.pvDocumentFileName
              ? { storageKey: marche.pvDocumentStorageKey, fileName: marche.pvDocumentFileName }
              : null,
          );
          setOpen(true);
        }}
        disabled={disabled}
        data-testid={`button-marche-pv-${marche.id}`}
      >
        <FileCheck size={12} />
        <span className="text-[9px] font-bold uppercase tracking-widest">PV</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
              PV de réception
            </DialogTitle>
          </DialogHeader>
          {approved ? (
            <div className="space-y-2" data-testid="pv-approved-summary">
              <p className="text-[12px] text-foreground">
                PV approuvé — réception des travaux le {marche.receptionDate}.
              </p>
              {marche.pvDocumentFileName && (
                <p className="text-[11px] text-muted-foreground">Document : {marche.pvDocumentFileName}</p>
              )}
              {marche.pvAttestationNote && (
                <p className="text-[11px] text-muted-foreground">Attestation : {marche.pvAttestationNote}</p>
              )}
              <p className="text-[10px] text-muted-foreground">
                Le PV approuvé est définitif ; la date de réception est verrouillée.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <TechnicalLabel>Date de réception</TechnicalLabel>
                <Input
                  type="date"
                  value={receptionDate}
                  onChange={(e) => setReceptionDate(e.target.value)}
                  data-testid="input-pv-reception-date"
                />
              </div>
              <div>
                <TechnicalLabel>Document PV (PDF signé)</TechnicalLabel>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="file"
                    id={`pv-file-${marche.id}`}
                    className="hidden"
                    accept="application/pdf,image/*"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const resp = await uploadFile(file);
                      if (resp) setUploaded({ storageKey: resp.objectPath, fileName: file.name });
                      e.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isUploading}
                    onClick={() => document.getElementById(`pv-file-${marche.id}`)?.click()}
                    data-testid="button-pv-upload"
                  >
                    <Upload size={12} />
                    <span className="text-[9px] font-bold uppercase tracking-widest">
                      {isUploading ? "Téléversement…" : "Téléverser"}
                    </span>
                  </Button>
                  {uploaded && (
                    <span className="text-[11px] text-muted-foreground truncate" data-testid="text-pv-file-name">
                      {uploaded.fileName}
                    </span>
                  )}
                </div>
              </div>
              <div>
                <TechnicalLabel>Ou attestation manuelle (PV papier)</TechnicalLabel>
                <Textarea
                  value={attestationNote}
                  onChange={(e) => setAttestationNote(e.target.value)}
                  placeholder="ex. PV signé le 10/02/2026, classé au dossier chantier"
                  rows={2}
                  data-testid="input-pv-attestation"
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                Le certificat de solde reste bloqué tant que le PV n'est pas approuvé. L'approbation
                verrouille la date de réception (GPA / libération RG).
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  className="flex-1"
                  variant="outline"
                  disabled={!canSaveDraft || saveDraftMutation.isPending}
                  onClick={() => saveDraftMutation.mutate()}
                  data-testid="button-pv-save-draft"
                >
                  {saveDraftMutation.isPending ? "Enregistrement…" : "Enregistrer le brouillon"}
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  disabled={marche.pvReceptionStatus !== "draft" || approveMutation.isPending}
                  onClick={() => approveMutation.mutate()}
                  data-testid="button-pv-approve"
                >
                  {approveMutation.isPending ? "Approbation…" : "Approuver le PV"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
