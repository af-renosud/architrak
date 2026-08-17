import { useState, useMemo, useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { CertificateRefBadge } from "@/components/ui/certificate-ref-badge";
import { FileCheck, Plus, Eye, ChevronRight, ExternalLink, RefreshCw, Download, AlertTriangle } from "lucide-react";
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
import { apiRequest, queryClient, ApiError } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { insertCertificatSchema } from "@shared/schema";
import type { Project, Contractor, Certificat, CertificatPayment, Invoice, Marche, Devis } from "@shared/schema";

// Task #556 — server enriches "sent" certificats with the email evidence.
type CertificatWithSentInfo = Certificat & { sentAt?: string; sentToEmail?: string };
import { computeCertificatDeductions, computeEffectiveTvaRatePercent } from "@shared/financial-utils";
import { z } from "zod";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

const certificatFormSchema = insertCertificatSchema.extend({
  totalWorksHt: z.string().min(1, "Works HT amount is required"),
  netToPayHt: z.string().min(1, "Net to pay HT is required"),
  tvaAmount: z.string().min(1, "TVA amount is required"),
  netToPayTtc: z.string().min(1, "Net to pay TTC is required"),
  // Task #243 — optional architect overrides of the auto-computed cumulative
  // deductions. Sent to the server, never persisted as columns.
  retenueOverride: z.string().optional(),
  prorataOverride: z.string().optional(),
  // Task #463 — draft-only override of the applied TVA rate (%). Ignored by
  // the server on autoliquidation contracts.
  tvaRateOverride: z.string().optional(),
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

  const { data: nextRefData } = useQuery<{ nextRef: string }>({
    queryKey: ["/api/projects", String(selectedProjectId), "certificats", "next-ref"],
    enabled: !!selectedProjectId,
  });

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
      certificateRef: "",
      dateIssued: null,
      totalWorksHt: "0.00",
      pvMvAdjustment: "0.00",
      previousPayments: "0.00",
      retenueGarantie: "0.00",
      cumulativeProrataDeduction: "0.00",
      periodProrataDeduction: "0.00",
      netToPayHt: "0.00",
      tvaAmount: "0.00",
      netToPayTtc: "0.00",
      status: "draft",
      notes: null,
      retenueOverride: undefined,
      prorataOverride: undefined,
      tvaRateOverride: undefined,
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
  const watchTotalWorks = form.watch("totalWorksHt");
  const watchPvMv = form.watch("pvMvAdjustment");
  const watchPrevious = form.watch("previousPayments");
  const watchRetenueOverride = form.watch("retenueOverride");
  const watchProrataOverride = form.watch("prorataOverride");
  const watchTvaRateOverride = form.watch("tvaRateOverride");
  // Task #464 — solde designation + explicit retenue release (live preview).
  const watchIsSolde = form.watch("isSolde");
  const watchReleaseRetenue = form.watch("releaseRetenue");

  // Task #243 — the contractor's marché carries the Retenue de Garantie rate,
  // the bank-guarantee bypass and the prorata-manager exemption; the project
  // carries the Compte Prorata rate. We feed them to the SAME shared math the
  // server uses, so this live breakdown matches the authoritative figures.
  const selectedMarche = useMemo(
    () => marches?.find((m) => m.contractorId === watchContractorId) ?? null,
    [marches, watchContractorId],
  );
  const retenuePercent = selectedMarche?.retenueGarantiePercent != null
    ? parseFloat(selectedMarche.retenueGarantiePercent) : 5;
  const prorataPercent = parseFloat(selectedProject?.prorataPercentage ?? "0") || 0;
  const hasBankGuarantee = selectedMarche?.hasBankGuarantee ?? false;
  const isProrataManager = selectedMarche?.isProrataManager ?? false;

  // Task #463 — mirror the server's TVA regime resolution: marché rate →
  // contractor default → 20%; autoliquidation forces 0% and no override.
  const selectedContractor = useMemo(
    () => contractors?.find((c) => c.id === watchContractorId) ?? null,
    [contractors, watchContractorId],
  );
  const tvaAutoliquidation = selectedMarche?.tvaAutoliquidation
    ? true
    : selectedMarche?.tvaRatePercent != null
      ? false
      : selectedContractor?.defaultTvaAutoliquidation ?? false;
  // Task #479 — documentary effective rate mirror: same invoice set as the
  // server resolver (all invoices of the contractor's non-void devis), rate
  // = (ΣTTC − ΣHT) / ΣHT via the shared helper. Handles mixed-rate invoices
  // (10% + 20%) that no single configured rate can reproduce.
  const documentaryTvaRatePercent = useMemo(() => {
    if (!watchContractorId) return null;
    const contractorDevisIds = new Set(
      (projectDevis ?? [])
        .filter((d) => d.contractorId === watchContractorId && d.status !== "void" && d.signOffStage !== "void")
        .map((d) => d.id),
    );
    let sumHt = 0;
    let sumTtc = 0;
    for (const inv of projectInvoices ?? []) {
      if (!contractorDevisIds.has(inv.devisId)) continue;
      sumHt += parseFloat(inv.amountHt) || 0;
      sumTtc += parseFloat(inv.amountTtc) || 0;
    }
    return computeEffectiveTvaRatePercent(sumHt, sumTtc);
  }, [projectInvoices, projectDevis, watchContractorId]);

  const overrideRate = watchTvaRateOverride ? parseFloat(watchTvaRateOverride) : NaN;
  // Mirrors the server precedence: autoliquidation → override → documentary
  // effective rate → marché rate → contractor default → 20%.
  const appliedTvaRatePercent = tvaAutoliquidation
    ? 0
    : Number.isFinite(overrideRate)
      ? overrideRate
      : documentaryTvaRatePercent != null
        ? documentaryTvaRatePercent
        : selectedMarche?.tvaRatePercent != null
          ? parseFloat(selectedMarche.tvaRatePercent)
          : selectedContractor?.defaultTvaRatePercent != null
            ? parseFloat(selectedContractor.defaultTvaRatePercent)
            : 20;
  const previewTvaIsDocumentary =
    !tvaAutoliquidation && !Number.isFinite(overrideRate) && documentaryTvaRatePercent != null;

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

  const latestPrior = useMemo(
    () =>
      priorCerts
        .slice()
        .sort((a, b) => {
          const da = a.dateIssued ?? "";
          const db = b.dateIssued ?? "";
          if (da !== db) return da < db ? -1 : 1;
          return a.id - b.id;
        })
        .at(-1) ?? null,
    [priorCerts],
  );

  const breakdown = useMemo(() => computeCertificatDeductions({
    totalWorksHt: parseFloat(watchTotalWorks || "0") || 0,
    pvMvAdjustment: parseFloat(watchPvMv || "0") || 0,
    previousPayments: parseFloat(watchPrevious || "0") || 0,
    retenuePercent,
    hasBankGuarantee,
    prorataPercent,
    isProrataManager,
    priorCumulativeRetenue: latestPrior ? parseFloat(latestPrior.retenueGarantie ?? "0") : 0,
    priorCumulativeProrata: latestPrior ? parseFloat(latestPrior.cumulativeProrataDeduction ?? "0") : 0,
    retenueOverride: watchRetenueOverride ? parseFloat(watchRetenueOverride) : null,
    prorataOverride: watchProrataOverride ? parseFloat(watchProrataOverride) : null,
    paidAcompteAmount,
    priorCumulativeAcompteRecoupment: latestPrior ? parseFloat(latestPrior.cumulativeAcompteRecoupment ?? "0") : 0,
    acompteRecoupmentRule: (selectedMarche?.acompteRecoupmentRule as "asap" | "percent" | "progress_threshold" | undefined) ?? "asap",
    acompteRecoupmentPercent: selectedMarche?.acompteRecoupmentPercent != null ? parseFloat(selectedMarche.acompteRecoupmentPercent) : null,
    acompteRecoupmentThresholdPercent: selectedMarche?.acompteRecoupmentThresholdPercent != null ? parseFloat(selectedMarche.acompteRecoupmentThresholdPercent) : null,
    contractTotalHt: selectedMarche?.totalHt != null ? parseFloat(selectedMarche.totalHt) : null,
    tvaRate: appliedTvaRatePercent / 100,
    isSolde: watchIsSolde === true,
    releaseRetenue: watchReleaseRetenue === true,
  }), [watchTotalWorks, watchPvMv, watchPrevious, retenuePercent, hasBankGuarantee, prorataPercent, isProrataManager, latestPrior, watchRetenueOverride, watchProrataOverride, paidAcompteAmount, selectedMarche, appliedTvaRatePercent, watchIsSolde, watchReleaseRetenue]);

  useEffect(() => {
    form.setValue("retenueGarantie", breakdown.cumulativeRetenue.toFixed(2));
    form.setValue("cumulativeProrataDeduction", breakdown.cumulativeProrata.toFixed(2));
    form.setValue("periodProrataDeduction", breakdown.periodProrata.toFixed(2));
    form.setValue("netToPayHt", breakdown.netToPayHt.toFixed(2));
    form.setValue("tvaAmount", breakdown.tvaAmount.toFixed(2));
    form.setValue("netToPayTtc", breakdown.netToPayTtc.toFixed(2));
  }, [breakdown, form]);

  const createMutation = useMutation({
    mutationFn: async (data: CertificatFormValues) => {
      const res = await apiRequest("POST", `/api/projects/${data.projectId}/certificats`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "certificats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "certificats", "next-ref"] });
      setDialogOpen(false);
      form.reset();
      toast({ title: "Certificat created successfully" });
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
      toast({ title: "Status updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      certificateRef: nextRefData?.nextRef ?? "",
      dateIssued: null,
      totalWorksHt: totalInvoicesHt.toFixed(2),
      pvMvAdjustment: "0.00",
      previousPayments: "0.00",
      retenueGarantie: "0.00",
      cumulativeProrataDeduction: "0.00",
      periodProrataDeduction: "0.00",
      netToPayHt: totalInvoicesHt.toFixed(2),
      tvaAmount: (totalInvoicesHt * 0.2).toFixed(2),
      netToPayTtc: (totalInvoicesHt * 1.2).toFixed(2),
      status: "draft",
      notes: null,
      retenueOverride: undefined,
      prorataOverride: undefined,
      tvaRateOverride: undefined,
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
    const flow: Record<string, string> = { draft: "ready", ready: "sent", sent: "paid" };
    return flow[current] ?? null;
  };

  const getNextStatusLabel = (current: string): string | null => {
    const labels: Record<string, string> = { draft: "Mark Ready", ready: "Mark Sent", sent: "Mark Paid" };
    return labels[current] ?? null;
  };

  const isLoading = loadingProjects || loadingCerts;

  return (
    <AppLayout>
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
              const missingBic = certContractor && !certContractor.bic && (cert.status === "draft" || cert.status === "ready");
              return (
                <LuxuryCard key={cert.id} data-testid={`card-certificat-${cert.id}`}>
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
                        <p className="text-[12px] text-foreground mt-0.5">
                          {getContractorName(cert.contractorId)}
                        </p>
                        {cert.dateIssued && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">{cert.dateIssued}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="text-right">
                        <span className="text-[14px] font-semibold text-foreground" data-testid={`text-cert-amount-${cert.id}`}>
                          {formatCurrency(parseFloat(cert.netToPayTtc))}
                        </span>
                        <p className="text-[9px] text-muted-foreground">TTC</p>
                      </div>
                      {partiallyPaid && (
                        <span
                          className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                          data-testid={`badge-cert-partial-${cert.id}`}
                          title={`Encaissé ${formatCurrency(paidToDate)} sur ${formatCurrency(totalTtc)}`}
                        >
                          Partiel {formatCurrency(paidToDate)}
                        </span>
                      )}
                      <StatusBadge status={cert.status} />
                      {/* Task #556 — show send evidence for "sent" and "paid" certificats */}
                      {(cert.status === "sent" || cert.status === "paid") && cert.sentAt && cert.sentToEmail && (
                        <span
                          className="text-[9px] text-muted-foreground"
                          data-testid={`text-cert-sent-info-${cert.id}`}
                          title={`Envoyé à ${cert.sentToEmail}`}
                        >
                          Envoyé à <span className="font-semibold text-foreground">{cert.sentToEmail}</span>{" "}
                          le {new Date(cert.sentAt).toLocaleDateString("fr-FR")}
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
                        onValueChange={(val) => field.onChange(parseInt(val))}
                        value={field.value ? String(field.value) : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-cert-contractor">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(contractors ?? []).filter((c) => !c.archidocOrphanedAt).map((c) => (
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
                  <p className="text-[14px] font-semibold text-foreground mt-1" data-testid="text-next-cert-ref">
                    {nextRefData?.nextRef ?? "..."}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Auto-assigned sequentially per project</p>
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
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="totalWorksHt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Total Works HT (Cumulative)</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            step="0.01"
                            data-testid="input-cert-total-works"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="pvMvAdjustment"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>PV/MV Adjustment</TechnicalLabel>
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
                          <TechnicalLabel>Previous Payments (Cumulative)</TechnicalLabel>
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

                {/* Task #243 — optional architect overrides of the auto-computed
                    cumulative deductions. Leave blank to use the contractual rate. */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="retenueOverride"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Retenue Override (optional)</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            type="number"
                            step="0.01"
                            placeholder="Auto"
                            data-testid="input-cert-retenue-override"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
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
                  {/* Task #463 — draft-only TVA rate override. Disabled on
                      autoliquidation contracts (rate is legally 0%). */}
                  <FormField
                    control={form.control}
                    name="tvaRateOverride"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>TVA Rate Override % (optional)</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            placeholder={tvaAutoliquidation ? "Autoliquidation — 0%" : "Auto"}
                            disabled={tvaAutoliquidation}
                            data-testid="input-cert-tva-rate-override"
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

                <div className="p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] space-y-2">
                  <TechnicalLabel>Deduction Breakdown (Cumulative)</TechnicalLabel>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">Montant Brut Cumulé</span>
                    <span className="text-[13px] font-semibold text-foreground" data-testid="text-calc-gross">
                      {formatCurrency(breakdown.grossCumulativeHt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      − Retenue de Garantie{hasBankGuarantee ? " (bypass — caution bancaire)" : ` (${retenuePercent}%)`}
                    </span>
                    <span className="text-[13px] font-semibold text-red-600 dark:text-red-400" data-testid="text-calc-retenue">
                      −{formatCurrency(breakdown.cumulativeRetenue)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      − Compte Prorata{isProrataManager ? " (exempt — gestionnaire)" : ` (${prorataPercent}%)`}
                    </span>
                    <span className="text-[13px] font-semibold text-red-600 dark:text-red-400" data-testid="text-calc-prorata">
                      −{formatCurrency(breakdown.cumulativeProrata)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                    <span className="text-[11px] text-foreground">Montant Net Cumulé Autorisé</span>
                    <span className="text-[13px] font-semibold text-foreground" data-testid="text-calc-net-cumul">
                      {formatCurrency(breakdown.grossCumulativeHt - breakdown.cumulativeRetenue - breakdown.cumulativeProrata)}
                    </span>
                  </div>
                  {(breakdown.periodAcompteRecoupment > 0 || breakdown.cumulativeAcompteRecoupment > 0) && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        − Remboursement d'Acompte (période{breakdown.cumulativeAcompteRecoupment > 0 ? ` — cumul ${formatCurrency(breakdown.cumulativeAcompteRecoupment)} / ${formatCurrency(paidAcompteAmount)}` : ""})
                      </span>
                      <span className="text-[13px] font-semibold text-red-600 dark:text-red-400" data-testid="text-calc-acompte-recoupment">
                        −{formatCurrency(breakdown.periodAcompteRecoupment)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">− Previous Payments</span>
                    <span className="text-[13px] font-semibold text-foreground" data-testid="text-calc-previous">
                      −{formatCurrency(parseFloat(watchPrevious || "0") || 0)}
                    </span>
                  </div>
                  {watchIsSolde === true && breakdown.retenueReleaseAmount > 0 && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">+ Libération Retenue de Garantie (solde)</span>
                      <span className="text-[13px] font-semibold text-green-700 dark:text-green-500" data-testid="text-calc-retenue-release">
                        +{formatCurrency(breakdown.retenueReleaseAmount)}
                      </span>
                    </div>
                  )}
                  {watchIsSolde === true && watchReleaseRetenue !== true && breakdown.cumulativeRetenue > 0 && (
                    <div className="text-[10px] text-muted-foreground italic" data-testid="text-calc-retenue-withheld">
                      Solde — Retenue de Garantie de {formatCurrency(breakdown.cumulativeRetenue)} conservée
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                    <span className="text-[11px] text-muted-foreground">Net to Pay HT</span>
                    <span className="text-[13px] font-semibold text-foreground" data-testid="text-calc-net-ht">
                      {formatCurrency(breakdown.netToPayHt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {previewTvaIsDocumentary
                        ? `TVA (taux effectif ${appliedTvaRatePercent}% — d'après les factures)`
                        : `TVA (${appliedTvaRatePercent}%${tvaAutoliquidation ? " — autoliquidation" : ""})`}
                    </span>
                    <span className="text-[13px] font-semibold text-foreground" data-testid="text-calc-tva">
                      {formatCurrency(breakdown.tvaAmount)}
                    </span>
                  </div>
                  {tvaAutoliquidation && (
                    <div className="text-[10px] text-muted-foreground italic" data-testid="text-calc-autoliquidation">
                      Autoliquidation — TVA due par le preneur (art. 283 CGI)
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                    <span className="text-[11px] font-black uppercase tracking-widest text-foreground">Net to Pay TTC</span>
                    <span className="text-[16px] font-bold text-foreground" data-testid="text-calc-net-ttc">
                      {formatCurrency(breakdown.netToPayTtc)}
                    </span>
                  </div>
                </div>

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

                <Button type="submit" className="w-full" disabled={createMutation.isPending} data-testid="button-submit-certificat">
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
