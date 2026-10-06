import { useState, useMemo, useEffect, useRef } from "react";
import { ArchitectInvoiceBadge } from "@/components/certificats/ArchitectInvoiceSection";
import { useInvoiceAwareCertificatSend } from "@/hooks/use-invoice-aware-certificat-send";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { CertificateRefBadge } from "@/components/ui/certificate-ref-badge";
import { FileCheck, Plus, Eye, ChevronRight, ExternalLink, RefreshCw, Download, AlertTriangle, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CertificatDetailDialog } from "@/components/certificats/CertificatDetailDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, projectScopedKey, ApiError } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import type { Project, Contractor, Certificat, CertificatPayment, Invoice, Marche, Devis } from "@shared/schema";
import {
  canSendCertificat,
  hasCertificatDeliveryEvidence,
  isFalseSentCertificat,
  type CertificatWithDelivery,
} from "@/lib/certificat-delivery";

type CertificatWithSentInfo = CertificatWithDelivery;
import { z } from "zod";
import {
  AutomaticTvaFields,
  type ManualCertificatPreview,
} from "@/components/certificats/AutomaticTvaFields";
import {
  ManualCertificateTotals,
  RetentionReview,
} from "@/components/certificats/ManualCertificateTotals";
import {
  manualCertificatPreviewKey,
  manualCertificatPreviewQueryOptions,
} from "@/lib/manual-certificat-preview";

import { Amount } from "@/components/ui/amount";
import { formatCurrency as fmt } from "@/lib/utils";

const certificatFormSchema = z.object({
  projectId: z.number().int().positive(),
  contractorId: z.number().int().positive("Select a contractor"),
  contextDevisId: z.number().int().positive("Select a signed quotation"),
  dateIssued: z.string().nullable(),
  totalWorksAmount: z.string().min(1, "Works amount is required"),
  totalWorksAmountBasis: z.enum(["ht", "ttc"]),
  pvMvAdjustment: z.string().default("0.00"),
  previousPayments: z.string().default("0.00"),
  status: z.enum(["draft", "ready", "paid"]).default("draft"),
  notes: z.string().nullable(),
  // Task #243 — optional architect overrides of the auto-computed cumulative
  // deductions. Sent to the server, never persisted as columns.
  retenueOverride: z.string().optional(),
  prorataOverride: z.string().optional(),
  isSolde: z.boolean().optional(),
  // Task #464 — solde designation + explicit retenue de garantie release.
  // `releaseRetenue`/`releaseReason` are request fields (the server derives
  // the released state, amount and date authoritatively).
  releaseRetenue: z.boolean().optional(),
  releaseReason: z.string().optional(),
  // Task #566 — audited override of the PV de réception gate. Only relevant
  // on a solde certificat whose marché has no approved PV; the server stamps
  // who/when authoritatively.
  pvOverrideReason: z.string().optional(),
});

type CertificatFormValues = z.infer<typeof certificatFormSchema>;



