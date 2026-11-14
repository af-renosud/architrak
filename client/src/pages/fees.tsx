import { useState } from "react";
import "@/components/fees/fee-register.css";
import { FeeProjectRegister } from "@/components/fees/FeeProjectRegister";
import { FeeDisclosure } from "@/components/fees/FeeDisclosure";
import { FeeVisibilityAction, FeeHistory, FeePortfolioHistory } from "@/components/fees/FeeVisibility";
import { useFeeVisibility, invalidateFeeReads } from "@/hooks/use-fee-visibility";
import { detectedForProject, unassignedDetected, feeGroupMatchesVisibility, feeEntryMatchesVisibility, registerTotals, type VisibilityFilter } from "@/lib/fee-register";
import type { OutstandingFeeSummary } from "@shared/fee-description";
import { AppLayout } from "@/components/layout/AppLayout";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Copy, Check, ReceiptEuro, AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { OutstandingFeesPanel } from "@/components/fees/OutstandingFeesPanel";
import { DetectedFeeInvoiceCard, usePendingFeeInvoices } from "@/components/fees/DetectedFeeInvoiceCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { insertFeeSchema, insertFeeEntrySchema } from "@shared/schema";
import type { Project, Fee, FeeEntry } from "@shared/schema";
import { z } from "zod";

import { Amount } from "@/components/ui/amount";

const PHASE_OPTIONS = [
  { value: "conception", label: "Conception" },
  { value: "chantier", label: "Chantier" },
  { value: "aor", label: "AOR" },
] as const;

const PHASE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  conception: { bg: "bg-[#0B2545]/10", text: "text-[#0B2545] dark:text-[#8BA4C7]", border: "border-[#0B2545]/20" },
  chantier: { bg: "bg-[#c1a27b]/15", text: "text-[#8B6914] dark:text-[#c1a27b]", border: "border-[#c1a27b]/30" },
  aor: { bg: "bg-emerald-500/10", text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-500/20" },
  unassigned: { bg: "bg-muted", text: "text-muted-foreground", border: "border-muted" },
};

function PhaseBadge({ phase }: { phase: string | null }) {
  const p = phase ?? "unassigned";
  const colors = PHASE_COLORS[p] ?? PHASE_COLORS.unassigned;
  const label = PHASE_OPTIONS.find(o => o.value === p)?.label ?? "Unassigned";
  return (
    <Badge variant="outline" className={`${colors.bg} ${colors.text} ${colors.border} text-[10px]`} data-testid={`badge-phase-${p}`}>
      {label}
    </Badge>
  );
}

type DesignContractMilestoneRow = {
  id: number;
  sequence: number;
  labelFr: string;
  labelEn: string | null;
  percentage: string;
  amountTtc: string;
  status: string;
  triggerEvent: string;
  reachedAt: string | null;
  invoicedAt: string | null;
  paidAt: string | null;
  pennylaneInvoiceNumber: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  paymentDate: string | null;
  notes: string | null;
};
type PhaseByData = {
  designContract?: DesignContractSummary | null;
  phases: Array<{ phase: string; fees: Fee[]; totalHt: number; totalTtc: number; totalInvoiced: number; totalInvoicedTtc: number; totalRemaining: number; totalRemainingTtc: number }>;
  grandTotals: { totalHt: number; totalTtc: number; totalInvoiced: number; totalInvoicedTtc: number; totalRemaining: number; totalRemainingTtc: number };
};

const MILESTONE_STATUS_STYLE: Record<string, { bg: string; badge: string; label: string }> = {
  pending: { bg: "bg-card border-border", badge: "bg-muted text-muted-foreground", label: "Pending" },
  reached: { bg: "bg-amber-50 border-amber-200", badge: "bg-amber-100 text-amber-900", label: "Reached" },
  invoiced: { bg: "bg-sky-50 border-sky-200", badge: "bg-sky-100 text-sky-900", label: "Invoiced" },
  paid: { bg: "bg-emerald-50 border-emerald-200", badge: "bg-emerald-100 text-emerald-900", label: "Paid" },
};
const feeFormSchema = insertFeeSchema.extend({
  phase: z.enum(["conception", "chantier", "aor"], { error: "Phase is required" }),
  feeAmountHt: z.string().min(1, "HT amount is required"),
  remainingAmount: z.string().min(1, "Remaining amount is required"),
});

type FeeFormValues = z.infer<typeof feeFormSchema>;

const feeEntryFormSchema = insertFeeEntrySchema.extend({
  baseHt: z.string().min(1, "Base HT is required"),
  feeRate: z.string().min(1, "Rate is required"),
  feeAmount: z.string().min(1, "Amount is required"),
});

type FeeEntryFormValues = z.infer<typeof feeEntryFormSchema>;

function FeeTypeLabel({ type }: { type: string }) {
  const labels: Record<string, string> = {
    works_percentage: "% Works",
    conception: "Conception",
    planning: "Planning",
  };
  return <span>{labels[type] ?? type}</span>;
}

