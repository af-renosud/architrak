import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { MessageSquare, Send, FileCheck, Clock, AlertTriangle, Filter, ChevronDown, ChevronUp, PenLine, RefreshCw, Archive, ArchiveRestore, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  ContextEmailResendButton,
  parseDevisIdFromContextEmailDedupeKey,
} from "@/components/communications/ContextEmailResendButton";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Euro } from "lucide-react";
import type { ProjectCommunication, Project, CertificatPaymentSuggestion } from "@shared/schema";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

// Task #466 — open payment suggestions (client "paid" replies) surfaced in
// the hub. Confirm records the suggested amount/date as a source='email'
// ledger entry; finer edits live on the certificat detail dialog.
type SuggestionWithContext = { suggestion: CertificatPaymentSuggestion; certificateRef: string; projectName: string };

function PaymentSuggestionsPanel() {
  const { toast } = useToast();
  const { data: rows } = useQuery<SuggestionWithContext[]>({ queryKey: ["/api/certificat-payment-suggestions"] });
  // Task #570 — ambiguous suggestions (no payment keyword detected) are not
  // one-click confirmable; they open a review dialog with the email evidence.
  const [reviewing, setReviewing] = useState<SuggestionWithContext | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/certificat-payment-suggestions"] });

  const confirmMutation = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/certificat-payment-suggestions/${id}/confirm`, {})).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Paiement confirmé", description: "Enregistré au journal des paiements (source e-mail)." });
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const dismissMutation = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/certificat-payment-suggestions/${id}/dismiss`, {})).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Suggestion ignorée" });
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  if (!rows || rows.length === 0) return null;

  return (
    <LuxuryCard className="p-4 border-amber-300/60 dark:border-amber-500/30" data-testid="panel-payment-suggestions">
      <div className="flex items-center gap-2 mb-3">
        <Euro size={14} className="text-amber-600" />
        <TechnicalLabel>Paiements signalés par e-mail — à confirmer</TechnicalLabel>
      </div>
      <div className="space-y-3">
        {rows.map(({ suggestion: s, certificateRef, projectName }) => (
          <div key={s.id} className="flex items-start justify-between gap-3 border-t first:border-t-0 pt-3 first:pt-0" data-testid={`row-hub-suggestion-${s.id}`}>
            <div className="text-xs text-muted-foreground min-w-0">
              <p className="text-sm text-foreground font-semibold">
                {certificateRef} · {projectName} — {formatCurrency(parseFloat(s.suggestedAmount))}
              </p>
              <p>
                {s.kind === "contractor_received"
                  ? (s.status === "ambiguous" ? "Réponse entreprise à vérifier" : "Réception confirmée par l'entreprise")
                  : (s.status === "ambiguous" ? "Réponse client à vérifier" : "Paiement signalé par le client")}
                {" "}— {s.senderEmail} le {formatDate(s.emailDate)}
              </p>
              {s.matchedExcerpt && <p className="italic truncate">«&nbsp;{s.matchedExcerpt}&nbsp;»</p>}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => dismissMutation.mutate(s.id)}
                disabled={dismissMutation.isPending || confirmMutation.isPending}
                data-testid={`button-hub-dismiss-${s.id}`}
              >
                Ignorer
              </Button>
              {s.status === "ambiguous" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setReviewing({ suggestion: s, certificateRef, projectName })}
                  disabled={confirmMutation.isPending || dismissMutation.isPending}
                  data-testid={`button-hub-review-${s.id}`}
                >
                  Vérifier
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => confirmMutation.mutate(s.id)}
                  disabled={confirmMutation.isPending || dismissMutation.isPending}
                  data-testid={`button-hub-confirm-${s.id}`}
                >
                  Confirmer
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {reviewing && (
        <AmbiguousSuggestionReviewDialog
          row={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => {
            setReviewing(null);
            invalidate();
          }}
        />
      )}
    </LuxuryCard>
  );
}

