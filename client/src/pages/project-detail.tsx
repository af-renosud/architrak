import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { FolderOpen, ArrowLeft, MapPin, User, FileText, Layers, ScrollText, Award, Coins, BarChart3, Plus, Eye, ChevronRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, useParams } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { insertCertificatSchema, insertFeeSchema, insertFeeEntrySchema, insertLotSchema, insertMarcheSchema } from "@shared/schema";
import type { Project, Devis, Lot, Marche, Certificat, Fee, FeeEntry, Contractor, Invoice } from "@shared/schema";
import { DevisTab } from "@/components/devis/DevisTab";
import { z } from "zod";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

interface FinancialSummary {
  projectId: number;
  projectName: string;
  projectCode: string;
  totalContractedHt: number;
  totalCertifiedHt: number;
  totalResteARealiser: number;
  totalOriginalHt: number;
  totalPv: number;
  totalMv: number;
  devis: DevisSummary[];
}

interface DevisSummary {
  devisId: number;
  devisCode: string;
  descriptionFr: string;
  descriptionUk: string | null;
  status: string;
  contractorId: number;
  invoicingMode: string;
  originalHt: number;
  pvTotal: number;
  mvTotal: number;
  adjustedHt: number;
  certifiedHt: number;
  resteARealiser: number;
  invoiceCount: number;
  avenantCount: number;
}

const certFormSchema = insertCertificatSchema.extend({
  certificateRef: z.string().min(1, "La référence est requise"),
  totalWorksHt: z.string().min(1, "Requis"),
  netToPayHt: z.string().min(1, "Requis"),
  tvaAmount: z.string().min(1, "Requis"),
  netToPayTtc: z.string().min(1, "Requis"),
});
type CertFormValues = z.infer<typeof certFormSchema>;

const feeFormSchema = insertFeeSchema.extend({
  feeAmountHt: z.string().min(1, "Requis"),
  feeAmountTtc: z.string().min(1, "Requis"),
  remainingAmount: z.string().min(1, "Requis"),
});
type FeeFormValues = z.infer<typeof feeFormSchema>;

const entryFormSchema = insertFeeEntrySchema.extend({
  baseHt: z.string().min(1, "Requis"),
  feeRate: z.string().min(1, "Requis"),
  feeAmount: z.string().min(1, "Requis"),
});
type EntryFormValues = z.infer<typeof entryFormSchema>;

