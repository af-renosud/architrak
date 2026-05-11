import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Badge } from "@/components/ui/badge";
import { Coins, Plus, Pencil } from "lucide-react";
import { OutstandingFeesPanel } from "@/components/fees/OutstandingFeesPanel";
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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

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

type PhaseByData = {
  phases: Array<{ phase: string; fees: Fee[]; totalHt: number; totalInvoiced: number; totalRemaining: number }>;
  grandTotals: { totalHt: number; totalInvoiced: number; totalRemaining: number };
};

const feeFormSchema = insertFeeSchema.extend({
  phase: z.enum(["conception", "chantier", "aor"], { required_error: "Phase is required" }),
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

export default function Fees() {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [feeDialogOpen, setFeeDialogOpen] = useState(false);
  const [entryDialogOpen, setEntryDialogOpen] = useState(false);
  const [selectedFeeId, setSelectedFeeId] = useState<number | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [phaseFilter, setPhaseFilter] = useState<string>("all");
  const { toast } = useToast();

  const { data: projects, isLoading: loadingProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const { data: feesList, isLoading: loadingFees } = useQuery<Fee[]>({
    queryKey: ["/api/projects", selectedProjectId, "fees"],
    enabled: !!selectedProjectId,
  });

  const { data: feeEntries } = useQuery<FeeEntry[]>({
    queryKey: ["/api/projects", selectedProjectId, "fee-entries"],
    enabled: !!selectedProjectId,
  });

  const { data: phaseData } = useQuery<PhaseByData>({
    queryKey: ["/api/projects", selectedProjectId, "fees", "by-phase"],
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
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "fees"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "fees"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "fee-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "fees"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "fee-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "fees"] });
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

  const totalFeeEarned = (feesList ?? []).reduce((sum, f) => sum + parseFloat(f.feeAmountHt), 0);
  const totalInvoiced = (feesList ?? []).reduce((sum, f) => sum + parseFloat(f.invoicedAmount ?? "0"), 0);
  const totalRemaining = totalFeeEarned - totalInvoiced;

  const filteredFees = phaseFilter === "all"
    ? (feesList ?? [])
    : (feesList ?? []).filter(f => (f.phase ?? "unassigned") === phaseFilter);

  const isLoading = loadingProjects || loadingFees;

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
            Honoraires
          </h1>
          <Button onClick={openCreateFee} data-testid="button-new-fee">
            <Plus size={14} />
            <span className="text-[9px] font-bold uppercase tracking-widest">New Fee</span>
          </Button>
        </div>

        <SectionHeader
          icon={Coins}
          title="Honoraires Tracking"
          subtitle="Works percentage, conception & planning"
        />

        <OutstandingFeesPanel
          scope={selectedProjectId ? "project" : "global"}
          projectId={selectedProjectId ? parseInt(selectedProjectId) : undefined}
        />

        <div className="max-w-xs">
          <TechnicalLabel>Filter by project</TechnicalLabel>
          <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
            <SelectTrigger className="mt-1" data-testid="select-fee-project-filter">
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

        {selectedProjectId && !isLoading && (
          <div className="flex items-center gap-2 flex-wrap" data-testid="phase-filter-tabs">
            {[
              { value: "all", label: "All" },
              { value: "conception", label: "Conception" },
              { value: "chantier", label: "Chantier" },
              { value: "aor", label: "AOR" },
            ].map((tab) => (
              <Button
                key={tab.value}
                variant={phaseFilter === tab.value ? "default" : "outline"}
                onClick={() => setPhaseFilter(tab.value)}
                data-testid={`tab-phase-${tab.value}`}
                className={phaseFilter === tab.value ? "bg-[#0B2545] text-white" : ""}
              >
                <span className="text-[9px] font-bold uppercase tracking-widest">{tab.label}</span>
              </Button>
            ))}
          </div>
        )}

        {selectedProjectId && !isLoading && phaseData && phaseData.phases.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="phase-summary-cards">
            {phaseData.phases.filter(p => p.phase !== "unassigned").map((phaseGroup) => {
              const progress = phaseGroup.totalHt > 0 ? Math.min((phaseGroup.totalInvoiced / phaseGroup.totalHt) * 100, 100) : 0;
              const phaseLabel = PHASE_OPTIONS.find(o => o.value === phaseGroup.phase)?.label ?? phaseGroup.phase;
              return (
                <LuxuryCard key={phaseGroup.phase} data-testid={`card-phase-summary-${phaseGroup.phase}`}>
                  <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                    <TechnicalLabel>{phaseLabel}</TechnicalLabel>
                    <PhaseBadge phase={phaseGroup.phase} />
                  </div>
                  <p className="text-[16px] font-light text-foreground" data-testid={`text-phase-total-${phaseGroup.phase}`}>
                    {formatCurrency(phaseGroup.totalHt)}
                  </p>
                  <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 mt-2 mb-1">
                    <div
                      className="h-full rounded-full bg-[#c1a27b] transition-all"
                      style={{ width: `${progress}%` }}
                      data-testid={`progress-phase-${phaseGroup.phase}`}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[10px] text-muted-foreground">
                      Invoiced: {formatCurrency(phaseGroup.totalInvoiced)}
                    </span>
                    <span className="text-[10px] font-semibold text-foreground">
                      {progress.toFixed(0)}%
                    </span>
                  </div>
                </LuxuryCard>
              );
            })}
          </div>
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
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <LuxuryCard data-testid="card-total-fee-earned">
                <TechnicalLabel>Total Honoraires</TechnicalLabel>
                <p className="text-[20px] font-light text-foreground mt-2" data-testid="text-total-earned">
                  {formatCurrency(totalFeeEarned)}
                </p>
              </LuxuryCard>
              <LuxuryCard data-testid="card-total-invoiced">
                <TechnicalLabel>Total Invoiced (Penny Lane)</TechnicalLabel>
                <p className="text-[20px] font-light text-emerald-600 dark:text-emerald-400 mt-2" data-testid="text-total-invoiced">
                  {formatCurrency(totalInvoiced)}
                </p>
              </LuxuryCard>
              <LuxuryCard data-testid="card-total-remaining">
                <TechnicalLabel>Remaining to Invoice</TechnicalLabel>
                <p className="text-[20px] font-light text-amber-600 dark:text-amber-400 mt-2" data-testid="text-total-remaining">
                  {formatCurrency(totalRemaining)}
                </p>
              </LuxuryCard>
            </div>

            {filteredFees && filteredFees.length > 0 ? (
              <div className="space-y-4">
                {filteredFees.map((fee) => {
                  const entries = (feeEntries ?? []).filter((e) => e.feeId === fee.id);
                  const feeHt = parseFloat(fee.feeAmountHt);
                  const invoiced = parseFloat(fee.invoicedAmount ?? "0");
                  const remaining = feeHt - invoiced;
                  const progress = feeHt > 0 ? Math.min((invoiced / feeHt) * 100, 100) : 0;

                  return (
                    <LuxuryCard key={fee.id} data-testid={`card-fee-${fee.id}`}>
                      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">
                              <FeeTypeLabel type={fee.feeType} />
                            </h3>
                            <PhaseBadge phase={fee.phase} />
                            <StatusBadge status={fee.status} />
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
                      </div>

                      <div className="grid grid-cols-3 gap-4 mb-3">
                        <div>
                          <TechnicalLabel>Amount HT</TechnicalLabel>
                          <p className="text-[13px] font-semibold text-foreground mt-0.5" data-testid={`text-fee-amount-${fee.id}`}>
                            {formatCurrency(feeHt)}
                          </p>
                        </div>
                        <div>
                          <TechnicalLabel>Invoiced</TechnicalLabel>
                          <p className="text-[13px] font-semibold text-emerald-600 dark:text-emerald-400 mt-0.5" data-testid={`text-fee-invoiced-${fee.id}`}>
                            {formatCurrency(invoiced)}
                          </p>
                        </div>
                        <div>
                          <TechnicalLabel>Remaining</TechnicalLabel>
                          <p className="text-[13px] font-semibold text-amber-600 dark:text-amber-400 mt-0.5" data-testid={`text-fee-remaining-${fee.id}`}>
                            {formatCurrency(remaining)}
                          </p>
                        </div>
                      </div>

                      <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 mb-4">
                        <div
                          className="h-full rounded-full bg-emerald-500 transition-all"
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
                                      Base: {formatCurrency(parseFloat(entry.baseHt))}
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
                                    {formatCurrency(parseFloat(entry.feeAmount))}
                                  </span>
                                  <StatusBadge status={entry.status} />
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => openEditEntry(entry)}
                                    data-testid={`button-edit-entry-${entry.id}`}
                                  >
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
              <LuxuryCard data-testid="card-empty-fees">
                <p className="text-[12px] text-muted-foreground text-center py-8">
                  No Honoraires defined for this project.
                </p>
              </LuxuryCard>
            )}
          </>
        )}

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