// Task #570 — human review of an "ambiguous" suggestion: the classifier saw a
// reply on a payment thread but no clear payment keyword, so the architect
// must read the evidence and confirm explicitly (with editable details) or
// ignore. Confirming records the same source='email' ledger entry as the
// one-click path; the server stamps the audit entry as human-reviewed.
function AmbiguousSuggestionReviewDialog({
  row: { suggestion: s, certificateRef, projectName },
  onClose,
  onDone,
}: {
  row: SuggestionWithContext;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [datePaid, setDatePaid] = useState(s.suggestedDate);
  const [amount, setAmount] = useState(s.suggestedAmount);
  const [method, setMethod] = useState<"virement" | "cheque" | "autre">("virement");
  const [reference, setReference] = useState("");

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/certificat-payment-suggestions/${s.id}/confirm`, {
        datePaid,
        amount: amount.replace(",", "."),
        method,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
      return res.json() as Promise<{ fullyPaid: boolean; overpaid: boolean }>;
    },
    onSuccess: (r) => {
      onDone();
      toast({
        title: r.fullyPaid ? "Paiement confirmé — certificat soldé" : "Paiement confirmé",
        description: r.overpaid ? "Attention : le total encaissé dépasse le montant TTC." : "Enregistré au journal des paiements (source e-mail).",
        variant: r.overpaid ? "destructive" : undefined,
      });
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const dismissMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/certificat-payment-suggestions/${s.id}/dismiss`, {})).json(),
    onSuccess: () => {
      onDone();
      toast({ title: "Suggestion ignorée" });
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const amountValid = /^\d{1,10}([.,]\d{1,2})?$/.test(amount) && parseFloat(amount.replace(",", ".")) > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-testid="dialog-hub-suggestion-review">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-black uppercase tracking-tight">Vérifier la réponse — {certificateRef}</DialogTitle>
          <DialogDescription>
            {projectName} — aucun mot-clé de paiement n'a été détecté dans cette réponse. Lisez l'extrait ci-dessous et confirmez uniquement si le paiement est bien annoncé.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20 p-3 text-[12px] space-y-1">
            <p>
              <span className="font-semibold text-foreground">{s.senderEmail}</span>
              <span className="text-muted-foreground"> — le {formatDate(s.emailDate)}</span>
            </p>
            {s.matchedExcerpt ? (
              <p className="italic text-muted-foreground" data-testid="text-hub-review-excerpt">«&nbsp;{s.matchedExcerpt}&nbsp;»</p>
            ) : (
              <p className="text-muted-foreground" data-testid="text-hub-review-no-excerpt">Aucun extrait disponible — consultez l'e-mail dans Gmail avant de confirmer.</p>
            )}
            <p className="text-muted-foreground">
              {s.kind === "contractor_received" ? "Réception annoncée par l'entreprise" : "Paiement annoncé par le client"} — montant suggéré {formatCurrency(parseFloat(s.suggestedAmount))}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-widest">Date du paiement</Label>
              <Input type="date" value={datePaid} onChange={(e) => setDatePaid(e.target.value)} data-testid="input-hub-review-date" />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-widest">Montant (€)</Label>
              <Input type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="input-hub-review-amount" />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-widest">Moyen</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as "virement" | "cheque" | "autre")}>
                <SelectTrigger data-testid="select-hub-review-method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="virement">Virement</SelectItem>
                  <SelectItem value="cheque">Chèque</SelectItem>
                  <SelectItem value="autre">Autre</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-widest">Référence (optionnel)</Label>
              <Input value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} data-testid="input-hub-review-reference" />
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={() => dismissMutation.mutate()}
            disabled={dismissMutation.isPending || confirmMutation.isPending}
            data-testid="button-hub-review-dismiss"
          >
            Ignorer
          </Button>
          <Button
            onClick={() => confirmMutation.mutate()}
            disabled={confirmMutation.isPending || dismissMutation.isPending || !datePaid || !amountValid}
            data-testid="button-hub-review-confirm"
          >
            Confirmer le paiement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type FailedContractorNoticeGroup = {
  contractorId: number;
  contractorName: string;
  contractorEmail: string | null;
  failedCount: number;
  communicationIds: number[];
};