export default function ProjectDetail() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const { toast } = useToast();

  const [certDialogOpen, setCertDialogOpen] = useState(false);
  const [viewingCert, setViewingCert] = useState<Certificat | null>(null);
  const [feeDialogOpen, setFeeDialogOpen] = useState(false);
  const [entryDialogOpen, setEntryDialogOpen] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [lotDialogOpen, setLotDialogOpen] = useState(false);
  const [marcheDialogOpen, setMarcheDialogOpen] = useState(false);

  const { data: project, isLoading } = useQuery<Project>({
    queryKey: ["/api/projects", projectId],
  });

  const { data: devisList } = useQuery<Devis[]>({
    queryKey: ["/api/projects", projectId, "devis"],
    enabled: !!project,
  });

  const { data: lotsList } = useQuery<Lot[]>({
    queryKey: ["/api/projects", projectId, "lots"],
    enabled: !!project,
  });

  const { data: marchesList } = useQuery<Marche[]>({
    queryKey: ["/api/projects", projectId, "marches"],
    enabled: !!project && !!project.hasMarche,
  });

  const { data: certificatsList } = useQuery<Certificat[]>({
    queryKey: ["/api/projects", projectId, "certificats"],
    enabled: !!project,
  });

  const { data: feesList } = useQuery<Fee[]>({
    queryKey: ["/api/projects", projectId, "fees"],
    enabled: !!project,
  });

  const { data: feeEntries } = useQuery<FeeEntry[]>({
    queryKey: ["/api/projects", projectId, "fee-entries"],
    enabled: !!project,
  });

  const { data: contractors } = useQuery<Contractor[]>({
    queryKey: ["/api/contractors"],
    enabled: !!project,
  });

  const { data: projectInvoices } = useQuery<Invoice[]>({
    queryKey: ["/api/projects", projectId, "invoices"],
    enabled: !!project,
  });

  const { data: financialSummary } = useQuery<FinancialSummary>({
    queryKey: ["/api/projects", projectId, "financial-summary"],
    enabled: !!project,
  });

  const certForm = useForm<CertFormValues>({
    resolver: zodResolver(certFormSchema),
    defaultValues: {
      projectId: 0, contractorId: 0, certificateRef: "", dateIssued: null,
      totalWorksHt: "0.00", pvMvAdjustment: "0.00", previousPayments: "0.00",
      retenueGarantie: "0.00", netToPayHt: "0.00", tvaAmount: "0.00",
      netToPayTtc: "0.00", status: "draft", notes: null,
    },
  });

  const feeForm = useForm<FeeFormValues>({
    resolver: zodResolver(feeFormSchema),
    defaultValues: {
      projectId: 0, feeType: "works_percentage", baseAmountHt: "0.00",
      feeRate: null, feeAmountHt: "0.00", feeAmountTtc: "0.00",
      invoicedAmount: "0.00", remainingAmount: "0.00", pennylaneRef: null, status: "pending",
    },
  });

  const entryForm = useForm<EntryFormValues>({
    resolver: zodResolver(entryFormSchema),
    defaultValues: {
      feeId: 0, invoiceId: null, devisId: null, baseHt: "0.00",
      feeRate: "0.00", feeAmount: "0.00", pennylaneInvoiceRef: null,
      dateInvoiced: null, status: "pending",
    },
  });

  const lotFormSchema = insertLotSchema.extend({
    lotNumber: z.coerce.number().min(1, "Requis"),
    descriptionFr: z.string().min(1, "La description est requise"),
  });
  const lotForm = useForm<z.infer<typeof lotFormSchema>>({
    resolver: zodResolver(lotFormSchema),
    defaultValues: { projectId: parseInt(projectId!), lotNumber: 1, descriptionFr: "", descriptionUk: null },
  });

  const marcheFormSchema = insertMarcheSchema.extend({
    totalHt: z.string().min(1, "Requis"),
    totalTtc: z.string().min(1, "Requis"),
  });
  const marcheForm = useForm<z.infer<typeof marcheFormSchema>>({
    resolver: zodResolver(marcheFormSchema),
    defaultValues: {
      projectId: parseInt(projectId!), contractorId: 0, marcheNumber: null,
      priceType: "forfaitaire", totalHt: "0.00", totalTtc: "0.00",
      retenueGarantiePercent: "5.00", paymentSchedule: null, signedDate: null, status: "draft",
    },
  });

  const createLotMutation = useMutation({
    mutationFn: async (data: z.infer<typeof lotFormSchema>) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/lots`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "lots"] });
      setLotDialogOpen(false);
      lotForm.reset();
      toast({ title: "Lot créé avec succès" });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const createMarcheMutation = useMutation({
    mutationFn: async (data: z.infer<typeof marcheFormSchema>) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/marches`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "marches"] });
      setMarcheDialogOpen(false);
      marcheForm.reset();
      toast({ title: "Marché créé avec succès" });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const createCertMutation = useMutation({
    mutationFn: async (data: CertFormValues) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/certificats`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "certificats"] });
      setCertDialogOpen(false);
      certForm.reset();
      toast({ title: "Certificat créé avec succès" });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const updateCertStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/certificats/${id}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "certificats"] });
      toast({ title: "Statut mis à jour" });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const createFeeMutation = useMutation({
    mutationFn: async (data: FeeFormValues) => {
      const res = await apiRequest("POST", "/api/fees", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fees"] });
      setFeeDialogOpen(false);
      feeForm.reset();
      toast({ title: "Honoraire créé avec succès" });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const createEntryMutation = useMutation({
    mutationFn: async (data: EntryFormValues) => {
      const res = await apiRequest("POST", `/api/fees/${data.feeId}/entries`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fee-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fees"] });
      setEntryDialogOpen(false);
      entryForm.reset();
      toast({ title: "Entrée créée" });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const updateEntryMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<EntryFormValues> }) => {
      const res = await apiRequest("PATCH", `/api/fee-entries/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fee-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fees"] });
      setEntryDialogOpen(false);
      setEditingEntryId(null);
      entryForm.reset();
      toast({ title: "Entrée mise à jour" });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const getContractorName = (id: number) => contractors?.find((c) => c.id === id)?.name ?? `#${id}`;

  const recalcCert = () => {
    const totalWorks = parseFloat(certForm.watch("totalWorksHt") || "0");
    const pvMv = parseFloat(certForm.watch("pvMvAdjustment") || "0");
    const previous = parseFloat(certForm.watch("previousPayments") || "0");
    const retenue = parseFloat(certForm.watch("retenueGarantie") || "0");
    const netHt = totalWorks + pvMv - previous - retenue;
    const tva = netHt * 0.2;
    certForm.setValue("netToPayHt", netHt.toFixed(2));
    certForm.setValue("tvaAmount", tva.toFixed(2));
    certForm.setValue("netToPayTtc", (netHt + tva).toFixed(2));
  };

  const recalcFee = () => {
    const base = parseFloat(feeForm.watch("baseAmountHt") || "0");
    const rate = parseFloat(feeForm.watch("feeRate") || "0");
    const feeType = feeForm.watch("feeType");
    let feeHt = feeType === "works_percentage" ? base * (rate / 100) : parseFloat(feeForm.watch("feeAmountHt") || "0");
    feeForm.setValue("feeAmountHt", feeHt.toFixed(2));
    feeForm.setValue("feeAmountTtc", (feeHt * 1.2).toFixed(2));
    feeForm.setValue("remainingAmount", (feeHt - parseFloat(feeForm.watch("invoicedAmount") || "0")).toFixed(2));
  };

  const recalcEntry = () => {
    const base = parseFloat(entryForm.watch("baseHt") || "0");
    const rate = parseFloat(entryForm.watch("feeRate") || "0");
    entryForm.setValue("feeAmount", (base * rate / 100).toFixed(2));
  };

  const openCreateCert = () => {
    const totalInvHt = (projectInvoices ?? []).reduce((s, i) => s + parseFloat(i.amountHt), 0);
    certForm.reset({
      projectId: parseInt(projectId!), contractorId: 0, certificateRef: "",
      dateIssued: null, totalWorksHt: totalInvHt.toFixed(2), pvMvAdjustment: "0.00",
      previousPayments: "0.00", retenueGarantie: "0.00",
      netToPayHt: totalInvHt.toFixed(2), tvaAmount: (totalInvHt * 0.2).toFixed(2),
      netToPayTtc: (totalInvHt * 1.2).toFixed(2), status: "draft", notes: null,
    });
    setCertDialogOpen(true);
  };

  const openCreateFee = () => {
    feeForm.reset({
      projectId: parseInt(projectId!), feeType: "works_percentage",
      baseAmountHt: "0.00", feeRate: null, feeAmountHt: "0.00",
      feeAmountTtc: "0.00", invoicedAmount: "0.00", remainingAmount: "0.00",
      pennylaneRef: null, status: "pending",
    });
    setFeeDialogOpen(true);
  };

  const openCreateEntry = (feeId: number) => {
    const fee = feesList?.find((f) => f.id === feeId);
    setEditingEntryId(null);
    entryForm.reset({
      feeId, invoiceId: null, devisId: null, baseHt: "0.00",
      feeRate: fee?.feeRate ?? "0.00", feeAmount: "0.00",
      pennylaneInvoiceRef: null, dateInvoiced: null, status: "pending",
    });
    setEntryDialogOpen(true);
  };

  const openEditEntry = (entry: FeeEntry) => {
    setEditingEntryId(entry.id);
    entryForm.reset({
      feeId: entry.feeId, invoiceId: entry.invoiceId, devisId: entry.devisId,
      baseHt: entry.baseHt, feeRate: entry.feeRate, feeAmount: entry.feeAmount,
      pennylaneInvoiceRef: entry.pennylaneInvoiceRef, dateInvoiced: entry.dateInvoiced,
      status: entry.status,
    });
    setEntryDialogOpen(true);
  };

  const getNextCertStatus = (s: string) => ({ draft: "ready", ready: "sent", sent: "paid" }[s] ?? null);
  const getNextCertLabel = (s: string) => ({ draft: "Marquer Prêt", ready: "Marquer Envoyé", sent: "Marquer Payé" }[s] ?? null);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-32 w-full rounded-[2rem]" />
        </div>
      </AppLayout>
    );
  }

  if (!project) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <p className="text-muted-foreground">Projet non trouvé.</p>
          <Link href="/projets">
            <Button variant="outline" data-testid="button-back-projects">
              <ArrowLeft size={14} />
              <span className="text-[9px] font-bold uppercase tracking-widest">Retour aux projets</span>
            </Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/projets">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft size={16} />
            </Button>
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-project-name">
                {project.name}
              </h1>
              <StatusBadge status={project.status} />
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <TechnicalLabel data-testid="text-project-code">{project.code}</TechnicalLabel>
              <span className="text-[11px] text-muted-foreground">—</span>
              <div className="flex items-center gap-1">
                <User size={10} className="text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">{project.clientName}</span>
              </div>
              {project.clientAddress && (
                <>
                  <span className="text-[11px] text-muted-foreground">—</span>
                  <div className="flex items-center gap-1">
                    <MapPin size={10} className="text-muted-foreground" />
                    <span className="text-[11px] text-muted-foreground">{project.clientAddress}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <LuxuryCard data-testid="card-project-info">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <TechnicalLabel>Taux TVA</TechnicalLabel>
              <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-tva-rate">{project.tvaRate}%</p>
            </div>
            <div>
              <TechnicalLabel>Type honoraires</TechnicalLabel>
              <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-fee-type">
                {project.feeType === "percentage" ? "Pourcentage" : "Fixe"}
              </p>
            </div>
            {project.feePercentage && (
              <div>
                <TechnicalLabel>% Honoraires</TechnicalLabel>
                <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-fee-pct">{project.feePercentage}%</p>
              </div>
            )}
            <div>
              <TechnicalLabel>Marché</TechnicalLabel>
              <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-has-marche">
                {project.hasMarche ? "Oui" : "Non"}
              </p>
            </div>
          </div>
        </LuxuryCard>

        <Tabs defaultValue="resume" data-testid="tabs-project-detail">
          <TabsList className="flex-wrap">
            <TabsTrigger value="resume" data-testid="tab-resume">
              <BarChart3 size={12} className="mr-1" />
              Résumé Financier
            </TabsTrigger>
            <TabsTrigger value="devis" data-testid="tab-devis">
              <FileText size={12} className="mr-1" />
              Devis
            </TabsTrigger>
            <TabsTrigger value="lots" data-testid="tab-lots">
              <Layers size={12} className="mr-1" />
              Lots
            </TabsTrigger>
            {project.hasMarche && (
              <TabsTrigger value="marche" data-testid="tab-marche">
                <ScrollText size={12} className="mr-1" />
                Marché
              </TabsTrigger>
            )}
            <TabsTrigger value="certificats" data-testid="tab-certificats">
              <Award size={12} className="mr-1" />
              Certificats
            </TabsTrigger>
            <TabsTrigger value="honoraires" data-testid="tab-honoraires">
              <Coins size={12} className="mr-1" />
              Honoraires
            </TabsTrigger>
          </TabsList>

          <TabsContent value="resume">
            {financialSummary ? (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <LuxuryCard data-testid="card-total-contracted">
                    <TechnicalLabel>Total Contracté HT</TechnicalLabel>
                    <p className="text-[20px] font-light text-foreground mt-2" data-testid="text-total-contracted">
                      {formatCurrency(financialSummary.totalContractedHt)}
                    </p>
                  </LuxuryCard>
                  <LuxuryCard data-testid="card-total-certified">
                    <TechnicalLabel>Total Certifié HT</TechnicalLabel>
                    <p className="text-[20px] font-light text-emerald-600 dark:text-emerald-400 mt-2" data-testid="text-total-certified">
                      {formatCurrency(financialSummary.totalCertifiedHt)}
                    </p>
                  </LuxuryCard>
                  <LuxuryCard data-testid="card-total-reste">
                    <TechnicalLabel>Reste à Réaliser</TechnicalLabel>
                    <p className="text-[20px] font-light text-amber-600 dark:text-amber-400 mt-2" data-testid="text-total-reste">
                      {formatCurrency(financialSummary.totalResteARealiser)}
                    </p>
                  </LuxuryCard>
                </div>

                {financialSummary.devis.length > 0 ? (
                  <LuxuryCard data-testid="card-devis-breakdown">
                    <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground mb-4">
                      Détail par Devis
                    </h3>
                    <div className="space-y-4">
                      {financialSummary.devis.map((ds) => {
                        const progress = ds.adjustedHt > 0
                          ? Math.min((ds.certifiedHt / ds.adjustedHt) * 100, 100)
                          : 0;
                        return (
                          <div
                            key={ds.devisId}
                            className="p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] space-y-3"
                            data-testid={`card-devis-summary-${ds.devisId}`}
                          >
                            <div className="flex items-start justify-between gap-2 flex-wrap">
                              <div>
                                <TechnicalLabel>{ds.devisCode}</TechnicalLabel>
                                <p className="text-[12px] text-foreground mt-0.5">{ds.descriptionFr}</p>
                              </div>
                              <StatusBadge status={ds.status} />
                            </div>
                            <div className="grid grid-cols-3 gap-4">
                              <div>
                                <TechnicalLabel>Contracté</TechnicalLabel>
                                <p className="text-[12px] font-semibold text-foreground mt-0.5">
                                  {formatCurrency(ds.adjustedHt)}
                                </p>
                              </div>
                              <div>
                                <TechnicalLabel>Certifié</TechnicalLabel>
                                <p className="text-[12px] font-semibold text-emerald-600 dark:text-emerald-400 mt-0.5">
                                  {formatCurrency(ds.certifiedHt)}
                                </p>
                              </div>
                              <div>
                                <TechnicalLabel>Reste</TechnicalLabel>
                                <p className="text-[12px] font-semibold text-amber-600 dark:text-amber-400 mt-0.5">
                                  {formatCurrency(ds.resteARealiser)}
                                </p>
                              </div>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                              <div
                                className="h-full rounded-full bg-emerald-500 transition-all"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                            <div className="flex items-center gap-4 flex-wrap">
                              <span className="text-[10px] text-muted-foreground">
                                {ds.invoiceCount} facture{ds.invoiceCount !== 1 ? "s" : ""}
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                {ds.avenantCount} avenant{ds.avenantCount !== 1 ? "s" : ""}
                              </span>
                              {ds.pvTotal > 0 && (
                                <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                                  PV: +{formatCurrency(ds.pvTotal)}
                                </span>
                              )}
                              {ds.mvTotal > 0 && (
                                <span className="text-[10px] text-red-600 dark:text-red-400">
                                  MV: -{formatCurrency(ds.mvTotal)}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </LuxuryCard>
                ) : (
                  <LuxuryCard data-testid="card-no-devis-summary">
                    <p className="text-[12px] text-muted-foreground text-center py-8">
                      Aucun devis pour ce projet.
                    </p>
                  </LuxuryCard>
                )}
              </div>
            ) : (
              <LuxuryCard>
                <Skeleton className="h-20 w-full" />
              </LuxuryCard>
            )}
          </TabsContent>

          <TabsContent value="devis">
            <DevisTab
              projectId={projectId!}
              contractors={contractors ?? []}
              lots={lotsList ?? []}
            />
          </TabsContent>

          <TabsContent value="lots">
            <div className="space-y-4">
              <div className="flex items-center justify-end">
                <Button onClick={() => {
                  lotForm.reset({ projectId: parseInt(projectId!), lotNumber: (lotsList?.length ?? 0) + 1, descriptionFr: "", descriptionUk: null });
                  setLotDialogOpen(true);
                }} data-testid="button-new-lot">
                  <Plus size={14} />
                  <span className="text-[9px] font-bold uppercase tracking-widest">Nouveau Lot</span>
                </Button>
              </div>
              <LuxuryCard data-testid="card-lots-tab">
                {lotsList && lotsList.length > 0 ? (
                  <div className="space-y-3">
                    <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground mb-4">
                      Lots ({lotsList.length})
                    </h3>
                    {lotsList.map((lot) => (
                      <div
                        key={lot.id}
                        className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] flex items-center gap-3 flex-wrap"
                        data-testid={`row-lot-${lot.id}`}
                      >
                        <TechnicalLabel>Lot {lot.lotNumber}</TechnicalLabel>
                        <span className="text-[12px] text-foreground">{lot.descriptionFr}</span>
                        {lot.descriptionUk && (
                          <span className="text-[11px] text-muted-foreground">({lot.descriptionUk})</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground text-center py-8">
                    Aucun lot défini pour ce projet.
                  </p>
                )}
              </LuxuryCard>
              <Dialog open={lotDialogOpen} onOpenChange={setLotDialogOpen}>
                <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="text-[16px] font-black uppercase tracking-tight">Nouveau Lot</DialogTitle>
                  </DialogHeader>
                  <Form {...lotForm}>
                    <form onSubmit={lotForm.handleSubmit((d) => createLotMutation.mutate(d))} className="space-y-4">
                      <FormField control={lotForm.control} name="lotNumber" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Numéro de lot</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" onChange={(e) => field.onChange(parseInt(e.target.value))} data-testid="input-lot-number" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={lotForm.control} name="descriptionFr" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Description (FR)</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} placeholder="ex: Gros Oeuvre" data-testid="input-lot-desc-fr" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={lotForm.control} name="descriptionUk" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Description (EN)</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} placeholder="ex: Structural Works" data-testid="input-lot-desc-uk" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <Button type="submit" className="w-full" disabled={createLotMutation.isPending} data-testid="button-submit-lot">
                        <span className="text-[9px] font-bold uppercase tracking-widest">
                          {createLotMutation.isPending ? "Création..." : "Créer le lot"}
                        </span>
                      </Button>
                    </form>
                  </Form>
                </DialogContent>
              </Dialog>
            </div>
          </TabsContent>

          {project.hasMarche && (
            <TabsContent value="marche">
              <div className="space-y-4">
                <div className="flex items-center justify-end">
                  <Button onClick={() => {
                    marcheForm.reset({
                      projectId: parseInt(projectId!), contractorId: 0, marcheNumber: null,
                      priceType: "forfaitaire", totalHt: "0.00", totalTtc: "0.00",
                      retenueGarantiePercent: "5.00", paymentSchedule: null, signedDate: null, status: "draft",
                    });
                    setMarcheDialogOpen(true);
                  }} data-testid="button-new-marche">
                    <Plus size={14} />
                    <span className="text-[9px] font-bold uppercase tracking-widest">Nouveau Marché</span>
                  </Button>
                </div>
                <LuxuryCard data-testid="card-marche-tab">
                  {marchesList && marchesList.length > 0 ? (
                    <div className="space-y-3">
                      <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground mb-4">
                        Marchés ({marchesList.length})
                      </h3>
                      {marchesList.map((m) => (
                        <div
                          key={m.id}
                          className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] flex items-center justify-between gap-3 flex-wrap"
                          data-testid={`row-marche-${m.id}`}
                        >
                          <div>
                            {m.marcheNumber && <TechnicalLabel>{m.marcheNumber}</TechnicalLabel>}
                            <p className="text-[12px] text-foreground mt-0.5">
                              {m.priceType === "forfaitaire" ? "Forfaitaire" : "Unitaire"}
                            </p>
                            <span className="text-[10px] text-muted-foreground">{getContractorName(m.contractorId)}</span>
                          </div>
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-[12px] font-semibold text-foreground">{formatCurrency(parseFloat(m.totalHt))} HT</span>
                            <StatusBadge status={m.status} />
                          </div>
                        </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground text-center py-8">
                    Aucun marché pour ce projet.
                  </p>
                )}
              </LuxuryCard>
              <Dialog open={marcheDialogOpen} onOpenChange={setMarcheDialogOpen}>
                <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="text-[16px] font-black uppercase tracking-tight">Nouveau Marché</DialogTitle>
                  </DialogHeader>
                  <Form {...marcheForm}>
                    <form onSubmit={marcheForm.handleSubmit((d) => createMarcheMutation.mutate(d))} className="space-y-4">
                      <FormField control={marcheForm.control} name="contractorId" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Entreprise</TechnicalLabel></FormLabel>
                          <Select onValueChange={(v) => field.onChange(parseInt(v))} value={field.value ? String(field.value) : ""}>
                            <FormControl><SelectTrigger data-testid="select-marche-contractor"><SelectValue placeholder="Sélectionner" /></SelectTrigger></FormControl>
                            <SelectContent>
                              {(contractors ?? []).map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={marcheForm.control} name="marcheNumber" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Numéro de Marché</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} placeholder="ex: MTP-2024-001" data-testid="input-marche-number" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={marcheForm.control} name="priceType" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Type de Prix</TechnicalLabel></FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl><SelectTrigger data-testid="select-marche-price"><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="forfaitaire">Forfaitaire</SelectItem>
                              <SelectItem value="unitaire">Unitaire</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <div className="grid grid-cols-2 gap-4">
                        <FormField control={marcheForm.control} name="totalHt" render={({ field }) => (
                          <FormItem>
                            <FormLabel><TechnicalLabel>Total HT</TechnicalLabel></FormLabel>
                            <FormControl><Input {...field} type="number" step="0.01" data-testid="input-marche-ht" /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <FormField control={marcheForm.control} name="totalTtc" render={({ field }) => (
                          <FormItem>
                            <FormLabel><TechnicalLabel>Total TTC</TechnicalLabel></FormLabel>
                            <FormControl><Input {...field} type="number" step="0.01" data-testid="input-marche-ttc" /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      </div>
                      <FormField control={marcheForm.control} name="retenueGarantiePercent" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Retenue de Garantie (%)</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? "5.00"} type="number" step="0.01" data-testid="input-marche-retenue" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <Button type="submit" className="w-full" disabled={createMarcheMutation.isPending} data-testid="button-submit-marche">
                        <span className="text-[9px] font-bold uppercase tracking-widest">
                          {createMarcheMutation.isPending ? "Création..." : "Créer le marché"}
                        </span>
                      </Button>
                    </form>
                  </Form>
                </DialogContent>
              </Dialog>
            </div>
            </TabsContent>
          )}

          <TabsContent value="certificats">
            <div className="space-y-4">
              <div className="flex items-center justify-end">
                <Button onClick={openCreateCert} data-testid="button-new-cert-tab">
                  <Plus size={14} />
                  <span className="text-[9px] font-bold uppercase tracking-widest">Nouveau Certificat</span>
                </Button>
              </div>
              {certificatsList && certificatsList.length > 0 ? (
                <div className="space-y-3">
                  {certificatsList.map((c) => {
                    const nextStatus = getNextCertStatus(c.status);
                    const nextLabel = getNextCertLabel(c.status);
                    return (
                      <LuxuryCard key={c.id} data-testid={`card-certificat-tab-${c.id}`}>
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div>
                            <TechnicalLabel data-testid={`text-cert-ref-tab-${c.id}`}>{c.certificateRef}</TechnicalLabel>
                            <p className="text-[12px] text-foreground mt-0.5">{getContractorName(c.contractorId)}</p>
                            {c.dateIssued && (
                              <p className="text-[10px] text-muted-foreground mt-0.5">{c.dateIssued}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-3 flex-wrap">
                            <div className="text-right">
                              <span className="text-[14px] font-semibold text-foreground" data-testid={`text-cert-ttc-tab-${c.id}`}>
                                {formatCurrency(parseFloat(c.netToPayTtc))}
                              </span>
                              <p className="text-[9px] text-muted-foreground">TTC</p>
                            </div>
                            <StatusBadge status={c.status} />
                            {nextStatus && nextLabel && (
                              <Button
                                variant="outline"
                                onClick={() => updateCertStatusMutation.mutate({ id: c.id, status: nextStatus })}
                                disabled={updateCertStatusMutation.isPending}
                                data-testid={`button-advance-cert-tab-${c.id}`}
                              >
                                <ChevronRight size={12} />
                                <span className="text-[8px] font-bold uppercase tracking-widest">{nextLabel}</span>
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setViewingCert(c)}
                              data-testid={`button-view-cert-tab-${c.id}`}
                            >
                              <Eye size={14} />
                            </Button>
                          </div>
                        </div>
                        <div className="grid grid-cols-4 gap-3 mt-3 pt-3 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                          <div>
                            <TechnicalLabel>Travaux HT</TechnicalLabel>
                            <p className="text-[11px] font-semibold text-foreground mt-0.5">{formatCurrency(parseFloat(c.totalWorksHt))}</p>
                          </div>
                          <div>
                            <TechnicalLabel>PV/MV</TechnicalLabel>
                            <p className="text-[11px] font-semibold text-foreground mt-0.5">{formatCurrency(parseFloat(c.pvMvAdjustment ?? "0"))}</p>
                          </div>
                          <div>
                            <TechnicalLabel>Retenue</TechnicalLabel>
                            <p className="text-[11px] font-semibold text-foreground mt-0.5">{formatCurrency(parseFloat(c.retenueGarantie ?? "0"))}</p>
                          </div>
                          <div>
                            <TechnicalLabel>Net HT</TechnicalLabel>
                            <p className="text-[11px] font-semibold text-foreground mt-0.5">{formatCurrency(parseFloat(c.netToPayHt))}</p>
                          </div>
                        </div>
                      </LuxuryCard>
                    );
                  })}
                </div>
              ) : (
                <LuxuryCard data-testid="card-empty-certs-tab">
                  <p className="text-[12px] text-muted-foreground text-center py-8">
                    Aucun certificat de paiement pour ce projet.
                  </p>
                </LuxuryCard>
              )}
            </div>

            {viewingCert && (
              <Dialog open onOpenChange={() => setViewingCert(null)}>
                <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                      Certificat {viewingCert.certificateRef}
                    </DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <StatusBadge status={viewingCert.status} />
                      {viewingCert.dateIssued && <span className="text-[11px] text-muted-foreground">{viewingCert.dateIssued}</span>}
                    </div>
                    <div>
                      <TechnicalLabel>Entreprise</TechnicalLabel>
                      <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-cert-view-contractor">
                        {getContractorName(viewingCert.contractorId)}
                      </p>
                    </div>
                    <div className="space-y-2 p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                      <div className="flex items-center justify-between gap-2">
                        <TechnicalLabel>Total Travaux HT</TechnicalLabel>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.totalWorksHt))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <TechnicalLabel>PV/MV</TechnicalLabel>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.pvMvAdjustment ?? "0"))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <TechnicalLabel>Paiements Précédents</TechnicalLabel>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.previousPayments ?? "0"))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <TechnicalLabel>Retenue de Garantie</TechnicalLabel>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.retenueGarantie ?? "0"))}</span>
                      </div>
                      <div className="border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-3">
                        <div className="flex items-center justify-between gap-2">
                          <TechnicalLabel>Net HT</TechnicalLabel>
                          <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.netToPayHt))}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-1">
                          <TechnicalLabel>TVA</TechnicalLabel>
                          <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.tvaAmount))}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                          <span className="text-[11px] font-black uppercase tracking-widest text-foreground">Net TTC</span>
                          <span className="text-[16px] font-bold text-foreground">{formatCurrency(parseFloat(viewingCert.netToPayTtc))}</span>
                        </div>
                      </div>
                    </div>
                    {viewingCert.notes && (
                      <div>
                        <TechnicalLabel>Notes</TechnicalLabel>
                        <p className="text-[12px] text-muted-foreground mt-1">{viewingCert.notes}</p>
                      </div>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
            )}

            <Dialog open={certDialogOpen} onOpenChange={setCertDialogOpen}>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-[16px] font-black uppercase tracking-tight">Nouveau Certificat</DialogTitle>
                </DialogHeader>
                <Form {...certForm}>
                  <form onSubmit={certForm.handleSubmit((d) => createCertMutation.mutate(d))} className="space-y-4">
                    <FormField control={certForm.control} name="contractorId" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Entreprise</TechnicalLabel></FormLabel>
                        <Select onValueChange={(v) => field.onChange(parseInt(v))} value={field.value ? String(field.value) : ""}>
                          <FormControl><SelectTrigger data-testid="select-cert-contractor-tab"><SelectValue placeholder="Sélectionner" /></SelectTrigger></FormControl>
                          <SelectContent>
                            {(contractors ?? []).map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={certForm.control} name="certificateRef" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Référence</TechnicalLabel></FormLabel>
                        <FormControl><Input {...field} placeholder="ex: C43" data-testid="input-cert-ref-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={certForm.control} name="dateIssued" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Date</TechnicalLabel></FormLabel>
                        <FormControl><Input type="date" {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-cert-date-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={certForm.control} name="totalWorksHt" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Total Travaux HT</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcCert()} data-testid="input-cert-works-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={certForm.control} name="pvMvAdjustment" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>PV/MV</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? "0.00"} type="number" step="0.01" onBlur={() => recalcCert()} data-testid="input-cert-pvmv-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={certForm.control} name="previousPayments" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Paiements précédents</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? "0.00"} type="number" step="0.01" onBlur={() => recalcCert()} data-testid="input-cert-prev-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={certForm.control} name="retenueGarantie" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Retenue de garantie</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? "0.00"} type="number" step="0.01" onBlur={() => recalcCert()} data-testid="input-cert-retenue-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] space-y-2">
                      <TechnicalLabel>Résumé</TechnicalLabel>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground">Net HT</span>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(certForm.watch("netToPayHt") || "0"))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground">TVA</span>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(certForm.watch("tvaAmount") || "0"))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                        <span className="text-[11px] font-black uppercase tracking-widest">Net TTC</span>
                        <span className="text-[16px] font-bold text-foreground">{formatCurrency(parseFloat(certForm.watch("netToPayTtc") || "0"))}</span>
                      </div>
                    </div>
                    <FormField control={certForm.control} name="notes" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Notes</TechnicalLabel></FormLabel>
                        <FormControl><Textarea {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} className="resize-none" data-testid="input-cert-notes-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <Button type="submit" className="w-full" disabled={createCertMutation.isPending} data-testid="button-submit-cert-tab">
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {createCertMutation.isPending ? "Création..." : "Créer le certificat"}
                      </span>
                    </Button>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </TabsContent>

          <TabsContent value="honoraires">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="grid grid-cols-3 gap-4 flex-1">
                  <div>
                    <TechnicalLabel>Total Honoraires</TechnicalLabel>
                    <p className="text-[16px] font-light text-foreground mt-1" data-testid="text-tab-fee-total">
                      {formatCurrency((feesList ?? []).reduce((s, f) => s + parseFloat(f.feeAmountHt), 0))}
                    </p>
                  </div>
                  <div>
                    <TechnicalLabel>Facturé</TechnicalLabel>
                    <p className="text-[16px] font-light text-emerald-600 dark:text-emerald-400 mt-1" data-testid="text-tab-fee-invoiced">
                      {formatCurrency((feesList ?? []).reduce((s, f) => s + parseFloat(f.invoicedAmount ?? "0"), 0))}
                    </p>
                  </div>
                  <div>
                    <TechnicalLabel>Restant</TechnicalLabel>
                    <p className="text-[16px] font-light text-amber-600 dark:text-amber-400 mt-1" data-testid="text-tab-fee-remaining">
                      {formatCurrency((feesList ?? []).reduce((s, f) => s + parseFloat(f.feeAmountHt) - parseFloat(f.invoicedAmount ?? "0"), 0))}
                    </p>
                  </div>
                </div>
                <Button onClick={openCreateFee} data-testid="button-new-fee-tab">
                  <Plus size={14} />
                  <span className="text-[9px] font-bold uppercase tracking-widest">Nouvel Honoraire</span>
                </Button>
              </div>

              {feesList && feesList.length > 0 ? (
                <div className="space-y-4">
                  {feesList.map((f) => {
                    const feeTypeLabel = f.feeType === "works_percentage" ? "% Travaux" : f.feeType === "conception" ? "Conception" : "Planning";
                    const entries = (feeEntries ?? []).filter((e) => e.feeId === f.id);
                    const feeHt = parseFloat(f.feeAmountHt);
                    const invoiced = parseFloat(f.invoicedAmount ?? "0");
                    const progress = feeHt > 0 ? Math.min((invoiced / feeHt) * 100, 100) : 0;

                    return (
                      <LuxuryCard key={f.id} data-testid={`card-fee-tab-${f.id}`}>
                        <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">{feeTypeLabel}</h3>
                              <StatusBadge status={f.status} />
                            </div>
                            {f.feeRate && <p className="text-[11px] text-muted-foreground mt-0.5">Taux: {f.feeRate}%</p>}
                            {f.pennylaneRef && <p className="text-[10px] text-muted-foreground">PL: {f.pennylaneRef}</p>}
                          </div>
                          <Button variant="outline" onClick={() => openCreateEntry(f.id)} data-testid={`button-add-entry-tab-${f.id}`}>
                            <Plus size={12} />
                            <span className="text-[8px] font-bold uppercase tracking-widest">Entrée</span>
                          </Button>
                        </div>

                        <div className="grid grid-cols-3 gap-4 mb-3">
                          <div>
                            <TechnicalLabel>Montant HT</TechnicalLabel>
                            <p className="text-[13px] font-semibold text-foreground mt-0.5" data-testid={`text-fee-ht-tab-${f.id}`}>{formatCurrency(feeHt)}</p>
                          </div>
                          <div>
                            <TechnicalLabel>Facturé</TechnicalLabel>
                            <p className="text-[13px] font-semibold text-emerald-600 dark:text-emerald-400 mt-0.5">{formatCurrency(invoiced)}</p>
                          </div>
                          <div>
                            <TechnicalLabel>Restant</TechnicalLabel>
                            <p className="text-[13px] font-semibold text-amber-600 dark:text-amber-400 mt-0.5">{formatCurrency(feeHt - invoiced)}</p>
                          </div>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 mb-3">
                          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
                        </div>

                        {entries.length > 0 && (
                          <div className="border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-3">
                            <TechnicalLabel>Entrées ({entries.length})</TechnicalLabel>
                            <div className="mt-2 space-y-2">
                              {entries.map((entry) => (
                                <div
                                  key={entry.id}
                                  className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] flex items-center justify-between gap-3 flex-wrap"
                                  data-testid={`row-entry-tab-${entry.id}`}
                                >
                                  <div>
                                    <span className="text-[11px] text-foreground">Base: {formatCurrency(parseFloat(entry.baseHt))} x {entry.feeRate}%</span>
                                    {entry.pennylaneInvoiceRef && <p className="text-[10px] text-muted-foreground mt-0.5">PL: {entry.pennylaneInvoiceRef}</p>}
                                    {entry.dateInvoiced && <p className="text-[10px] text-muted-foreground">{entry.dateInvoiced}</p>}
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[12px] font-semibold text-foreground">{formatCurrency(parseFloat(entry.feeAmount))}</span>
                                    <StatusBadge status={entry.status} />
                                    <Button variant="ghost" size="icon" onClick={() => openEditEntry(entry)} data-testid={`button-edit-entry-tab-${entry.id}`}>
                                      <Pencil size={12} />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </LuxuryCard>
                    );
                  })}
                </div>
              ) : (
                <LuxuryCard data-testid="card-empty-fees-tab">
                  <p className="text-[12px] text-muted-foreground text-center py-8">
                    Aucun honoraire défini pour ce projet.
                  </p>
                </LuxuryCard>
              )}
            </div>

            <Dialog open={feeDialogOpen} onOpenChange={setFeeDialogOpen}>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-[16px] font-black uppercase tracking-tight">Nouvel Honoraire</DialogTitle>
                </DialogHeader>
                <Form {...feeForm}>
                  <form onSubmit={feeForm.handleSubmit((d) => createFeeMutation.mutate(d))} className="space-y-4">
                    <FormField control={feeForm.control} name="feeType" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Type</TechnicalLabel></FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl><SelectTrigger data-testid="select-fee-type-tab"><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="works_percentage">% Travaux</SelectItem>
                            <SelectItem value="conception">Conception</SelectItem>
                            <SelectItem value="planning">Planning</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={feeForm.control} name="baseAmountHt" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Base HT</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcFee()} data-testid="input-fee-base-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={feeForm.control} name="feeRate" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Taux (%)</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} type="number" step="0.01" onBlur={() => recalcFee()} data-testid="input-fee-rate-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={feeForm.control} name="feeAmountHt" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Montant HT</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcFee()} data-testid="input-fee-ht-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={feeForm.control} name="feeAmountTtc" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Montant TTC</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-fee-ttc-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <FormField control={feeForm.control} name="pennylaneRef" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Ref Penny Lane</TechnicalLabel></FormLabel>
                        <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-fee-pl-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <Button type="submit" className="w-full" disabled={createFeeMutation.isPending} data-testid="button-submit-fee-tab">
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {createFeeMutation.isPending ? "Création..." : "Créer l'honoraire"}
                      </span>
                    </Button>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>

            <Dialog open={entryDialogOpen} onOpenChange={setEntryDialogOpen}>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                    {editingEntryId ? "Modifier l'entrée" : "Nouvelle Entrée"}
                  </DialogTitle>
                </DialogHeader>
                <Form {...entryForm}>
                  <form onSubmit={entryForm.handleSubmit((d) => editingEntryId ? updateEntryMutation.mutate({ id: editingEntryId, data: d }) : createEntryMutation.mutate(d))} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={entryForm.control} name="baseHt" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Base HT</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcEntry()} data-testid="input-entry-base-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={entryForm.control} name="feeRate" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Taux (%)</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcEntry()} data-testid="input-entry-rate-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <FormField control={entryForm.control} name="feeAmount" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Montant</TechnicalLabel></FormLabel>
                        <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-entry-amount-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={entryForm.control} name="pennylaneInvoiceRef" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Ref facture Penny Lane</TechnicalLabel></FormLabel>
                        <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-entry-pl-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={entryForm.control} name="dateInvoiced" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Date facturation</TechnicalLabel></FormLabel>
                        <FormControl><Input type="date" {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-entry-date-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={entryForm.control} name="status" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Statut</TechnicalLabel></FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl><SelectTrigger data-testid="select-entry-status-tab"><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="pending">En attente</SelectItem>
                            <SelectItem value="invoiced">Facturé</SelectItem>
                            <SelectItem value="paid">Payé</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <Button type="submit" className="w-full" disabled={createEntryMutation.isPending || updateEntryMutation.isPending} data-testid="button-submit-entry-tab">
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {(createEntryMutation.isPending || updateEntryMutation.isPending) ? "Enregistrement..." : editingEntryId ? "Mettre à jour" : "Créer l'entrée"}
                      </span>
                    </Button>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
