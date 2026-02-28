import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { FileCheck, Plus, Eye, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { insertCertificatSchema } from "@shared/schema";
import type { Project, Contractor, Certificat, Invoice } from "@shared/schema";
import { z } from "zod";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

const certificatFormSchema = insertCertificatSchema.extend({
  totalWorksHt: z.string().min(1, "Works HT amount is required"),
  netToPayHt: z.string().min(1, "Net to pay HT is required"),
  tvaAmount: z.string().min(1, "TVA amount is required"),
  netToPayTtc: z.string().min(1, "Net to pay TTC is required"),
});

type CertificatFormValues = z.infer<typeof certificatFormSchema>;

function CertificatDetailDialog({ cert, contractor, onClose }: { cert: Certificat; contractor?: Contractor; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
            Certificat {cert.certificateRef}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <StatusBadge status={cert.status} />
            {cert.dateIssued && (
              <span className="text-[11px] text-muted-foreground" data-testid="text-cert-detail-date">
                {cert.dateIssued}
              </span>
            )}
          </div>

          {contractor && (
            <div>
              <TechnicalLabel>Contractor</TechnicalLabel>
              <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-cert-detail-contractor">
                {contractor.name}
              </p>
            </div>
          )}

          <div className="space-y-3 p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
            <div className="flex items-center justify-between gap-2">
              <TechnicalLabel>Total Works HT</TechnicalLabel>
              <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-works">
                {formatCurrency(parseFloat(cert.totalWorksHt))}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <TechnicalLabel>PV/MV Adjustment</TechnicalLabel>
              <span className={`text-[13px] font-semibold ${parseFloat(cert.pvMvAdjustment ?? "0") >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} data-testid="text-cert-detail-pvmv">
                {formatCurrency(parseFloat(cert.pvMvAdjustment ?? "0"))}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <TechnicalLabel>Previous Payments</TechnicalLabel>
              <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-previous">
                {formatCurrency(parseFloat(cert.previousPayments ?? "0"))}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <TechnicalLabel>Retenue de Garantie</TechnicalLabel>
              <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-retenue">
                {formatCurrency(parseFloat(cert.retenueGarantie ?? "0"))}
              </span>
            </div>
            <div className="border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-3">
              <div className="flex items-center justify-between gap-2">
                <TechnicalLabel>Net to Pay HT</TechnicalLabel>
                <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-net-ht">
                  {formatCurrency(parseFloat(cert.netToPayHt))}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 mt-1">
                <TechnicalLabel>TVA</TechnicalLabel>
                <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-tva">
                  {formatCurrency(parseFloat(cert.tvaAmount))}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                <span className="text-[11px] font-black uppercase tracking-widest text-foreground">Net to Pay TTC</span>
                <span className="text-[16px] font-bold text-foreground" data-testid="text-cert-detail-net-ttc">
                  {formatCurrency(parseFloat(cert.netToPayTtc))}
                </span>
              </div>
            </div>
          </div>

          {cert.notes && (
            <div>
              <TechnicalLabel>Notes</TechnicalLabel>
              <p className="text-[12px] text-muted-foreground mt-1" data-testid="text-cert-detail-notes">{cert.notes}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Certificats() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [viewingCert, setViewingCert] = useState<Certificat | null>(null);
  const { toast } = useToast();

  const { data: projects, isLoading: loadingProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const { data: contractors } = useQuery<Contractor[]>({
    queryKey: ["/api/contractors"],
  });

  const { data: allCertificats, isLoading: loadingCerts } = useQuery<Certificat[]>({
    queryKey: ["/api/projects", selectedProjectId, "certificats"],
    enabled: !!selectedProjectId,
  });

  const { data: projectInvoices } = useQuery<Invoice[]>({
    queryKey: ["/api/projects", selectedProjectId, "invoices"],
    enabled: !!selectedProjectId,
  });

  const { data: nextRefData } = useQuery<{ nextRef: string }>({
    queryKey: ["/api/projects", selectedProjectId, "certificats", "next-ref"],
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
      netToPayHt: "0.00",
      tvaAmount: "0.00",
      netToPayTtc: "0.00",
      status: "draft",
      notes: null,
    },
  });

  const watchTotalWorks = form.watch("totalWorksHt");
  const watchPvMv = form.watch("pvMvAdjustment");
  const watchPrevious = form.watch("previousPayments");
  const watchRetenue = form.watch("retenueGarantie");

  const recalculate = () => {
    const totalWorks = parseFloat(watchTotalWorks || "0");
    const pvMv = parseFloat(watchPvMv || "0");
    const previous = parseFloat(watchPrevious || "0");
    const retenue = parseFloat(watchRetenue || "0");
    const netHt = totalWorks + pvMv - previous - retenue;
    const tva = netHt * 0.2;
    const netTtc = netHt + tva;
    form.setValue("netToPayHt", netHt.toFixed(2));
    form.setValue("tvaAmount", tva.toFixed(2));
    form.setValue("netToPayTtc", netTtc.toFixed(2));
  };

  const createMutation = useMutation({
    mutationFn: async (data: CertificatFormValues) => {
      const res = await apiRequest("POST", `/api/projects/${data.projectId}/certificats`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "certificats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "certificats", "next-ref"] });
      setDialogOpen(false);
      form.reset();
      toast({ title: "Certificat created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/certificats/${id}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "certificats"] });
      toast({ title: "Status updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      netToPayHt: totalInvoicesHt.toFixed(2),
      tvaAmount: (totalInvoicesHt * 0.2).toFixed(2),
      netToPayTtc: (totalInvoicesHt * 1.2).toFixed(2),
      status: "draft",
      notes: null,
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
              return (
                <LuxuryCard key={cert.id} data-testid={`card-certificat-${cert.id}`}>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-4 flex-wrap">
                      <div>
                        <TechnicalLabel data-testid={`text-cert-ref-${cert.id}`}>{cert.certificateRef}</TechnicalLabel>
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
                      <StatusBadge status={cert.status} />
                      {nextStatus && nextLabel && (
                        <Button
                          variant="outline"
                          onClick={() => updateStatusMutation.mutate({ id: cert.id, status: nextStatus })}
                          disabled={updateStatusMutation.isPending}
                          data-testid={`button-advance-cert-${cert.id}`}
                        >
                          <ChevronRight size={12} />
                          <span className="text-[8px] font-bold uppercase tracking-widest">{nextLabel}</span>
                        </Button>
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
                          {(contractors ?? []).map((c) => (
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
                          <TechnicalLabel>Total Works HT</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            step="0.01"
                            onBlur={() => recalculate()}
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
                            onBlur={() => recalculate()}
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
                          <TechnicalLabel>Previous Payments</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? "0.00"}
                            type="number"
                            step="0.01"
                            onBlur={() => recalculate()}
                            data-testid="input-cert-previous"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="retenueGarantie"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Retenue de Garantie</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? "0.00"}
                            type="number"
                            step="0.01"
                            onBlur={() => recalculate()}
                            data-testid="input-cert-retenue"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] space-y-2">
                  <TechnicalLabel>Calculated Summary</TechnicalLabel>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">Net to Pay HT</span>
                    <span className="text-[13px] font-semibold text-foreground" data-testid="text-calc-net-ht">
                      {formatCurrency(parseFloat(form.watch("netToPayHt") || "0"))}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">TVA</span>
                    <span className="text-[13px] font-semibold text-foreground" data-testid="text-calc-tva">
                      {formatCurrency(parseFloat(form.watch("tvaAmount") || "0"))}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                    <span className="text-[11px] font-black uppercase tracking-widest text-foreground">Net to Pay TTC</span>
                    <span className="text-[16px] font-bold text-foreground" data-testid="text-calc-net-ttc">
                      {formatCurrency(parseFloat(form.watch("netToPayTtc") || "0"))}
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