// Task #521 — surface failed contractor payment notices grouped by contractor
// so fixing the email + one click retries them all.
// Task #529 — archived reviewed suggestions, shown only in the Archives
// view, each restorable back into the certificat's history surfaces.
function ArchivedSuggestionsPanel() {
  const { toast } = useToast();
  const { data: rows } = useQuery<SuggestionWithContext[]>({ queryKey: ["/api/certificat-payment-suggestions/archived"] });

  const unarchiveMutation = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/certificat-payment-suggestions/${id}/unarchive`)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/certificat-payment-suggestions/archived"] });
      toast({ title: "Suggestion restaurée" });
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  if (!rows || rows.length === 0) return null;

  return (
    <LuxuryCard className="p-4" data-testid="panel-archived-suggestions">
      <div className="flex items-center gap-2 mb-3">
        <Archive size={14} className="text-muted-foreground" />
        <TechnicalLabel>Suggestions de paiement archivées</TechnicalLabel>
      </div>
      <div className="space-y-3">
        {rows.map(({ suggestion: s, certificateRef, projectName }) => (
          <div key={s.id} className="flex items-start justify-between gap-3 border-t first:border-t-0 pt-3 first:pt-0" data-testid={`row-archived-suggestion-${s.id}`}>
            <div className="text-xs text-muted-foreground min-w-0">
              <p className="text-sm text-foreground font-semibold">
                {certificateRef} · {projectName} — {formatCurrency(parseFloat(s.suggestedAmount))}
              </p>
              <p>
                {s.status === "confirmed" ? "Confirmée" : "Ignorée"}
                {s.reviewedAt ? ` le ${formatDate(s.reviewedAt)}` : ""} · {s.senderEmail}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="flex-shrink-0 gap-1.5"
              disabled={unarchiveMutation.isPending}
              onClick={() => unarchiveMutation.mutate(s.id)}
              data-testid={`button-unarchive-suggestion-${s.id}`}
            >
              <ArchiveRestore size={12} />
              Restaurer
            </Button>
          </div>
        ))}
      </div>
    </LuxuryCard>
  );
}

function FailedContractorNoticesPanel() {
  const { toast } = useToast();
  const { data: groups, isLoading } = useQuery<FailedContractorNoticeGroup[]>({
    queryKey: ["/api/failed-contractor-notices"],
  });

  const retryMutation = useMutation({
    mutationFn: async (contractorId: number) => {
      const res = await apiRequest("POST", `/api/contractors/${contractorId}/retry-failed-notices`, {});
      return res.json() as Promise<{ retried: number; succeeded: number; failed: number; firstError?: string }>;
    },
    onSuccess: (data, contractorId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/failed-contractor-notices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/communications"] });
      if (data.failed > 0) {
        toast({
          title: `${data.succeeded} relancé${data.succeeded !== 1 ? "s" : ""}, ${data.failed} échec${data.failed !== 1 ? "s" : ""}`,
          description: data.firstError ?? "Certains envois ont échoué — vérifiez l'adresse e-mail.",
          variant: "destructive",
        });
      } else {
        toast({
          title: `${data.succeeded} avis relancé${data.succeeded !== 1 ? "s" : ""}`,
          description: "Tous les avis ont été renvoyés avec succès.",
        });
      }
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  if (isLoading || !groups || groups.length === 0) return null;

  return (
    <LuxuryCard className="p-4 border-red-300/60 dark:border-red-500/30" data-testid="panel-failed-contractor-notices">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle size={14} className="text-red-600" />
        <TechnicalLabel>Avis entreprise en échec — relance disponible</TechnicalLabel>
      </div>
      <div className="space-y-3">
        {groups.map(group => (
          <div
            key={group.contractorId}
            className="flex items-center justify-between gap-3 border-t first:border-t-0 pt-3 first:pt-0"
            data-testid={`row-failed-notices-${group.contractorId}`}
          >
            <div className="text-xs text-muted-foreground min-w-0">
              <p className="text-sm text-foreground font-semibold">{group.contractorName}</p>
              <p>
                {group.failedCount} avis en échec
                {group.contractorEmail
                  ? ` · adresse actuelle : ${group.contractorEmail}`
                  : " · aucune adresse e-mail enregistrée"}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="flex-shrink-0 gap-1.5"
              disabled={retryMutation.isPending}
              onClick={() => retryMutation.mutate(group.contractorId)}
              data-testid={`button-retry-notices-${group.contractorId}`}
            >
              <RefreshCw size={12} />
              Renvoyer tout
            </Button>
          </div>
        ))}
      </div>
    </LuxuryCard>
  );
}

function formatDate(date: string | Date | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const typeIcons: Record<string, typeof Send> = {
  certificat_sent: FileCheck,
  certificat_contractor_notice: FileCheck,
  payment_chase: Clock,
  contractor_query: MessageSquare,
  client_update: Send,
  devis_signature_context: PenLine,
  general: MessageSquare,
};

const typeLabels: Record<string, string> = {
  certificat_sent: "Certificat Sent",
  certificat_contractor_notice: "Contractor Payment Notice",
  payment_chase: "Payment Chase",
  contractor_query: "Contractor Query",
  client_update: "Client Update",
  devis_signature_context: "Devis Signature Context",
  general: "General",
};

// Task #529 — guarded "fresh start": pick a cutoff, preview exactly what
// would be archived (sent communications + reviewed suggestions only),
// confirm, archive. Nothing is deleted; the Archives toggle shows it all.
function FreshStartDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const [cutoff, setCutoff] = useState<string>(() => new Date().toISOString().slice(0, 10));

  const { data: preview, isLoading: previewLoading } = useQuery<{ sentCommunications: number; reviewedSuggestions: number; token: string }>({
    queryKey: [`/api/communications/fresh-start/preview?cutoff=${cutoff}`],
    enabled: open && !!cutoff,
  });

  const archiveMutation = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/communications/fresh-start", {
        cutoff,
        // The run is bound to the previewed id set via this token: if
        // anything changed in between, the server archives nothing and
        // answers 409 with fresh counts.
        token: preview?.token ?? "",
      })).json() as Promise<{
        archivedCommunications: number;
        archivedSuggestions: number;
      }>,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/communications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/communications?view=archived"] });
      queryClient.invalidateQueries({ queryKey: ["/api/certificat-payment-suggestions/archived"] });
      onOpenChange(false);
      toast({
        title: "Archivage effectué",
        description: `${data.archivedCommunications} communication${data.archivedCommunications !== 1 ? "s" : ""} et ${data.archivedSuggestions} suggestion${data.archivedSuggestions !== 1 ? "s" : ""} archivées. Rien n'a été supprimé.`,
      });
    },
    onError: (error: Error) => {
      // 409 stale preview: refresh the counts so the operator re-confirms
      // against what is actually there now.
      queryClient.invalidateQueries({ queryKey: [`/api/communications/fresh-start/preview?cutoff=${cutoff}`] });
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const total = (preview?.sentCommunications ?? 0) + (preview?.reviewedSuggestions ?? 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-fresh-start">
        <DialogHeader>
          <DialogTitle>Repartir sur une base propre</DialogTitle>
          <DialogDescription>
            Archive les communications envoyées et les suggestions déjà traitées avant la date choisie.
            Les éléments en échec, en attente d'envoi ou à confirmer ne sont jamais archivés.
            Rien n'est supprimé — tout reste consultable via l'interrupteur «&nbsp;Archives&nbsp;».
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fresh-start-cutoff">Archiver tout ce qui est antérieur au</Label>
            <Input
              id="fresh-start-cutoff"
              type="date"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              data-testid="input-fresh-start-cutoff"
            />
          </div>
          <div className="text-sm text-muted-foreground" data-testid="text-fresh-start-preview">
            {previewLoading || !preview ? (
              "Calcul en cours…"
            ) : (
              <>
                Seront archivées&nbsp;: <span className="font-semibold text-foreground">{preview.sentCommunications}</span> communication{preview.sentCommunications !== 1 ? "s" : ""} envoyée{preview.sentCommunications !== 1 ? "s" : ""} et{" "}
                <span className="font-semibold text-foreground">{preview.reviewedSuggestions}</span> suggestion{preview.reviewedSuggestions !== 1 ? "s" : ""} déjà traitée{preview.reviewedSuggestions !== 1 ? "s" : ""}.
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="button-fresh-start-cancel">
            Annuler
          </Button>
          <Button
            onClick={() => archiveMutation.mutate()}
            disabled={archiveMutation.isPending || previewLoading || total === 0}
            data-testid="button-fresh-start-confirm"
          >
            <Archive size={14} className="mr-1.5" />
            Archiver {total > 0 ? `${total} élément${total !== 1 ? "s" : ""}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Communications() {
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showArchives, setShowArchives] = useState(false);
  const [freshStartOpen, setFreshStartOpen] = useState(false);
  const { toast } = useToast();

  // Default view = active (non-archived) items only; the Archives toggle
  // swaps the list to the archived set. Counters always reflect active.
  const { data: communications, isLoading } = useQuery<ProjectCommunication[]>({
    queryKey: ["/api/communications"],
  });
  const { data: archivedCommunications } = useQuery<ProjectCommunication[]>({
    queryKey: ["/api/communications?view=archived"],
    enabled: showArchives,
  });

  const invalidateComms = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/communications"] });
    queryClient.invalidateQueries({ queryKey: ["/api/communications?view=archived"] });
  };

  const archiveCommMutation = useMutation({
    mutationFn: async ({ id, archive }: { id: number; archive: boolean }) =>
      (await apiRequest("POST", `/api/communications/${id}/${archive ? "archive" : "unarchive"}`)).json(),
    onSuccess: (_data, vars) => {
      invalidateComms();
      toast({ title: vars.archive ? "Communication archivée" : "Communication restaurée" });
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const projectMap = new Map<number, Project>();
  projects?.forEach(p => projectMap.set(p.id, p));

  const displayed = showArchives ? archivedCommunications : communications;
  const filtered = displayed?.filter(comm => {
    if (typeFilter !== "all" && comm.type !== typeFilter) return false;
    if (statusFilter !== "all" && comm.status !== statusFilter) return false;
    return true;
  }) ?? [];

  const sentCount = communications?.filter(c => c.status === "sent").length ?? 0;
  const queuedCount = communications?.filter(c => c.status === "queued").length ?? 0;
  const draftCount = communications?.filter(c => c.status === "draft").length ?? 0;

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <Skeleton className="h-6 w-48" />
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full rounded-[2rem]" />)}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <SectionHeader icon={MessageSquare} title="Communication Hub" subtitle={`${communications?.length ?? 0} communications actives`} />
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch id="toggle-archives" checked={showArchives} onCheckedChange={setShowArchives} data-testid="switch-archives" />
              <Label htmlFor="toggle-archives" className="text-sm text-muted-foreground cursor-pointer">Archives</Label>
            </div>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setFreshStartOpen(true)} data-testid="button-fresh-start">
              <Sparkles size={14} />
              Repartir à zéro
            </Button>
          </div>
        </div>

        <FreshStartDialog open={freshStartOpen} onOpenChange={setFreshStartOpen} />

        {showArchives ? (
          <ArchivedSuggestionsPanel />
        ) : (
          <>
            <PaymentSuggestionsPanel />
            <FailedContractorNoticesPanel />
          </>
        )}

        <div className="grid grid-cols-4 gap-4">
          <LuxuryCard className="p-4 text-center">
            <TechnicalLabel>Actives</TechnicalLabel>
            <p className="text-2xl font-bold mt-1" data-testid="text-total-comms">{communications?.length ?? 0}</p>
          </LuxuryCard>
          <LuxuryCard className="p-4 text-center">
            <TechnicalLabel>Sent</TechnicalLabel>
            <p className="text-2xl font-bold mt-1 text-emerald-600" data-testid="text-sent-count">{sentCount}</p>
          </LuxuryCard>
          <LuxuryCard className="p-4 text-center">
            <TechnicalLabel>Queued</TechnicalLabel>
            <p className="text-2xl font-bold mt-1 text-amber-600" data-testid="text-queued-count">{queuedCount}</p>
          </LuxuryCard>
          <LuxuryCard className="p-4 text-center">
            <TechnicalLabel>Drafts</TechnicalLabel>
            <p className="text-2xl font-bold mt-1 text-slate-500" data-testid="text-draft-count">{draftCount}</p>
          </LuxuryCard>
        </div>

        <div className="flex items-center gap-3">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[180px]" data-testid="select-comm-type-filter">
              <Filter size={14} className="mr-1" />
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="certificat_sent">Certificat Sent</SelectItem>
              <SelectItem value="payment_chase">Payment Chase</SelectItem>
              <SelectItem value="contractor_query">Contractor Query</SelectItem>
              <SelectItem value="client_update">Client Update</SelectItem>
              <SelectItem value="devis_signature_context">Devis Signature Context</SelectItem>
              <SelectItem value="general">General</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]" data-testid="select-comm-status-filter">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="queued">Queued</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          {filtered.length === 0 ? (
            <LuxuryCard className="p-8 text-center">
              <MessageSquare size={32} className="mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No communications yet</p>
              <p className="text-xs text-muted-foreground mt-1">Send Certificats and chase payments from project detail pages</p>
            </LuxuryCard>
          ) : (
            filtered.map(comm => {
              const project = projectMap.get(comm.projectId);
              const IconComp = typeIcons[comm.type] || MessageSquare;
              const isExpanded = expandedId === comm.id;
              const contextEmailDevisId =
                comm.type === "devis_signature_context" && comm.status !== "sent"
                  ? parseDevisIdFromContextEmailDedupeKey(comm.dedupeKey)
                  : null;

              return (
                <LuxuryCard key={comm.id} className="p-4" data-testid={`card-comm-${comm.id}`}>
                  <div
                    className="flex items-start justify-between gap-4 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : comm.id)}
                  >
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 flex items-center justify-center flex-shrink-0">
                        <IconComp size={16} className="text-indigo-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold truncate">{comm.subject}</span>
                          <StatusBadge status={comm.status} size="sm" />
                          <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300">
                            {typeLabels[comm.type] || comm.type}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          <span>To: {comm.recipientName || comm.recipientEmail || "—"}</span>
                          <span className="mx-2">·</span>
                          <span>{comm.sentAt ? formatDate(comm.sentAt) : formatDate(comm.createdAt)}</span>
                          {project && (
                            <>
                              <span className="mx-2">·</span>
                              <Link href={`/projets/${project.id}`}>
                                <span className="text-blue-600 hover:underline cursor-pointer">{project.name}</span>
                              </Link>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {comm.status !== "queued" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          title={showArchives ? "Restaurer" : "Archiver"}
                          disabled={archiveCommMutation.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            archiveCommMutation.mutate({ id: comm.id, archive: !showArchives });
                          }}
                          data-testid={`button-archive-comm-${comm.id}`}
                        >
                          {showArchives ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                        </Button>
                      )}
                      {contextEmailDevisId !== null && (
                        <ContextEmailResendButton
                          devisId={contextEmailDevisId}
                          communicationId={comm.id}
                          projectId={comm.projectId}
                        />
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" data-testid={`button-toggle-comm-${comm.id}`}>
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </Button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="mt-4 pl-12 border-t pt-4">
                      <div className="text-sm whitespace-pre-wrap text-muted-foreground">
                        {comm.body || "No content"}
                      </div>
                      {comm.emailMessageId && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          Gmail Message ID: {comm.emailMessageId}
                        </div>
                      )}
                    </div>
                  )}
                </LuxuryCard>
              );
            })
          )}
        </div>
      </div>
    </AppLayout>
  );
}