export default function Certificats() {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Task #496 — arriving from an invoice's "Certifié" badge pre-selects the project.
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("projectId");
    return fromUrl && /^\d+$/.test(fromUrl) ? fromUrl : "";
  });
  // Task #498 — deep-link: certificatId from URL opens the detail dialog once data loads.
  const [deepLinkCertId] = useState<number | null>(() => {
    const raw = new URLSearchParams(window.location.search).get("certificatId");
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  });
  const [viewingCert, setViewingCert] = useState<CertificatWithSentInfo | null>(null);
  const { toast } = useToast();

  const { data: projects, isLoading: loadingProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const { data: contractors } = useQuery<Contractor[]>({
    queryKey: ["/api/contractors"],
  });

  const { data: allCertificats, isLoading: loadingCerts } = useQuery<CertificatWithSentInfo[]>({
    queryKey: ["/api/projects", String(selectedProjectId), "certificats"],
    enabled: !!selectedProjectId,
  });

  const { data: projectInvoices } = useQuery<Invoice[]>({
    queryKey: ["/api/projects", String(selectedProjectId), "invoices"],
    enabled: !!selectedProjectId,
  });

  // Task #465 — project-wide payment ledger for list badges (paid-to-date /
  // partial). Detail-level reconciliation lives in CertificatPaymentsSection.
  const { data: projectPayments } = useQuery<CertificatPayment[]>({
    queryKey: ["/api/projects", String(selectedProjectId), "certificat-payments"],
    enabled: !!selectedProjectId,
  });
  const paidByCert = useMemo(() => {
    const map = new Map<number, number>();
    for (const p of projectPayments ?? []) {
      map.set(p.certificatId, (map.get(p.certificatId) ?? 0) + parseFloat(p.amount));
    }
    return map;
  }, [projectPayments]);

  const { data: marches } = useQuery<Marche[]>({
    queryKey: ["/api/projects", String(selectedProjectId), "marches"],
    enabled: !!selectedProjectId,
  });

  // Task #462 — needed to compute the paid deposit (acompte) to recoup.
  const { data: projectDevis } = useQuery<Devis[]>({
    queryKey: ["/api/projects", String(selectedProjectId), "devis"],
    enabled: !!selectedProjectId,
  });

  const form = useForm<CertificatFormValues>({
    resolver: zodResolver(certificatFormSchema),
    defaultValues: {
      projectId: 0,
      contractorId: 0,
      contextDevisId: 0,
      dateIssued: null,
      totalWorksAmount: "0.00",
      totalWorksAmountBasis: "ht",
      pvMvAdjustment: "0.00",
      previousPayments: "0.00",
      status: "draft",
      notes: null,
      retenueOverride: undefined,
      prorataOverride: undefined,
    },
  });

  const selectedProject = useMemo(
    () => projects?.find((p) => String(p.id) === selectedProjectId),
    [projects, selectedProjectId],
  );

  // Task #498 — once the certificat list loads, auto-open the one from the URL.
  // Use a ref to consume the deep-link exactly once; closing the dialog must not reopen it.
  const deepLinkConsumed = useRef(false);
  useEffect(() => {
    if (!deepLinkCertId || !allCertificats || deepLinkConsumed.current) return;
    const target = allCertificats.find((c) => c.id === deepLinkCertId);
    if (target) {
      deepLinkConsumed.current = true;
      setViewingCert(target);
    }
  }, [deepLinkCertId, allCertificats]);

  const watchContractorId = form.watch("contractorId");
  const watchContextDevisId = form.watch("contextDevisId");
  const watchTotalWorksAmount = form.watch("totalWorksAmount");
  const watchTotalWorksAmountBasis = form.watch("totalWorksAmountBasis");
  const watchPvMv = form.watch("pvMvAdjustment");
  const watchPrevious = form.watch("previousPayments");
  const watchRetenueOverride = form.watch("retenueOverride");
  const watchProrataOverride = form.watch("prorataOverride");
  // Task #464 — solde designation + explicit retenue release (live preview).
  const watchIsSolde = form.watch("isSolde");
  const watchReleaseRetenue = form.watch("releaseRetenue");

  const selectedMarche = useMemo(
    () => marches?.find((m) => m.contractorId === watchContractorId) ?? null,
    [marches, watchContractorId],
  );
  const selectedContractor = useMemo(
    () => contractors?.find((c) => c.id === watchContractorId) ?? null,
    [contractors, watchContractorId],
  );

  // Task #457 — superseded certificats were replaced by a reissue; their
  // cumulative figures must not feed the live preview (mirrors the server
  // resolver's exclusion). Task #491 — acompte certificats sit outside the
  // progress waterfall (zero cumulatives), so they too are excluded, exactly
  // like the server resolver.
  const priorCerts = useMemo(
    () =>
      (allCertificats ?? []).filter(
        (c) => c.contractorId === watchContractorId && c.status !== "superseded" && c.acompteDevisId == null,
      ),
    [allCertificats, watchContractorId],
  );

  // Mirror the server-authoritative resolver (server/services/certificat-
  // deductions.service.ts): both retenueGarantie and cumulativeProrataDeduction
  // store the cumulative-to-date figure, so the *latest* prior certificat carries
  // the true prior cumulative state. Reading the latest row (not max()/sum())
  // keeps this live preview consistent with the persisted server values even when
  // a downward override or a guarantee/exemption transition legitimately lowers
  // the cumulative. Order by issue date, then id as a stable tiebreaker.
  // Task #462 — total deposit actually PAID on this contractor's devis and
  // not yet recovered elsewhere ('paid' only — 'applied' means the deposit
  // was already deducted through the invoice path); mirrors the server
  // resolver's filter so the live preview matches the persisted figures.
  const paidAcompteAmount = useMemo(
    () =>
      (projectDevis ?? [])
        .filter((d) =>
          d.contractorId === watchContractorId &&
          d.status !== "void" &&
          d.signOffStage !== "void" &&
          d.acompteState === "paid",
        )
        .reduce((sum, d) => sum + (parseFloat(d.acompteAmountHt ?? "0") || 0), 0),
    [projectDevis, watchContractorId],
  );

  // Task #464 — an existing non-superseded solde certificat blocks a second
  // one for the same (project, contractor) pair.
  const existingSolde = useMemo(
    () => priorCerts.find((c) => c.isSolde && c.status !== "superseded") ?? null,
    [priorCerts],
  );

  const manualPreviewQuery = useQuery<ManualCertificatPreview>({
    queryKey: manualCertificatPreviewKey(
      selectedProjectId ?? "",
      watchContextDevisId,
      watchContractorId,
      watchTotalWorksAmount,
      watchTotalWorksAmountBasis,
      watchPvMv,
      watchPrevious,
      watchRetenueOverride,
      watchProrataOverride,
      watchIsSolde,
      watchReleaseRetenue,
      form.watch("pvOverrideReason"),
    ),
    queryFn: async () => {
      const response = await apiRequest(
        "POST",
        `/api/projects/${selectedProjectId}/certificats/manual-preview`,
        {
          contractorId: watchContractorId,
          contextDevisId: watchContextDevisId,
          totalWorksAmount: watchTotalWorksAmount,
          totalWorksAmountBasis: watchTotalWorksAmountBasis,
          pvMvAdjustment: watchPvMv,
          previousPayments: watchPrevious,
          retenueOverride: watchRetenueOverride || undefined,
          prorataOverride: watchProrataOverride || undefined,
          isSolde: watchIsSolde,
          releaseRetenue: watchReleaseRetenue,
          pvOverrideReason: form.getValues("pvOverrideReason") || undefined,
        },
      );
      return response.json();
    },
    enabled:
      dialogOpen &&
      !!selectedProjectId &&
      watchContractorId > 0 &&
      watchContextDevisId > 0 &&
      watchTotalWorksAmount !== "" &&
      Number.isFinite(Number(watchTotalWorksAmount)),
    retry: false,
    ...manualCertificatPreviewQueryOptions,
  });
  const createMutation = useMutation({
    mutationFn: async (data: CertificatFormValues) => {
      const res = await apiRequest("POST", `/api/projects/${data.projectId}/certificats`, data);
      return res.json() as Promise<Certificat>;
    },
    onSuccess: (created, data) => {
      queryClient.invalidateQueries({ queryKey: projectScopedKey(data.projectId, "certificats") });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(data.projectId, "certificats", "next-ref") });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(data.projectId, "financial-summary") });
      setDialogOpen(false);
      form.reset();
      toast({
        title: `Certificat ${created.certificateRef} created successfully`,
        description: "This reference was assigned by the server on creation.",
      });
    },
    onError: (error: Error) => {
      // Task #566 — final-payment gate: solde refused without an approved PV
      // de réception (or a recorded, motivated override).
      if (error instanceof ApiError && error.status === 422 && error.code === "PV_RECEPTION_REQUIRED") {
        toast({
          title: "PV de réception requis",
          description: error.message,
          variant: "destructive",
          duration: 12000,
        });
        return;
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/certificats/${id}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "certificats"] });
      if (selectedProjectId) {
        queryClient.invalidateQueries({ queryKey: projectScopedKey(selectedProjectId, "financial-summary") });
      }
      toast({ title: "Status updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const sendMutation = useInvoiceAwareCertificatSend<unknown, CertificatWithSentInfo>({
    target: (cert) => ({ projectId: cert.projectId, certId: cert.id }),
    onSuccess: (_communication, cert) => {
      queryClient.invalidateQueries({ queryKey: projectScopedKey(cert.projectId, "certificats") });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(cert.projectId, "communications") });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(cert.projectId, "financial-summary") });
      queryClient.invalidateQueries({ queryKey: ["/api/certificats/unsent"] });
      toast({ title: "Certificat sent", description: cert.certificateRef });
    },
    onError: (error: Error) => {
      toast({ title: "Send failed", description: error.message, variant: "destructive" });
    },
  });

  // Task #457 — one-click reissue of a sealed certificat. The server clones
  // it into a new draft (next ref, financials pre-filled) and marks the
  // original superseded; both remain visible and downloadable.
  const reissueMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/certificats/${id}/reissue`);
      return res.json() as Promise<Certificat>;
    },
    onSuccess: (draft) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "certificats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "certificats", "next-ref"] });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(draft.projectId, "financial-summary") });
      toast({
        title: `Reissued as ${draft.certificateRef}`,
        description: "A new draft was created with the financials pre-filled; the original is now marked superseded.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Reissue failed", description: error.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: CertificatFormValues) => {
    if (
      manualPreviewQuery.isFetching ||
      manualPreviewQuery.error ||
      !manualPreviewQuery.data
    ) {
      return;
    }
    createMutation.mutate(data);
  };

  const openCreate = () => {
    if (!selectedProjectId) {
      toast({ title: "Please select a project first", variant: "destructive" });
      return;
    }
    const totalInvoicesHt = (projectInvoices ?? []).reduce((sum, inv) => sum + parseFloat(inv.amountHt), 0);
    form.reset({
      projectId: parseInt(selectedProjectId),
      contractorId: 0,
      contextDevisId: 0,
      dateIssued: null,
      totalWorksAmount: totalInvoicesHt.toFixed(2),
      totalWorksAmountBasis: "ht",
      pvMvAdjustment: "0.00",
      previousPayments: "0.00",
      status: "draft",
      notes: null,
      retenueOverride: undefined,
      prorataOverride: undefined,
      isSolde: false,
      releaseRetenue: false,
      releaseReason: undefined,
      pvOverrideReason: undefined,
    });
    setDialogOpen(true);
  };

  const getContractorName = (id: number) => {
    return contractors?.find((c) => c.id === id)?.name ?? `#${id}`;
  };

  const getNextStatus = (current: string): string | null => {
    const flow: Record<string, string> = { draft: "ready", sent: "paid" };
    return flow[current] ?? null;
  };

  const getNextStatusLabel = (current: string): string | null => {
    const labels: Record<string, string> = { draft: "Mark Ready", sent: "Mark Paid" };
    return labels[current] ?? null;
  };

  const isLoading = loadingProjects || loadingCerts;

  return (
    <AppLayout>
      {sendMutation.confirmationDialog}
      <div className="space-y-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
            Certificats de Paiement
          </h1>
          <Button onClick={openCreate} data-testid="button-new-certificat">
            <Plus size={14} />
            <span className="text-[9px] font-bold uppercase tracking-widest">New Certificat</span>
          </Button>
        </div>

        <SectionHeader
          icon={FileCheck}
          title="All Certificats"
          subtitle="Payment certificate management"
        />

        <div className="max-w-xs">
          <TechnicalLabel>Filter by project</TechnicalLabel>
          <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
            <SelectTrigger className="mt-1" data-testid="select-project-filter">
              <SelectValue placeholder="Select a project" />
            </SelectTrigger>
            <SelectContent>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.code} — {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!selectedProjectId ? (
          <LuxuryCard data-testid="card-no-project-selected">
            <p className="text-[12px] text-muted-foreground text-center py-8">
              Select a project to view its Certificats de Paiement.
            </p>
          </LuxuryCard>
        ) : isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <LuxuryCard key={i}>
                <Skeleton className="h-4 w-32 mb-2" />
                <Skeleton className="h-3 w-48" />
              </LuxuryCard>
            ))}
          </div>
        ) : allCertificats && allCertificats.length > 0 ? (
          <div className="space-y-3">
            {allCertificats.map((cert) => {
              const delivered = hasCertificatDeliveryEvidence(cert);
              const falseSent = isFalseSentCertificat(cert);
              const canSend = canSendCertificat(cert);
              const nextStatus = getNextStatus(cert.status);
              const nextLabel = getNextStatusLabel(cert.status);
              // Task #465 — sealed certificats flip to paid via the payment
              // ledger only; the manual "Mark Paid" shortcut is replaced by
              // opening the detail (where payments get logged).
              const paidToDate = paidByCert.get(cert.id) ?? 0;
              const totalTtc = parseFloat(cert.netToPayTtc);
              const partiallyPaid = cert.status !== "paid" && paidToDate > 0;
              const sealedPaidFlip = nextStatus === "paid" && !!cert.pdfStorageKey;
              // Task #487 — flag missing BIC on unsent certs so the architect
              // can chase the contractor before the client receives the PDF.
              const certContractor = contractors?.find((c) => c.id === cert.contractorId);
              const isSupplierCert = cert.certificateTrack === "supplier_direct_payment";
              const missingBic = !isSupplierCert && certContractor && !certContractor.bic && (cert.status === "draft" || cert.status === "ready");
              // Task #609 — flag missing IBAN (harder blocker: preview and
              // issuance are entirely refused without an IBAN).
              const missingIban = !isSupplierCert && certContractor && !certContractor.iban && (cert.status === "draft" || cert.status === "ready");
              return (
                <LuxuryCard key={cert.id} data-testid={`card-certificat-${cert.id}`}>
                  <ArchitectInvoiceBadge certId={cert.id} />
                  {missingIban && (
                    <div
                      className="flex items-start gap-2 rounded-md border border-red-300/70 dark:border-red-500/30 bg-red-50/70 dark:bg-red-950/20 px-3 py-2 mb-3"
                      data-testid={`warning-iban-missing-card-${cert.id}`}
                    >
                      <AlertTriangle size={12} className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
                      <p className="text-[11px] text-red-800 dark:text-red-300 leading-snug">
                        <span className="font-semibold">{certContractor.name}</span> n&apos;a pas d&apos;IBAN enregistré — la prévisualisation et l&apos;émission du certificat seront bloquées.{" "}
                        <a href="/contractors" className="underline font-semibold hover:opacity-80">
                          Gérer les coordonnées bancaires
                        </a>
                      </p>
                    </div>
                  )}
                  {missingBic && (
                    <div
                      className="flex items-start gap-2 rounded-md border border-amber-300/70 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2 mb-3"
                      data-testid={`warning-bic-missing-card-${cert.id}`}
                    >
                      <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      <p className="text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                        <span className="font-semibold">{certContractor.name}</span> has no SWIFT/BIC on file — the
                        certificat will print &quot;NON COMMUNIQUÉ PAR L&apos;ÉTABLISSEMENT&quot;.{" "}
                        <a href="/contractors" className="underline font-semibold hover:opacity-80">
                          Manage banking details
                        </a>
                      </p>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-4 flex-wrap">
                      <div>
                        <CertificateRefBadge data-testid={`text-cert-ref-${cert.id}`}>{cert.certificateRef}</CertificateRefBadge>
                        {isSupplierCert && (
                          <span className="mt-1 inline-flex rounded-full border border-emerald-700/30 bg-emerald-700/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-emerald-800" data-testid={`badge-certificate-track-${cert.id}`}>
                            Paiement direct fournisseur
                          </span>
                        )}
                        <p className="text-[12px] text-foreground mt-0.5">
                          {isSupplierCert
                            ? cert.supplierPresentation?.supplier.name ??
                              getContractorName(cert.contractorId)
                            : getContractorName(cert.contractorId)}
                        </p>
                        {cert.dateIssued && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">{cert.dateIssued}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="text-right">
                        <span className="text-[14px] font-semibold text-foreground" data-testid={`text-cert-amount-${cert.id}`}>
                          <Amount value={parseFloat(cert.netToPayTtc)} denomination="TTC" />
                        </span>
                      </div>
                      {partiallyPaid && (
                        <span
                          className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                          data-testid={`badge-cert-partial-${cert.id}`}
                          title={`Encaissé ${fmt(paidToDate)} sur ${fmt(totalTtc)}`}
                        >
                          Partiel <Amount value={paidToDate} denomination="TTC" />
                        </span>
                      )}
                      <StatusBadge status={cert.status} />
                      {falseSent && (
                        <span
                          className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                          data-testid={`badge-cert-not-emailed-${cert.id}`}
                        >
                          Not emailed
                        </span>
                      )}
                      {delivered && (
                        <span
                          className="text-[9px] text-muted-foreground"
                          data-testid={`text-cert-sent-info-${cert.id}`}
                          title={`Envoyé à ${cert.sentToEmail}`}
                        >
                          Envoyé à <span className="font-semibold text-foreground">{cert.sentToEmail}</span>{" "}
                          le {new Date(cert.sentAt!).toLocaleDateString("fr-FR")}
                        </span>
                      )}
                      {cert.driveWebViewLink && (
                        <a
                          href={cert.driveWebViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-[11px] font-bold uppercase tracking-widest hover:bg-accent hover:text-accent-foreground"
                          data-testid={`link-view-on-drive-cert-${cert.id}`}
                          title="Open in Renosud shared Drive"
                        >
                          <ExternalLink size={11} />
                          Drive
                        </a>
                      )}
                      {cert.pdfStorageKey && (
                        <a
                          href={`/api/certificats/${cert.id}/pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-[11px] font-bold uppercase tracking-widest hover:bg-accent hover:text-accent-foreground"
                          data-testid={`link-cert-pdf-${cert.id}`}
                          title="Download the pinned issued PDF"
                        >
                          <Download size={11} />
                          PDF
                        </a>
                      )}
                      {cert.pdfStorageKey && cert.status !== "superseded" && (
                        <Button
                          variant="outline"
                          onClick={() => reissueMutation.mutate(cert.id)}
                          disabled={reissueMutation.isPending}
                          data-testid={`button-reissue-cert-${cert.id}`}
                          title="Create a corrected draft and mark this certificat superseded"
                        >
                          <RefreshCw size={12} />
                          <span className="text-[8px] font-bold uppercase tracking-widest">Reissue</span>
                        </Button>
                      )}
                      {canSend && (
                        <Button
                          variant="outline"
                          onClick={() => sendMutation.mutate(cert)}
                          disabled={sendMutation.isPending}
                          data-testid={`button-send-cert-${cert.id}`}
                        >
                          {sendMutation.isPending ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Send size={12} />
                          )}
                          <span className="text-[8px] font-bold uppercase tracking-widest">Send to client</span>
                        </Button>
                      )}
                      {nextStatus && nextLabel && (
                        sealedPaidFlip ? (
                          <Button
                            variant="outline"
                            onClick={() => setViewingCert(cert)}
                            data-testid={`button-log-payment-cert-${cert.id}`}
                            title="Enregistrez les paiements reçus — le statut basculera automatiquement une fois le montant TTC couvert."
                          >
                            <ChevronRight size={12} />
                            <span className="text-[8px] font-bold uppercase tracking-widest">Log Payment</span>
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            onClick={() => updateStatusMutation.mutate({ id: cert.id, status: nextStatus })}
                            disabled={updateStatusMutation.isPending}
                            data-testid={`button-advance-cert-${cert.id}`}
                          >
                            <ChevronRight size={12} />
                            <span className="text-[8px] font-bold uppercase tracking-widest">{nextLabel}</span>
                          </Button>
                        )
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setViewingCert(cert)}
                        data-testid={`button-view-cert-${cert.id}`}
                      >
                        <Eye size={14} />
                      </Button>
                    </div>
                  </div>
                </LuxuryCard>
              );
            })}
          </div>
        ) : (
          <LuxuryCard data-testid="card-empty-certificats">
            <p className="text-[12px] text-muted-foreground text-center py-8">
              No Certificats de Paiement for this project.
            </p>
          </LuxuryCard>
        )}

        {viewingCert && (
          <CertificatDetailDialog
            cert={viewingCert}
            contractor={contractors?.find((c) => c.id === viewingCert.contractorId)}
            onClose={() => setViewingCert(null)}
          />
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                New Certificat
              </DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="contractorId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Contractor</TechnicalLabel>
                      </FormLabel>
                      <Select
                        onValueChange={(val) => {
                          field.onChange(parseInt(val));
                          form.setValue("contextDevisId", 0);
                        }}
                        value={field.value ? String(field.value) : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-cert-contractor">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(contractors ?? []).filter((c) => !c.archidocOrphanedAt && c.archidocPartnerType !== "supplier").map((c) => (
                            <SelectItem key={c.id} value={String(c.id)}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="contextDevisId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Signed Quotation</TechnicalLabel>
                      </FormLabel>
                      <Select
                        onValueChange={(value) => {
                          const devisId = parseInt(value);
                          field.onChange(devisId);
                          const devis = projectDevis?.find(
                            (candidate) => candidate.id === devisId,
                          );
                          if (devis) {
                            form.setValue("contractorId", devis.contractorId);
                            form.setValue("totalWorksAmountBasis", "ht");
                            form.setValue("totalWorksAmount", devis.amountHt);
                          }
                        }}
                        value={field.value ? String(field.value) : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-cert-devis">
                            <SelectValue placeholder="Select a signed quotation" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(projectDevis ?? [])
                            .filter(
                              (devis) =>
                                devis.contractorId === watchContractorId &&
                                devis.status !== "void" &&
                                devis.signOffStage === "client_signed_off",
                            )
                            .map((devis) => (
                              <SelectItem key={devis.id} value={String(devis.id)}>
                                {devis.devisNumber ?? `Devis #${devis.id}`} —{" "}
                                {fmt(parseFloat(devis.amountHt))} HT /{" "}
                                {fmt(parseFloat(devis.amountTtc))} TTC
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {/* Task #487 — non-blocking BIC warning in the create form */}
                {selectedContractor && !selectedContractor.bic && (
                  <div
                    className="flex items-start gap-2 rounded-md border border-amber-300/70 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2"
                    data-testid="warning-bic-missing-form"
                  >
                    <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <p className="text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                      <span className="font-semibold">{selectedContractor.name}</span> has no SWIFT/BIC on file — the
                      certificat will print &quot;NON COMMUNIQUÉ PAR L&apos;ÉTABLISSEMENT&quot; in the payment panel.{" "}
                      <a
                        href="/contractors"
                        className="underline font-semibold hover:opacity-80"
                        data-testid="link-bic-missing-contractors"
                      >
                        Manage banking details
                      </a>
                    </p>
                  </div>
                )}
                <div className="p-3 rounded-md border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                  <TechnicalLabel>Certificate Reference</TechnicalLabel>
                  <p className="text-[14px] font-semibold text-foreground mt-1" data-testid="text-cert-ref-assignment">
                    Assigned on creation
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    The server assigns the next available project reference when you create the certificat.
                  </p>
                </div>
                <FormField
                  control={form.control}
                  name="dateIssued"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Issue Date</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) => field.onChange(e.target.value || null)}
                          data-testid="input-cert-date"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <AutomaticTvaFields
                  enteredAmount={watchTotalWorksAmount}
                  basis={watchTotalWorksAmountBasis}
                  preview={manualPreviewQuery.data}
                  isLoading={manualPreviewQuery.isFetching}
                  error={manualPreviewQuery.error}
                  onEdit={(basis, value) => {
                    form.setValue("totalWorksAmountBasis", basis, {
                      shouldValidate: true,
                    });
                    form.setValue("totalWorksAmount", value, {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                  }}
                  testIdPrefix="input-cert-total-works"
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="pvMvAdjustment"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>PV/MV Adjustment (HT)</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? "0.00"}
                            type="number"
                            step="0.01"
                            data-testid="input-cert-pvmv"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="previousPayments"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Previous net certified cumulative HT</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? "0.00"}
                            type="number"
                            step="0.01"
                            data-testid="input-cert-previous"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="retenueOverride"
                  render={({ field }) => (
                    <RetentionReview
                      preview={manualPreviewQuery.data}
                      isLoading={manualPreviewQuery.isFetching}
                      error={manualPreviewQuery.error}
                      value={field.value}
                      onChange={field.onChange}
                      inputId="input-cert-retenue-override"
                    />
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="prorataOverride"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Prorata Override (optional)</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            type="number"
                            step="0.01"
                            placeholder="Auto"
                            data-testid="input-cert-prorata-override"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Task #464 — solde designation + explicit retenue release. */}
                <div className="p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] space-y-3">
                  <FormField
                    control={form.control}
                    name="isSolde"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between gap-2 space-y-0">
                        <div>
                          <FormLabel>
                            <TechnicalLabel>Certificat de Solde (final)</TechnicalLabel>
                          </FormLabel>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            Un seul certificat de solde par marché
                            {existingSolde ? ` — ${existingSolde.certificateRef} existe déjà` : ""}
                          </p>
                        </div>
                        <FormControl>
                          <Switch
                            checked={field.value === true}
                            disabled={!!existingSolde}
                            onCheckedChange={(checked) => {
                              field.onChange(checked);
                              if (!checked) {
                                form.setValue("releaseRetenue", false);
                                form.setValue("releaseReason", undefined);
                                form.setValue("pvOverrideReason", undefined);
                              }
                            }}
                            data-testid="switch-cert-solde"
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  {watchIsSolde === true && (
                    <>
                      {/* Task #566 — PV de réception gate. The server refuses
                          a solde without an approved PV; surface the state
                          here and collect the motivated override if needed. */}
                      {!(selectedMarche?.pvReceptionStatus === "approved" && selectedMarche?.receptionDate) && (
                        <div
                          className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 space-y-2"
                          data-testid="warning-cert-pv-gate"
                        >
                          <div className="flex items-start gap-2">
                            <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                            <p className="text-[11px] text-amber-800 dark:text-amber-300">
                              {selectedMarche == null
                                ? "Aucun marché enregistré pour cette entreprise : le certificat de solde exige un PV de réception approuvé sur le marché."
                                : selectedMarche.pvReceptionStatus === "draft"
                                  ? "Le PV de réception du marché est en brouillon — approuvez-le (page projet, onglet Marché) ou saisissez une dérogation motivée."
                                  : "Aucun PV de réception approuvé sur le marché — enregistrez-le (page projet, onglet Marché) ou saisissez une dérogation motivée."}
                            </p>
                          </div>
                          <FormField
                            control={form.control}
                            name="pvOverrideReason"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>
                                  <TechnicalLabel>Dérogation motivée (audit)</TechnicalLabel>
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    {...field}
                                    value={field.value ?? ""}
                                    onChange={(e) => field.onChange(e.target.value || undefined)}
                                    placeholder="ex. Chantier réceptionné avant la mise en place des PV dans l'outil"
                                    data-testid="input-cert-pv-override-reason"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                      )}
                      <FormField
                        control={form.control}
                        name="releaseRetenue"
                        render={({ field }) => (
                          <FormItem className="flex items-center justify-between gap-2 space-y-0">
                            <div>
                              <FormLabel>
                                <TechnicalLabel>Libérer la Retenue de Garantie</TechnicalLabel>
                              </FormLabel>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                Par défaut la retenue reste conservée. La libération ajoute le cumul retenu au net à payer (après parfait achèvement ou caution bancaire).
                              </p>
                            </div>
                            <FormControl>
                              <Switch
                                checked={field.value === true}
                                onCheckedChange={field.onChange}
                                data-testid="switch-cert-release-retenue"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      {watchReleaseRetenue === true && (
                        <FormField
                          control={form.control}
                          name="releaseReason"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>
                                <TechnicalLabel>Raison de la libération (requis)</TechnicalLabel>
                              </FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  value={field.value ?? ""}
                                  onChange={(e) => field.onChange(e.target.value || undefined)}
                                  placeholder="ex. GPA expirée — parfait achèvement constaté"
                                  data-testid="input-cert-release-reason"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}
                    </>
                  )}
                </div>

                <ManualCertificateTotals
                  preview={manualPreviewQuery.data}
                  isLoading={manualPreviewQuery.isFetching}
                  error={manualPreviewQuery.error}
                />

                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Notes</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) => field.onChange(e.target.value || null)}
                          className="resize-none"
                          data-testid="input-cert-notes"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  className="w-full"
                  disabled={
                    createMutation.isPending ||
                    manualPreviewQuery.isFetching ||
                    !!manualPreviewQuery.error ||
                    !manualPreviewQuery.data
                  }
                  data-testid="button-submit-certificat"
                >
                  <span className="text-[9px] font-bold uppercase tracking-widest">
                    {createMutation.isPending ? "Creating..." : "Create Certificat"}
                  </span>
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
