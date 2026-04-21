import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Building2, Plus, Mail, Phone, Pencil, Shield, MapPin, RefreshCw, Link2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { insertContractorSchema } from "@shared/schema";
import type { Contractor } from "@shared/schema";
import { z } from "zod";

const contractorFormSchema = insertContractorSchema.extend({
  name: z.string().min(1, "Name is required"),
});

type ContractorFormValues = z.infer<typeof contractorFormSchema>;

export default function Contractors() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(null);
  const { toast } = useToast();

  const { data: contractors, isLoading } = useQuery<Contractor[]>({
    queryKey: ["/api/contractors"],
  });

  const { data: syncStatus } = useQuery<{ lastSyncedAt: string | null; status: string | null; errorMessage: string | null }>({
    queryKey: ["/api/contractors/sync-status"],
    refetchInterval: 60_000,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/contractors/sync", {});
      return res.json();
    },
    onSuccess: (data: { created?: number; updated?: number; skipped?: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/contractors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contractors/sync-status"] });
      toast({
        title: "Sync complete",
        description: `${data.created ?? 0} created, ${data.updated ?? 0} updated${data.skipped ? `, ${data.skipped} skipped` : ""}.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Sync failed", description: error.message, variant: "destructive" });
    },
  });

  const formatRelative = (iso: string | null | undefined): string => {
    if (!iso) return "never";
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.round(diffH / 24);
    return `${diffD}d ago`;
  };

  const form = useForm<ContractorFormValues>({
    resolver: zodResolver(contractorFormSchema),
    defaultValues: {
      name: "",
      siret: null,
      address: null,
      email: null,
      phone: null,
      defaultTvaRate: "20.00",
      notes: null,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: ContractorFormValues) => {
      const res = await apiRequest("POST", "/api/contractors", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contractors"] });
      setDialogOpen(false);
      form.reset();
      toast({ title: "Contractor created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<ContractorFormValues> }) => {
      const res = await apiRequest("PATCH", `/api/contractors/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contractors"] });
      setDialogOpen(false);
      setEditingContractor(null);
      form.reset();
      toast({ title: "Contractor updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const openCreate = () => {
    setEditingContractor(null);
    form.reset({
      name: "",
      siret: null,
      address: null,
      email: null,
      phone: null,
      defaultTvaRate: "20.00",
      notes: null,
    });
    setDialogOpen(true);
  };

  const openEdit = (contractor: Contractor, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingContractor(contractor);
    form.reset({
      name: contractor.name,
      siret: contractor.siret,
      address: contractor.address,
      email: contractor.email,
      phone: contractor.phone,
      defaultTvaRate: contractor.defaultTvaRate ?? "20.00",
      notes: contractor.notes,
    });
    setDialogOpen(true);
  };

  const onSubmit = (data: ContractorFormValues) => {
    if (editingContractor) {
      const payload = editingContractor.archidocId
        ? { notes: data.notes ?? null, defaultTvaRate: data.defaultTvaRate ?? null }
        : data;
      updateMutation.mutate({ id: editingContractor.id, data: payload });
    } else {
      createMutation.mutate(data);
    }
  };

  const isArchidocLinked = !!editingContractor?.archidocId;

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
              Contractors
            </h1>
            <p className="text-[10px] text-muted-foreground mt-1" data-testid="text-last-synced">
              ArchiDoc auto-sync: last run {formatRelative(syncStatus?.lastSyncedAt)}
              {syncStatus?.status === "failed" && (
                <span className="text-destructive ml-1">(failed)</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              data-testid="button-sync-contractors"
            >
              <RefreshCw size={14} className={syncMutation.isPending ? "animate-spin" : ""} />
              <span className="text-[9px] font-bold uppercase tracking-widest">
                {syncMutation.isPending ? "Syncing..." : "Sync Now"}
              </span>
            </Button>
            <Button onClick={openCreate} data-testid="button-new-contractor">
              <Plus size={14} />
              <span className="text-[9px] font-bold uppercase tracking-widest">New Contractor</span>
            </Button>
          </div>
        </div>

        <SectionHeader
          icon={Building2}
          title="All Contractors"
          subtitle="Contractor directory"
        />

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                {editingContractor ? "Edit Contractor" : "New Contractor"}
              </DialogTitle>
            </DialogHeader>
            {isArchidocLinked && (
              <div
                className="rounded-md border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/20 p-3 text-[10px] text-blue-800 dark:text-blue-200"
                data-testid="text-archidoc-readonly-note"
              >
                This contractor is managed in ArchiDoc. Synced fields are read-only here — only Notes and Default TVA Rate can be edited locally.
              </div>
            )}
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Name</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} disabled={isArchidocLinked} data-testid="input-contractor-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="siret"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>SIRET</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} disabled={isArchidocLinked} data-testid="input-contractor-siret" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Email</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} type="email" disabled={isArchidocLinked} data-testid="input-contractor-email" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Phone</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} disabled={isArchidocLinked} data-testid="input-contractor-phone" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Address</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} disabled={isArchidocLinked} data-testid="input-contractor-address" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="defaultTvaRate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Default TVA Rate (%)</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} type="number" step="0.01" data-testid="input-contractor-tva" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
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
                        <Textarea {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} className="resize-none" data-testid="input-contractor-notes" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full" disabled={isPending} data-testid="button-submit-contractor">
                  <span className="text-[9px] font-bold uppercase tracking-widest">
                    {isPending ? "Saving..." : editingContractor ? "Update" : "Create Contractor"}
                  </span>
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <LuxuryCard key={i}>
                <Skeleton className="h-4 w-32 mb-2" />
                <Skeleton className="h-3 w-24 mb-4" />
                <Skeleton className="h-3 w-40" />
              </LuxuryCard>
            ))}
          </div>
        ) : contractors && contractors.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {contractors.map((contractor) => (
              <Link key={contractor.id} href={`/entreprises/${contractor.id}`}>
                <LuxuryCard
                  className="cursor-pointer hover-elevate transition-all"
                  data-testid={`card-contractor-${contractor.id}`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="min-w-0">
                      <h3 className="text-[14px] font-bold text-foreground" data-testid={`text-contractor-name-${contractor.id}`}>
                        {contractor.name}
                      </h3>
                      <div className="flex items-center gap-1 mt-1 flex-wrap">
                        {contractor.archidocId && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-widest bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                            data-testid={`badge-archidoc-${contractor.id}`}
                          >
                            <Link2 size={8} />
                            ArchiDoc
                          </span>
                        )}
                        {contractor.archidocOrphanedAt && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-widest bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                            data-testid={`badge-orphaned-${contractor.id}`}
                            title="No longer present in ArchiDoc"
                          >
                            <AlertTriangle size={8} />
                            Orphaned
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => openEdit(contractor, e)}
                      data-testid={`button-edit-contractor-${contractor.id}`}
                    >
                      <Pencil size={12} />
                    </Button>
                  </div>
                  {contractor.siret && (
                    <TechnicalLabel data-testid={`text-contractor-siret-${contractor.id}`}>
                      SIRET: {contractor.siret}
                    </TechnicalLabel>
                  )}
                  <div className="mt-3 space-y-1">
                    {contractor.email && (
                      <div className="flex items-center gap-2">
                        <Mail size={12} className="text-muted-foreground" />
                        <span className="text-[11px] text-muted-foreground">{contractor.email}</span>
                      </div>
                    )}
                    {contractor.phone && (
                      <div className="flex items-center gap-2">
                        <Phone size={12} className="text-muted-foreground" />
                        <span className="text-[11px] text-muted-foreground">{contractor.phone}</span>
                      </div>
                    )}
                    {(contractor as any).town && (
                      <div className="flex items-center gap-2">
                        <MapPin size={12} className="text-muted-foreground" />
                        <span className="text-[11px] text-muted-foreground">
                          {(contractor as any).town}{(contractor as any).postcode ? ` (${(contractor as any).postcode})` : ""}
                        </span>
                      </div>
                    )}
                  </div>
                  {(contractor as any).insuranceStatus && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <Shield size={10} className={(contractor as any).insuranceStatus === "valid" ? "text-emerald-500" : "text-amber-500"} />
                      <span className={`text-[9px] font-bold uppercase tracking-widest ${(contractor as any).insuranceStatus === "valid" ? "text-emerald-600" : "text-amber-600"}`}>
                        {(contractor as any).insuranceStatus}
                      </span>
                    </div>
                  )}
                </LuxuryCard>
              </Link>
            ))}
          </div>
        ) : (
          <LuxuryCard data-testid="card-empty-contractors">
            <p className="text-[12px] text-muted-foreground text-center py-8">
              No contractors registered. Add your first contractor.
            </p>
          </LuxuryCard>
        )}
      </div>
    </AppLayout>
  );
}