function CopyEntryButton({ entryId }: { entryId: number }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      const res = await fetch(`/api/fee-entries/${entryId}/copy-text`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load description");
      const { text } = (await res.json()) as { text: string };
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ title: "Invoice description copied" });
    } catch {
      toast({
        title: "Copy failed",
        description: "Clipboard or network unavailable.",
        variant: "destructive",
      });
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 px-2 border-[#c1a27b]/40 text-[#0B2545] hover:bg-[#c1a27b]/10"
      onClick={onCopy}
      data-testid={`button-copy-entry-${entryId}`}
      title="Copy invoice description for accounting"
    >
      {copied ? <Check size={12} className="mr-1" /> : <Copy size={12} className="mr-1" />}
      <span className="text-[9px] font-bold uppercase tracking-widest">
        {copied ? "Copied" : "Copy"}
      </span>
    </Button>
  );
}

export default function Fees() {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [feeDialogOpen, setFeeDialogOpen] = useState(false);
  const [entryDialogOpen, setEntryDialogOpen] = useState(false);
  const [selectedFeeId, setSelectedFeeId] = useState<number | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [phaseFilter, setPhaseFilter] = useState<string>("all");
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("active");
  const [activeTab, setActiveTab] = useState("register");
  const [collapseVersion, setCollapseVersion] = useState(0);
  const visibility = useFeeVisibility(selectedProjectId);
  const { toast } = useToast();

  const { data: projects, isLoading: loadingProjects, error: projectsError, refetch: retryProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const detection = usePendingFeeInvoices();
  const pendingDetected = detection.data;
  const attention = useQuery<OutstandingFeeSummary>({
    queryKey: selectedProjectId ? ["/api/projects", String(selectedProjectId), "fees", "outstanding"] : ["/api/fees/outstanding"],
  });
  const { data: feesList, isLoading: loadingFees, error: feesError, refetch: retryFees } = useQuery<Fee[]>({
    queryKey: ["/api/projects", String(selectedProjectId), "fees"],
    enabled: !!selectedProjectId,
  });

  const { data: feeEntries, isLoading: loadingEntries, error: entriesError, refetch: retryEntries } = useQuery<FeeEntry[]>({
    queryKey: ["/api/projects", String(selectedProjectId), "fee-entries"],
    enabled: !!selectedProjectId,
  });

  const { data: phaseData, isLoading: loadingPhase, error: phaseError, refetch: retryPhase } = useQuery<PhaseByData>({
    queryKey: ["/api/projects", String(selectedProjectId), "fees", "by-phase"],
    enabled: !!selectedProjectId,
  });

  const feeForm = useForm<FeeFormValues>({
    resolver: zodResolver(feeFormSchema),
    defaultValues: {
      projectId: 0,
      feeType: "works_percentage",
      phase: "conception" as const,
      baseAmountHt: "0.00",
      feeRate: null,
      feeAmountHt: "0.00",
      invoicedAmount: "0.00",
      remainingAmount: "0.00",
      pennylaneRef: null,
      status: "pending",
    },
  });

  const entryForm = useForm<FeeEntryFormValues>({
    resolver: zodResolver(feeEntryFormSchema),
    defaultValues: {
      feeId: 0,
      invoiceId: null,
      devisId: null,
      baseHt: "0.00",
      feeRate: "0.00",
      feeAmount: "0.00",
      pennylaneInvoiceRef: null,
      dateInvoiced: null,
      status: "pending",
    },
  });

  const createFeeMutation = useMutation({
    mutationFn: async (data: FeeFormValues) => {
      const res = await apiRequest("POST", "/api/fees", data);
      return res.json();
    },
    onSuccess: () => {
      invalidateFeeReads(selectedProjectId);
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "fees"] });
      setFeeDialogOpen(false);
      feeForm.reset();
      toast({ title: "Fee created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateFeeMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<FeeFormValues> }) => {
      const res = await apiRequest("PATCH", `/api/fees/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      invalidateFeeReads(selectedProjectId);
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "fees"] });
      toast({ title: "Fee updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createEntryMutation = useMutation({
    mutationFn: async (data: FeeEntryFormValues) => {
      const res = await apiRequest("POST", `/api/fees/${data.feeId}/entries`, data);
      return res.json();
    },
    onSuccess: () => {
      invalidateFeeReads(selectedProjectId);
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "fee-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "fees"] });
      setEntryDialogOpen(false);
      entryForm.reset();
      toast({ title: "Entry created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateEntryMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<FeeEntryFormValues> }) => {
      const res = await apiRequest("PATCH", `/api/fee-entries/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      invalidateFeeReads(selectedProjectId);
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "fee-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(selectedProjectId), "fees"] });
      setEntryDialogOpen(false);
      setEditingEntryId(null);
      entryForm.reset();
      toast({ title: "Entry updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const openCreateFee = () => {
    if (!selectedProjectId) {
      toast({ title: "Please select a project first", variant: "destructive" });
      return;
    }
    feeForm.reset({
      projectId: parseInt(selectedProjectId),
      feeType: "works_percentage",
      phase: "conception" as const,
      baseAmountHt: "0.00",
      feeRate: null,
      feeAmountHt: "0.00",
      invoicedAmount: "0.00",
      remainingAmount: "0.00",
      pennylaneRef: null,
      status: "pending",
    });
    setFeeDialogOpen(true);
  };

  const openCreateEntry = (feeId: number) => {
    const fee = feesList?.find((f) => f.id === feeId);
    setSelectedFeeId(feeId);
    setEditingEntryId(null);
    entryForm.reset({
      feeId,
      invoiceId: null,
      devisId: null,
      baseHt: "0.00",
      feeRate: fee?.feeRate ?? "0.00",
      feeAmount: "0.00",
      pennylaneInvoiceRef: null,
      dateInvoiced: null,
      status: "pending",
    });
    setEntryDialogOpen(true);
  };

  const openEditEntry = (entry: FeeEntry) => {
    setSelectedFeeId(entry.feeId);
    setEditingEntryId(entry.id);
    entryForm.reset({
      feeId: entry.feeId,
      invoiceId: entry.invoiceId,
      devisId: entry.devisId,
      baseHt: entry.baseHt,
      feeRate: entry.feeRate,
      feeAmount: entry.feeAmount,
      pennylaneInvoiceRef: entry.pennylaneInvoiceRef,
      dateInvoiced: entry.dateInvoiced,
      status: entry.status,
    });
    setEntryDialogOpen(true);
  };

  const recalculateFee = () => {
    const base = parseFloat(feeForm.watch("baseAmountHt") || "0");
    const rate = parseFloat(feeForm.watch("feeRate") || "0");
    const feeType = feeForm.watch("feeType");
    let feeHt: number;
    if (feeType === "works_percentage") {
      feeHt = base * (rate / 100);
    } else {
      feeHt = parseFloat(feeForm.watch("feeAmountHt") || "0");
    }
    const invoiced = parseFloat(feeForm.watch("invoicedAmount") || "0");
    feeForm.setValue("feeAmountHt", feeHt.toFixed(2));
    feeForm.setValue("remainingAmount", (feeHt - invoiced).toFixed(2));
  };

  const recalculateEntry = () => {
    const base = parseFloat(entryForm.watch("baseHt") || "0");
    const rate = parseFloat(entryForm.watch("feeRate") || "0");
    const amount = base * (rate / 100);
    entryForm.setValue("feeAmount", amount.toFixed(2));
  };

  const onSubmitFee = (data: FeeFormValues) => {
    createFeeMutation.mutate(data);
  };

  const onSubmitEntry = (data: FeeEntryFormValues) => {
    if (editingEntryId) {
      updateEntryMutation.mutate({ id: editingEntryId, data });
    } else {
      createEntryMutation.mutate(data);
    }
  };

  // Architect fees (honoraires) are invoiced at the standard 20% TVA rate.
  const FEE_TVA_RATE = 0.20;
  const designContract = phaseData?.designContract ?? null;
  const coveredFeeIds = new Set(designContract?.coveredFeeIds ?? []);

  // Full records, never visibility-filtered. Contract replaces covered mirrors;
  // documentary HT remains unknown unless supplied by the contract.
  const { totalFeeEarnedTtc, totalInvoicedTtc, totalRemainingTtc, totalFeeEarned, totalInvoiced, totalRemaining } = registerTotals(feesList ?? [], designContract);

  const recordFor = (kind: "fee" | "entry", id: number) => visibility.data?.records.find(record => record.kind === kind && record.id === id);
  const filteredFees = (feesList ?? []).filter(f => {
    if (phaseFilter !== "all" && (f.phase ?? "unassigned") !== phaseFilter) return false;
    return feeGroupMatchesVisibility(recordFor("fee", f.id),
      (feeEntries ?? []).filter(entry => entry.feeId === f.id).map(entry => recordFor("entry", entry.id)), visibilityFilter);
  });
  const isLoading = loadingProjects || loadingFees || loadingEntries || loadingPhase || (!!selectedProjectId && visibility.isLoading);
  const projectError = feesError || entriesError || phaseError || visibility.error;
  const matchingPendingForProject = detectedForProject(pendingDetected ?? [], selectedProjectId);
  const unassigned = unassignedDetected(pendingDetected ?? []);
  const attentionCount = attention.data && detection.data ? attention.data.totalCount + matchingPendingForProject.length : null;

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
            Honoraires
          </h1>
          <Button onClick={openCreateFee} disabled={!selectedProjectId} data-testid="button-new-fee">
            <Plus size={14} />
            <span className="text-[9px] font-bold uppercase tracking-widest">New Fee</span>
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">Fee work and invoicing, backed by original external accounting documents. An accounting reference is not proof of payment.</p>
        <div className="fee-register-filters flex flex-wrap gap-4 items-end">
          <div className="w-full md:w-72">
            <TechnicalLabel>Project</TechnicalLabel>
            <Select value={selectedProjectId || "all"} onValueChange={value => setSelectedProjectId(value === "all" ? "" : value)}>
              <SelectTrigger data-testid="select-fee-project-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {(projects ?? []).map(project => <SelectItem key={project.id} value={String(project.id)}>{project.code} — {project.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="w-full md:w-48">
            <TechnicalLabel>Phase · register</TechnicalLabel>
            <Select value={phaseFilter} onValueChange={setPhaseFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All phases</SelectItem>
                {PHASE_OPTIONS.map(phase => <SelectItem key={phase.value} value={phase.value}>{phase.label}</SelectItem>)}
                <SelectItem value="unassigned">Unassigned</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-full md:w-44">
            <TechnicalLabel>Visibility · register</TechnicalLabel>
            <Select value={visibilityFilter} onValueChange={value => setVisibilityFilter(value as VisibilityFilter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="archived">Archived</SelectItem><SelectItem value="all">All</SelectItem></SelectContent>
            </Select>
          </div>
          <Button variant="ghost" onClick={() => { setSelectedProjectId(""); setPhaseFilter("all"); setVisibilityFilter("active"); }}>Reset filters</Button>
        </div>
        <div className="fee-register-tabs" role="tablist" aria-label="Honoraires views">
          {[["register", "Fee register"], ["attention", `Needs attention (${attentionCount ?? "…"})`], ["history", "History"]].map(([value, label]) =>
            <Button key={value} role="tab" aria-selected={activeTab === value} variant={activeTab === value ? "default" : "ghost"} onClick={() => setActiveTab(value)}>{label}</Button>)}
        </div>
        {projectsError && <LuxuryCard><p role="alert" className="text-sm text-destructive">Unable to load projects: {projectsError.message}</p><Button variant="outline" onClick={() => retryProjects()}>Retry projects</Button></LuxuryCard>}
        {detection.error && <LuxuryCard><p role="alert" className="text-sm text-destructive">Detected invoices unavailable: {detection.error.message}</p><Button variant="outline" onClick={() => detection.refetch()}>Retry detection</Button></LuxuryCard>}
        {attention.error && <LuxuryCard><p role="alert" className="text-sm text-destructive">Attention count unavailable: {attention.error.message}</p><Button variant="outline" onClick={() => attention.refetch()}>Retry accounting queue</Button></LuxuryCard>}
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <AlertTriangle size={14} />
          <span>{attention.data?.totalCount ?? "…"} accounting references to reconcile · {detection.data ? matchingPendingForProject.length : "…"} detected originals in scope</span>
          {attention.data?.buckets.map(bucket => <span key={bucket.label}>{bucket.label} days: {bucket.count}</span>)}
          {selectedProjectId && <span>{unassigned.length} unassigned detected originals in global review</span>}
          <Link href="/honoraires/factures-detectees" className="underline">Global document review ({pendingDetected?.length ?? "…"})</Link>
        </div>
        {activeTab === "attention" && <p className="text-xs text-muted-foreground">Attention includes all phases and archived work. Project candidates are suggestions only; amounts never assign a document. Unassigned originals are available in global review.</p>}
        {activeTab === "attention" && detection.isLoading && <Skeleton className="h-24" />}
        {activeTab === "attention" && detection.data && !matchingPendingForProject.length && <LuxuryCard><p className="text-sm text-muted-foreground">No detected originals awaiting review in this project scope. This is not a completeness or payment check.</p></LuxuryCard>}
        {activeTab === "attention" && matchingPendingForProject.length > 0 && (
          <div className="space-y-2" data-testid="banner-pending-fee-invoices">
            <div className="flex items-center gap-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2">
              <AlertTriangle size={14} className="text-amber-600 shrink-0" />
              <p className="text-xs text-amber-900 dark:text-amber-200">
                {matchingPendingForProject.length === 1
                  ? "1 facture d'honoraires détectée dans Gmail attend votre vérification."
                  : `${matchingPendingForProject.length} factures d'honoraires détectées dans Gmail attendent votre vérification.`}
              </p>
            </div>
            <div className="space-y-3">
              {matchingPendingForProject.map((row) => (
                <div key={row.id}>
                  {unassigned.some(item => item.id === row.id) && <p className="text-xs text-amber-800 mb-1">Unassigned · global review required</p>}
                  <DetectedFeeInvoiceCard row={row} compact scopeProjectId={selectedProjectId || undefined} />
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "attention" && <OutstandingFeesPanel
          scope={selectedProjectId ? "project" : "global"}
          projectId={selectedProjectId ? parseInt(selectedProjectId) : undefined}
        />}
        {activeTab === "history" && (!selectedProjectId ? <FeePortfolioHistory projects={projects ?? []} /> : visibility.isLoading ? <Skeleton className="h-24" /> : visibility.data && <FeeHistory events={visibility.data.events} />)}
        {selectedProjectId && projectError && <LuxuryCard><p role="alert" className="text-sm text-destructive">Project data unavailable. Totals and visibility cannot be verified: {projectError.message}</p><Button variant="outline" onClick={() => { void retryFees(); void retryEntries(); void retryPhase(); void visibility.refetch(); }}>Retry project data</Button></LuxuryCard>}
        {activeTab === "register" && <>
        {loadingProjects ? <Skeleton className="h-24" /> : <FeeProjectRegister projects={(projects ?? []).filter(project => !selectedProjectId || String(project.id) === selectedProjectId)} selectedProjectId={selectedProjectId} onSelect={setSelectedProjectId} phase={phaseFilter} visibility={visibilityFilter} />}
        {selectedProjectId && <div className="flex justify-between gap-3 items-center"><p className="text-xs text-muted-foreground">Project totals include archives and every phase. Remaining means not yet invoiced, not unpaid.</p><Button variant="outline" size="sm" onClick={() => setCollapseVersion(value => value + 1)}>Collapse all</Button></div>}
        {selectedProjectId && !isLoading && !projectError && designContract && (
          <FeeDisclosure key={`contract-${selectedProjectId}`} collapseVersion={collapseVersion} summary={<>Design contract · {designContract.milestones.length} milestones · <Amount value={designContract.totalTtc} denomination="TTC" /></>}>
          <LuxuryCard data-testid="card-design-contract-milestones">
            <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
              <TechnicalLabel>
                Design contract — payment milestones (
                {designContract.milestones.filter((m) => m.status !== "pending").length}/
                {designContract.milestones.length} reached)
              </TechnicalLabel>
              <Badge variant="outline" className="text-[10px]" data-testid="badge-milestone-billed">
                Milestone-billed
              </Badge>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <TechnicalLabel>Contract total</TechnicalLabel>
                <p className="text-[16px] font-light text-foreground" data-testid="text-contract-total-ttc">
                  <Amount value={designContract.totalTtc} denomination="TTC" />
                </p>
                {designContract.totalHt != null && (
                  <p className="text-[12px] text-muted-foreground" data-testid="text-contract-total-ht">
                    <Amount value={designContract.totalHt} denomination="HT" />
                  </p>
                )}
              </div>
              <div>
                <TechnicalLabel>Invoiced (milestones)</TechnicalLabel>
                <p className="text-[16px] font-light text-emerald-600 dark:text-emerald-400" data-testid="text-contract-invoiced-ttc">
                  <Amount value={designContract.invoicedTtc} denomination="TTC" />
                </p>
                {designContract.invoicedHt != null && (
                  <p className="text-[12px] text-muted-foreground" data-testid="text-contract-invoiced-ht">
                    <Amount value={designContract.invoicedHt} denomination="HT" />
                  </p>
                )}
              </div>
              <div>
                <TechnicalLabel>Remaining</TechnicalLabel>
                <p className="text-[16px] font-light text-amber-600 dark:text-amber-400" data-testid="text-contract-remaining-ttc">
                  <Amount value={designContract.remainingTtc} denomination="TTC" />
                </p>
                {designContract.remainingHt != null && (
                  <p className="text-[12px] text-muted-foreground" data-testid="text-contract-remaining-ht">
                    <Amount value={designContract.remainingHt} denomination="HT" />
                  </p>
                )}
              </div>
            </div>
            {matchingPendingForProject.length > 0 && (
              <Link href="/honoraires/factures-detectees">
                <div
                  className="flex items-center gap-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 mb-3 cursor-pointer hover-elevate"
                  data-testid="alert-design-contract-pending-invoice"
                >
                  <ReceiptEuro size={14} className="text-amber-600 shrink-0" />
                  <p className="text-xs text-amber-900 dark:text-amber-200">
                    {matchingPendingForProject.length === 1
                      ? `Facture détectée ${matchingPendingForProject[0].invoiceNumber ?? ""} (${matchingPendingForProject[0].amountTtc ? `${Number(matchingPendingForProject[0].amountTtc).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}` : ""}) semble correspondre à ce contrat — à vérifier.`
                      : `${matchingPendingForProject.length} factures d'honoraires détectées semblent correspondre à ce contrat — à vérifier.`}
                  </p>
                </div>
              </Link>
            )}
            <div className="space-y-1">
              {designContract.milestones.map((m) => {
                const style = MILESTONE_STATUS_STYLE[m.status] ?? MILESTONE_STATUS_STYLE.pending;
                return (
                  <div
                    key={m.id}
                    className={`flex items-center gap-3 p-2 rounded border ${style.bg}`}
                    data-testid={`row-fee-milestone-${m.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate flex items-center gap-2">
                        #{m.sequence} · {m.labelFr}
                        <span
                          className={`text-[9px] uppercase px-1.5 py-0.5 rounded ${style.badge}`}
                          data-testid={`badge-fee-milestone-status-${m.id}`}
                        >
                          {style.label}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {m.invoiceNumber ? (
                          <span data-testid={`text-fee-milestone-invoice-number-${m.id}`}>
                            Invoice {m.invoiceNumber}
                          </span>
                        ) : null}
                        {m.invoiceDate ? (
                          <span data-testid={`text-fee-milestone-invoice-date-${m.id}`}>
                            {m.invoiceNumber ? " dated " : "Invoiced "}{new Date(m.invoiceDate).toLocaleDateString()}
                          </span>
                        ) : m.invoicedAt && !m.invoiceDate ? (
                          `Invoiced ${new Date(m.invoicedAt).toLocaleDateString()}`
                        ) : null}
                        {(m.status === "invoiced" || m.status === "paid") &&
                        m.pennylaneInvoiceNumber &&
                        m.pennylaneInvoiceNumber !== m.invoiceNumber ? (
                          <span data-testid={`text-fee-milestone-pennylane-number-${m.id}`}>
                            {" · Pennylane "}{m.pennylaneInvoiceNumber}
                          </span>
                        ) : null}
                        {m.paymentDate ? (
                          <span data-testid={`text-fee-milestone-payment-date-${m.id}`}>
                            {" · paid "}{new Date(m.paymentDate).toLocaleDateString()}
                          </span>
                        ) : m.paidAt && !m.paymentDate ? (
                          ` · paid ${new Date(m.paidAt).toLocaleDateString()}`
                        ) : null}
                        {m.notes ? (
                          <span data-testid={`text-fee-milestone-notes-${m.id}`}>
                            {" · "}{m.notes}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-medium" data-testid={`text-fee-milestone-amount-${m.id}`}>
                        <Amount value={parseFloat(m.amountTtc)} denomination="TTC" />
                      </div>
                      <div className="text-[10px] text-muted-foreground">{Number(m.percentage).toFixed(2)}%</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </LuxuryCard>
          </FeeDisclosure>
        )}

        {!selectedProjectId ? (
          <LuxuryCard data-testid="card-no-project-selected">
            <p className="text-[12px] text-muted-foreground text-center py-8">
              Select a project to view Honoraires tracking.
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
        ) : projectError ? null : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <LuxuryCard data-testid="card-total-fee-earned">
                <TechnicalLabel>Total Honoraires</TechnicalLabel>
                <p className="text-[20px] font-light text-foreground mt-2" data-testid="text-total-earned">
                  {totalFeeEarned != null
                    ? <Amount value={totalFeeEarned} denomination="HT" />
                    : <Amount value={totalFeeEarnedTtc} denomination="TTC" />}
                </p>
                <p className="text-[13px] text-muted-foreground" data-testid="text-total-earned-ttc">
                  {totalFeeEarned != null
                    ? <Amount value={totalFeeEarnedTtc} denomination="TTC" />
                    : <span data-testid="text-total-earned-ht-unknown">HT unavailable (contract has no TVA data)</span>}
                </p>
              </LuxuryCard>
              <LuxuryCard data-testid="card-total-invoiced">
                <TechnicalLabel>Total Invoiced</TechnicalLabel>
                <p className="text-[20px] font-light text-emerald-600 dark:text-emerald-400 mt-2" data-testid="text-total-invoiced">
                  {totalInvoiced != null
                    ? <Amount value={totalInvoiced} denomination="HT" />
                    : <Amount value={totalInvoicedTtc} denomination="TTC" />}
                </p>
                <p className="text-[13px] text-muted-foreground" data-testid="text-total-invoiced-ttc">
                  {totalInvoiced != null
                    ? <Amount value={totalInvoicedTtc} denomination="TTC" />
                    : <span data-testid="text-total-invoiced-ht-unknown">HT unavailable (contract has no TVA data)</span>}
                </p>
              </LuxuryCard>
              <LuxuryCard data-testid="card-total-remaining">
                <TechnicalLabel>Remaining to Invoice</TechnicalLabel>
                <p className="text-[20px] font-light text-amber-600 dark:text-amber-400 mt-2" data-testid="text-total-remaining">
                  {totalRemaining != null
                    ? <Amount value={totalRemaining} denomination="HT" />
                    : <Amount value={totalRemainingTtc} denomination="TTC" />}
                </p>
                <p className="text-[13px] text-muted-foreground" data-testid="text-total-remaining-ttc">
                  {totalRemaining != null
                    ? <Amount value={totalRemainingTtc} denomination="TTC" />
                    : <span data-testid="text-total-remaining-ht-unknown">HT unavailable (contract has no TVA data)</span>}
                </p>
              </LuxuryCard>
            </div>

            {filteredFees && filteredFees.length > 0 ? (
              <div className="space-y-4">
                {filteredFees.map((fee) => {
                  const parentVisibility = recordFor("fee", fee.id);
                  const entries = (feeEntries ?? []).filter((e) => e.feeId === fee.id && feeEntryMatchesVisibility(parentVisibility, recordFor("entry", e.id), visibilityFilter));
                  const archiveContextOnly = visibilityFilter === "archived" && parentVisibility?.archived === false;
                  const feeHt = parseFloat(fee.feeAmountHt);
                  const feeTtc = feeHt * (1 + FEE_TVA_RATE);
                  const invoiced = parseFloat(fee.invoicedAmount ?? "0");
                  const invoicedTtc = invoiced * (1 + FEE_TVA_RATE);
                  const remaining = feeHt - invoiced;
                  const remainingTtc = feeTtc - invoicedTtc;
                  const progress = feeHt > 0 ? Math.min((invoiced / feeHt) * 100, 100) : 0;

                  return (
                    <FeeDisclosure key={`${selectedProjectId}-${fee.id}`} collapseVersion={collapseVersion} summary={<span className="inline-flex flex-wrap gap-3 items-center"><FeeTypeLabel type={fee.feeType} /><PhaseBadge phase={fee.phase} /><span className="font-normal text-muted-foreground">{coveredFeeIds.has(fee.id) ? "Contract mirror · see milestones" : <Amount value={feeHt} denomination="HT" />} · {entries.length} entries · {parentVisibility?.archived ? "Archived fee · all children shown" : archiveContextOnly ? "Active fee · context for archived entries only" : "Active"}</span></span>}>
                    <LuxuryCard data-testid={`card-fee-${fee.id}`}>
                      {archiveContextOnly && <p className="text-xs text-muted-foreground mb-3">This fee is active. It appears here only as context for its independently archived entries.</p>}
                      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">
                              <FeeTypeLabel type={fee.feeType} />
                            </h3>
                            {coveredFeeIds.has(fee.id) ? (
                              <Badge
                                variant="outline"
                                className="bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20 text-[10px]"
                                data-testid={`badge-covered-by-contract-${fee.id}`}
                              >
                                Covered by design contract
                              </Badge>
                            ) : (
                              <>
                                <PhaseBadge phase={fee.phase} />
                                <StatusBadge status={fee.status} />
                              </>
                            )}
                          </div>
                          {fee.feeRate && (
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              Rate: {fee.feeRate}%
                            </p>
                          )}
                          {fee.pennylaneRef && (
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              Penny Lane: {fee.pennylaneRef}
                            </p>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          onClick={() => openCreateEntry(fee.id)}
                          data-testid={`button-add-entry-${fee.id}`}
                        >
                          <Plus size={12} />
                          <span className="text-[8px] font-bold uppercase tracking-widest">Add Entry</span>
                        </Button>
                        <FeeVisibilityAction projectId={selectedProjectId} record={recordFor("fee", fee.id)} />
                      </div>

                      {coveredFeeIds.has(fee.id) && <p className="text-xs text-muted-foreground mb-3">Legacy contract mirror. These figures are not added to project totals; the contract above is authoritative.</p>}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-3">
                        <div>
                          <TechnicalLabel>Amount HT</TechnicalLabel>
                          <p className="text-[13px] font-semibold text-foreground mt-0.5" data-testid={`text-fee-amount-${fee.id}`}>
                            <Amount value={feeHt} denomination="HT" />
                          </p>
                          <p className="text-[11px] text-muted-foreground" data-testid={`text-fee-amount-ttc-${fee.id}`}>
                            <Amount value={feeTtc} denomination="TTC" />
                          </p>
                        </div>
                        <div>
                          <TechnicalLabel>Invoiced</TechnicalLabel>
                          <p className="text-[13px] font-semibold text-emerald-600 dark:text-emerald-400 mt-0.5" data-testid={`text-fee-invoiced-${fee.id}`}>
                            <Amount value={invoiced} denomination="HT" />
                          </p>
                          <p className="text-[11px] text-muted-foreground" data-testid={`text-fee-invoiced-ttc-${fee.id}`}>
                            <Amount value={invoicedTtc} denomination="TTC" />
                          </p>
                        </div>
                        <div>
                          <TechnicalLabel>Remaining</TechnicalLabel>
                          <p className="text-[13px] font-semibold text-amber-600 dark:text-amber-400 mt-0.5" data-testid={`text-fee-remaining-${fee.id}`}>
                            <Amount value={remaining} denomination="HT" />
                          </p>
                          <p className="text-[11px] text-muted-foreground" data-testid={`text-fee-remaining-ttc-${fee.id}`}>
                            <Amount value={remainingTtc} denomination="TTC" />
                          </p>
                        </div>
                      </div>

                      <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 mb-4">
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${progress}%` }}
                        />
                      </div>

                      {entries.length > 0 && (
                        <div className="border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-3">
                          <TechnicalLabel>Entries ({entries.length})</TechnicalLabel>
                          <div className="mt-2 space-y-2">
                            {entries.map((entry) => (
                              <div
                                key={entry.id}
                                className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] flex items-center justify-between gap-3 flex-wrap"
                                data-testid={`row-fee-entry-${entry.id}`}
                              >
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[11px] text-foreground">
                                      Base: <Amount value={parseFloat(entry.baseHt)} denomination="HT" />
                                    </span>
                                    <span className="text-[10px] text-muted-foreground">
                                      x {entry.feeRate}%
                                    </span>
                                  </div>
                                  {entry.pennylaneInvoiceRef && (
                                    <p className="text-[10px] text-muted-foreground mt-0.5" data-testid={`text-entry-pennylane-${entry.id}`}>
                                      PL: {entry.pennylaneInvoiceRef}
                                    </p>
                                  )}
                                  {entry.dateInvoiced && (
                                    <p className="text-[10px] text-muted-foreground">{entry.dateInvoiced}</p>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-[12px] font-semibold text-foreground" data-testid={`text-entry-amount-${entry.id}`}>
                                    <Amount value={parseFloat(entry.feeAmount)} denomination="HT" />
                                  </span>
                                  <StatusBadge status={entry.status} />
                                  {fee.feeType === "works_percentage" &&
                                    entry.status === "pending" &&
                                    !entry.pennylaneInvoiceRef && (
                                      <CopyEntryButton entryId={entry.id} />
                                    )}
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => openEditEntry(entry)}
                                    data-testid={`button-edit-entry-${entry.id}`}
                                  >
                                    <Pencil size={12} />
                                  </Button>
                                  <FeeVisibilityAction projectId={selectedProjectId} record={recordFor("entry", entry.id)} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </LuxuryCard>
                    </FeeDisclosure>
                  );
                })}
              </div>
            ) : (
              <LuxuryCard data-testid="card-empty-fees">
                <p className="text-[12px] text-muted-foreground text-center py-8">
                  No fee groups match these filters. Project totals still include all phases and archives.
                </p>
              </LuxuryCard>
            )}
          </>
        )}
        </>}

        <Dialog open={feeDialogOpen} onOpenChange={setFeeDialogOpen}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                New Fee
              </DialogTitle>
            </DialogHeader>
            <Form {...feeForm}>
              <form onSubmit={feeForm.handleSubmit(onSubmitFee)} className="space-y-4">
                <FormField
                  control={feeForm.control}
                  name="feeType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Fee Type</TechnicalLabel>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-fee-type">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="works_percentage">% Works</SelectItem>
                          <SelectItem value="conception">Conception</SelectItem>
                          <SelectItem value="planning">Planning</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={feeForm.control}
                  name="phase"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Phase</TechnicalLabel>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-fee-phase">
                            <SelectValue placeholder="Select phase" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="conception">Conception</SelectItem>
                          <SelectItem value="chantier">Chantier</SelectItem>
                          <SelectItem value="aor">AOR</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={feeForm.control}
                    name="baseAmountHt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Base Amount HT</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            step="0.01"
                            onBlur={() => recalculateFee()}
                            data-testid="input-fee-base"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={feeForm.control}
                    name="feeRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Rate (%)</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            onChange={(e) => field.onChange(e.target.value || null)}
                            type="number"
                            step="0.01"
                            onBlur={() => recalculateFee()}
                            data-testid="input-fee-rate"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={feeForm.control}
                  name="feeAmountHt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Fee Amount HT</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          step="0.01"
                          onBlur={() => recalculateFee()}
                          data-testid="input-fee-amount-ht"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={feeForm.control}
                  name="pennylaneRef"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Penny Lane Reference</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) => field.onChange(e.target.value || null)}
                          data-testid="input-fee-pennylane"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full" disabled={createFeeMutation.isPending} data-testid="button-submit-fee">
                  <span className="text-[9px] font-bold uppercase tracking-widest">
                    {createFeeMutation.isPending ? "Creating..." : "Create Fee"}
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
                {editingEntryId ? "Edit Entry" : "New Entry"}
              </DialogTitle>
            </DialogHeader>
            <Form {...entryForm}>
              <form onSubmit={entryForm.handleSubmit(onSubmitEntry)} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={entryForm.control}
                    name="baseHt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Base HT</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            step="0.01"
                            onBlur={() => recalculateEntry()}
                            data-testid="input-entry-base"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={entryForm.control}
                    name="feeRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Rate (%)</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            step="0.01"
                            onBlur={() => recalculateEntry()}
                            data-testid="input-entry-rate"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={entryForm.control}
                  name="feeAmount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Fee Amount</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} type="number" step="0.01" readOnly data-testid="input-entry-amount" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={entryForm.control}
                  name="pennylaneInvoiceRef"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Penny Lane Invoice Ref</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) => field.onChange(e.target.value || null)}
                          data-testid="input-entry-pennylane"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={entryForm.control}
                  name="dateInvoiced"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Invoice Date</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) => field.onChange(e.target.value || null)}
                          data-testid="input-entry-date"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={entryForm.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Status</TechnicalLabel>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-entry-status">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="pending">Pending</SelectItem>
                          <SelectItem value="invoiced">Invoiced</SelectItem>
                          <SelectItem value="paid">Paid</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={createEntryMutation.isPending || updateEntryMutation.isPending}
                  data-testid="button-submit-entry"
                >
                  <span className="text-[9px] font-bold uppercase tracking-widest">
                    {(createEntryMutation.isPending || updateEntryMutation.isPending)
                      ? "Saving..."
                      : editingEntryId
                      ? "Update"
                      : "Create Entry"}
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

type DesignContractSummary = {
  contractId: number;
  totalTtc: number;
  totalHt: number | null;
  tvaRate: number | null;
  invoicedTtc: number;
  invoicedHt: number | null;
  remainingTtc: number;
  remainingHt: number | null;
  coveredFeeIds: number[];
  milestones: DesignContractMilestoneRow[];
};
