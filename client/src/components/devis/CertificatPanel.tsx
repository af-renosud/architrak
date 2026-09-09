import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Award, Send, Loader2, FileCheck2, LockKeyhole } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, projectScopedKey, ApiError } from "@/lib/queryClient";
import type { Devis, Certificat, Contractor, Invoice } from "@shared/schema";
import { CreateMultiCertificatDialog } from "@/components/factures/FacturesTab";
import {
  canSendCertificat,
  hasCertificatDeliveryEvidence,
  isFalseSentCertificat,
  type CertificatWithDelivery,
} from "@/lib/certificat-delivery";

type CertificatWithSentInfo = CertificatWithDelivery;

/**
 * Task #539 — per-devis certificat section, rendered immediately below the
 * electronic-signature panel so the workflow reads linearly:
 * devis → signature → certificat de paiement.
 *
 * Lists the certificats for this devis's contractor on this project and
 * exposes the SAME send action as the Communications tab (same endpoint,
 * same banking-gate error translation). Certificats are per contractor +
 * project (not per individual devis), which is also how the send endpoint
 * validates them.
 *
 * Visibility: hidden until the devis reaches the signing stages (same set
 * as SigningPanel) — earlier stages have nothing meaningful to show. Once
 * signed with no certificat yet, shows an explicit empty state pointing to
 * the existing creation flow.
 */
const STAGES_SHOWING_PANEL = new Set([
  "approved_for_signing",
  "sent_to_client",
  "client_signed_off",
  "void",
]);

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
  ready: { label: "Ready to send", className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200" },
  sent: { label: "Sent", className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" },
  paid: { label: "Paid", className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" },
  superseded: { label: "Superseded", className: "bg-muted text-muted-foreground line-through" },
};

function formatEur(value: string): string {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);
}

export function CertificatPanel({
  devisId,
  projectId,
  isArchived,
  onCreateManual,
}: {
  devisId: number;
  projectId: number | string;
  isArchived: boolean;
  onCreateManual?: (context: { contractorId: number; devisId: number }) => void;
}) {
  const { toast } = useToast();

  const devisQuery = useQuery<Devis>({ queryKey: ["/api/devis", devisId] });
  const d = devisQuery.data;
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [isRoutingCreation, setIsRoutingCreation] = useState(false);
  const invoicesQuery = useQuery<Invoice[]>({
    queryKey: projectScopedKey(projectId, "invoices"),
    enabled: Boolean(d),
  });
  const linksQuery = useQuery<Array<{ invoiceId: number }>>({
    queryKey: projectScopedKey(projectId, "certificat-invoice-links"),
    enabled: Boolean(d),
  });
  const contractorQuery = useQuery<Contractor[]>({
    queryKey: ["/api/contractors"],
    enabled: Boolean(d),
  });

  const certsQuery = useQuery<CertificatWithSentInfo[]>({
    queryKey: projectScopedKey(projectId, "certificats"),
    enabled: Boolean(d),
  });

  // Task #539 — the dashboard's unsent list shares the SAME server-side
  // definition; invalidated after every send so both surfaces agree.
  const sendMutation = useMutation({
    mutationFn: async (certId: number) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/certificats/${certId}/send`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Certificat sent" });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "certificats") });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "communications") });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "financial-summary") });
      queryClient.invalidateQueries({ queryKey: ["/api/certificats/unsent"] });
    },
    onError: (error: Error) => {
      // Task #566 — PV de réception gate on the solde certificat.
      if (error instanceof ApiError && error.status === 422 && error.code === "PV_RECEPTION_REQUIRED") {
        toast({
          title: "PV de réception requis",
          description: error.message,
          variant: "destructive",
          duration: 12000,
        });
        return;
      }
      // Same banking-gate translation as the Communications tab send.
      if (error instanceof ApiError && error.status === 422) {
        const data = error.data as { contractorName?: string } | undefined;
        toast({
          title: "Banking details issue",
          description:
            error.message +
            (data?.contractorName ? ` (${data.contractorName})` : ""),
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Send failed", description: error.message, variant: "destructive" });
    },
  });
  const eligibleInvoices = useMemo(() => {
    const linked = new Set((linksQuery.data ?? []).map((l) => l.invoiceId));
    return (invoicesQuery.data ?? []).filter((invoice) =>
      invoice.devisId === devisId &&
      invoice.contractorId === d?.contractorId &&
      invoice.id !== d?.acompteInvoiceId &&
      invoice.status === "approved" &&
      !invoice.datePaid &&
      !linked.has(invoice.id),
    );
  }, [
    invoicesQuery.data,
    linksQuery.data,
    devisId,
    d?.contractorId,
    d?.acompteInvoiceId,
  ]);

  const certs = useMemo<CertificatWithSentInfo[]>(() => {
    if (!d || !certsQuery.data) return [];
    return certsQuery.data.filter(
      (c) => c.contractorId === d.contractorId && c.status !== "superseded",
    );
  }, [d, certsQuery.data]);

  if (!d) return null;
  const stage = d.signOffStage as string | null | undefined;
  if (!stage || !STAGES_SHOWING_PANEL.has(stage)) return null;

  const isSignedOff = stage === "client_signed_off";
  // Nothing to say before sign-off if no certificat exists yet.
  if (certs.length === 0 && !isSignedOff) return null;
  const contractor = contractorQuery.data?.find((c) => c.id === d.contractorId);
  const isSupplier = contractor?.archidocPartnerType === "supplier";
  const contextIsLoading =
    contractorQuery.isLoading ||
    contractorQuery.isFetching ||
    invoicesQuery.isLoading ||
    invoicesQuery.isFetching ||
    linksQuery.isLoading ||
    linksQuery.isFetching ||
    isRoutingCreation;
  const hasInvoiceSources = eligibleInvoices.length > 0;
  const openCreate = () => {
    void (async () => {
      setIsRoutingCreation(true);
      try {
        // Project queries cache forever. Force a fresh read before choosing
        // sourced creation versus manual fallback.
        const [invoiceResult, linkResult, contractorResult] = await Promise.all([
          invoicesQuery.refetch(),
          linksQuery.refetch(),
          contractorQuery.refetch(),
        ]);
        const failed = [invoiceResult, linkResult, contractorResult].find(
          (result) => result.isError,
        );
        if (failed?.error) throw failed.error;

        const freshLinked = new Set(
          (linkResult.data ?? []).map((link) => link.invoiceId),
        );
        const freshEligible = (invoiceResult.data ?? []).filter(
          (invoice) =>
            invoice.devisId === devisId &&
            invoice.contractorId === d.contractorId &&
            invoice.id !== d.acompteInvoiceId &&
            invoice.status === "approved" &&
            invoice.datePaid == null &&
            !freshLinked.has(invoice.id),
        );
        if (freshEligible.length > 0) {
          setSourceDialogOpen(true);
          return;
        }

        const freshContractor = contractorResult.data?.find(
          (candidate) => candidate.id === d.contractorId,
        );
        if (freshContractor?.archidocPartnerType === "supplier") {
          toast({
            title: "Facture approuvée requise",
            description:
              "Ajoutez et approuvez une facture fournisseur avant de créer le certificat de paiement direct.",
            variant: "destructive",
          });
          return;
        }
        if (!freshContractor) {
          toast({
            title: "Entreprise introuvable",
            description: "Actualisez le projet puis réessayez.",
            variant: "destructive",
          });
          return;
        }
        onCreateManual?.({ contractorId: d.contractorId, devisId });
      } catch (error) {
        toast({
          title: "Impossible de préparer le certificat",
          description:
            error instanceof Error
              ? error.message
              : "Actualisez le projet puis réessayez.",
          variant: "destructive",
        });
      } finally {
        setIsRoutingCreation(false);
      }
    })();
  };
  const createLabel = hasInvoiceSources
    ? eligibleInvoices.length === 1
      ? "Review invoice source"
      : `Review ${eligibleInvoices.length} invoice sources`
    : isSupplier
      ? "No eligible invoices"
      : "Create in project";

  return (
    <LuxuryCard className="p-3 space-y-2" data-testid={`panel-certificat-${devisId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Award className="h-4 w-4 text-[#0B2545]" />
          <TechnicalLabel className="text-sm">Certificat de paiement</TechnicalLabel>
        </div>
        {isSignedOff && (
          <Button
            variant="outline"
            size="sm"
            disabled={
              isArchived ||
              contextIsLoading ||
              !contractor ||
              (isSupplier && !hasInvoiceSources) ||
              (!hasInvoiceSources && !onCreateManual)
            }
            onClick={openCreate}
            data-testid={`button-create-certificat-${devisId}`}
          >
            {contextIsLoading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : hasInvoiceSources ? (
              <FileCheck2 size={12} />
            ) : (
              <LockKeyhole size={12} />
            )}
            <span className="text-[9px] font-bold uppercase tracking-widest">
              {createLabel}
            </span>
          </Button>
        )}
      </div>

      {certs.length === 0 ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2"
          data-testid={`empty-certificat-${devisId}`}
        >
          <p className="text-[11px] text-amber-900 dark:text-amber-200">
            {isSupplier && !hasInvoiceSources
              ? "This supplier has no approved, unpaid invoice available for a payment certificate."
              : "The devis is signed but no certificat de paiement exists yet for this contractor."}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {certs.map((cert) => {
            const delivered = hasCertificatDeliveryEvidence(cert);
            const falseSent = isFalseSentCertificat(cert);
            const canSend = canSendCertificat(cert);
            const badge = STATUS_LABEL[cert.status] ?? {
              label: cert.status,
              className: "bg-muted text-muted-foreground",
            };
            return (
              <div
                key={cert.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
                data-testid={`row-devis-certificat-${cert.id}`}
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] font-semibold text-foreground truncate">
                      {cert.certificateRef}
                    </span>
                    <Badge className={`text-[9px] ${badge.className}`} data-testid={`badge-devis-cert-status-${cert.id}`}>
                      {badge.label}
                    </Badge>
                    {cert.isSolde && (
                      <Badge variant="outline" className="text-[9px]">Solde</Badge>
                    )}
                    {falseSent && (
                      <Badge
                        className="text-[9px] bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                        data-testid={`badge-devis-cert-not-emailed-${cert.id}`}
                      >
                        Not emailed
                      </Badge>
                    )}
                  </div>
                  {delivered && (
                    <span
                      className="text-[9px] text-muted-foreground"
                      data-testid={`text-devis-cert-sent-info-${cert.id}`}
                    >
                      Envoyé à {cert.sentToEmail} le {new Date(cert.sentAt!).toLocaleDateString("fr-FR")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-semibold text-foreground whitespace-nowrap">
                    {formatEur(cert.netToPayTtc)} <span className="text-[9px] text-muted-foreground font-normal">TTC</span>
                  </span>
                  {canSend && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={sendMutation.isPending || isArchived}
                      onClick={() => sendMutation.mutate(cert.id)}
                      data-testid={`button-devis-send-cert-${cert.id}`}
                    >
                      {sendMutation.isPending ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Send size={12} />
                      )}
                      <span className="text-[9px] font-bold uppercase tracking-widest">Send to client</span>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {sourceDialogOpen && contractor && (
        <CreateMultiCertificatDialog
          invoices={eligibleInvoices}
          contractorName={contractor.name}
          contractorIban={contractor.iban}
          projectId={String(projectId)}
          context={{
            projectLabel: `Projet #${projectId}`,
            devisLabel: d.devisCode || `Devis #${devisId}`,
          }}
          onClose={() => setSourceDialogOpen(false)}
          onCreated={() => {
            for (const segment of [
              "certificats",
              "financial-summary",
              "invoices",
              "certificat-invoice-links",
            ]) {
              queryClient.invalidateQueries({
                queryKey: projectScopedKey(projectId, segment),
              });
            }
          }}
        />
      )}
    </LuxuryCard>
  );
}
