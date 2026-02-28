import { useState } from "react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, ChevronDown, ChevronRight, FileText, ArrowUpRight, ArrowDownRight, Receipt } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertDevisSchema, insertDevisLineItemSchema, insertAvenantSchema, insertInvoiceSchema } from "@shared/schema";
import type { Devis, Contractor, Lot, DevisLineItem, Avenant, Invoice } from "@shared/schema";
import { z } from "zod";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

const devisFormSchema = insertDevisSchema.extend({
  devisCode: z.string().min(1, "Code is required"),
  descriptionFr: z.string().min(1, "Description is required"),
  amountHt: z.string().min(1, "HT amount is required"),
  amountTtc: z.string().min(1, "TTC amount is required"),
});

const invoiceFormSchema = insertInvoiceSchema.extend({
  amountHt: z.string().min(1, "Required"),
  amountTtc: z.string().min(1, "Required"),
  tvaAmount: z.string().min(1, "Required"),
});

const avenantFormSchema = insertAvenantSchema.extend({
  descriptionFr: z.string().min(1, "Description is required"),
  amountHt: z.string().min(1, "Required"),
  amountTtc: z.string().min(1, "Required"),
});

const lineItemFormSchema = insertDevisLineItemSchema.extend({
  description: z.string().min(1, "Required"),
  quantity: z.string().min(1, "Required"),
  unitPriceHt: z.string().min(1, "Required"),
  totalHt: z.string().min(1, "Required"),
});

interface DevisTabProps {
  projectId: string;
  contractors: Contractor[];
  lots: Lot[];
}

export function DevisTab({ projectId, contractors, lots }: DevisTabProps) {
  const { toast } = useToast();
  const [devisDialogOpen, setDevisDialogOpen] = useState(false);
  const [expandedDevis, setExpandedDevis] = useState<number | null>(null);

  const { data: devisList, isLoading } = useQuery<Devis[]>({
    queryKey: ["/api/projects", projectId, "devis"],
  });

  const devisForm = useForm<z.infer<typeof devisFormSchema>>({
    resolver: zodResolver(devisFormSchema),
    defaultValues: {
      projectId: parseInt(projectId),
      contractorId: 0,
      lotId: null,
      marcheId: null,
      devisCode: "",
      devisNumber: "",
      ref2: null,
      descriptionFr: "",
      descriptionUk: null,
      amountHt: "0.00",
      tvaRate: "20.00",
      amountTtc: "0.00",
      invoicingMode: "mode_a",
      status: "pending",
      dateSent: null,
      dateSigned: null,
    },
  });

  const createDevisMutation = useMutation({
    mutationFn: async (data: z.infer<typeof devisFormSchema>) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/devis`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      setDevisDialogOpen(false);
      devisForm.reset();
      toast({ title: "Devis created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const recalcDevisTtc = () => {
    const ht = parseFloat(devisForm.watch("amountHt") || "0");
    const tva = parseFloat(devisForm.watch("tvaRate") || "20");
    devisForm.setValue("amountTtc", (ht * (1 + tva / 100)).toFixed(2));
  };

  if (isLoading) {
    return <LuxuryCard><Skeleton className="h-40 w-full" /></LuxuryCard>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button onClick={() => setDevisDialogOpen(true)} data-testid="button-new-devis">
          <Plus size={14} />
          <span className="text-[9px] font-bold uppercase tracking-widest">New Devis</span>
        </Button>
      </div>

      {devisList && devisList.length > 0 ? (
        <div className="space-y-3">
          {devisList.map((d) => (
            <div key={d.id}>
              <LuxuryCard data-testid={`card-devis-${d.id}`}>
                <div
                  className="flex items-center justify-between gap-3 flex-wrap cursor-pointer"
                  onClick={() => setExpandedDevis(expandedDevis === d.id ? null : d.id)}
                  data-testid={`row-devis-toggle-${d.id}`}
                >
                  <div className="flex items-center gap-3 flex-wrap min-w-0 flex-1">
                    {expandedDevis === d.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <TechnicalLabel>{d.devisCode}</TechnicalLabel>
                        {d.devisNumber && <span className="text-[10px] text-muted-foreground">N° {d.devisNumber}</span>}
                      </div>
                      <p className="text-[12px] text-foreground mt-0.5 truncate">{d.descriptionFr}</p>
                      <span className="text-[10px] text-muted-foreground">
                        {contractors.find((c) => c.id === d.contractorId)?.name ?? `#${d.contractorId}`}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="text-right">
                      <span className="text-[14px] font-semibold text-foreground" data-testid={`text-devis-ht-${d.id}`}>
                        {formatCurrency(parseFloat(d.amountHt))}
                      </span>
                      <p className="text-[9px] text-muted-foreground">HT</p>
                    </div>
                    <TechnicalLabel>{d.invoicingMode === "mode_a" ? "Mode A" : "Mode B"}</TechnicalLabel>
                    <StatusBadge status={d.status} />
                  </div>
                </div>
              </LuxuryCard>

              {expandedDevis === d.id && (
                <DevisDetailInline
                  devis={d}
                  projectId={projectId}
                  contractors={contractors}
                />
              )}
            </div>
          ))}
        </div>
      ) : (
        <LuxuryCard data-testid="card-empty-devis">
          <p className="text-[12px] text-muted-foreground text-center py-8">
            No Devis for this project. Create one to get started.
          </p>
        </LuxuryCard>
      )}

      <Dialog open={devisDialogOpen} onOpenChange={setDevisDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight">New Devis</DialogTitle>
          </DialogHeader>
          <Form {...devisForm}>
            <form onSubmit={devisForm.handleSubmit((d) => createDevisMutation.mutate(d))} className="space-y-4">
              <FormField control={devisForm.control} name="contractorId" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Contractor</TechnicalLabel></FormLabel>
                  <Select onValueChange={(v) => field.onChange(parseInt(v))} value={field.value ? String(field.value) : ""}>
                    <FormControl><SelectTrigger data-testid="select-devis-contractor"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {contractors.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={devisForm.control} name="devisCode" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Devis Code</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} placeholder="e.g. 1231.1.GROS OEUVRE" data-testid="input-devis-code" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={devisForm.control} name="devisNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Devis N° (contractor ref)</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} placeholder="e.g. D-2024-001" data-testid="input-devis-number" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={devisForm.control} name="descriptionFr" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Description (FR)</TechnicalLabel></FormLabel>
                  <FormControl><Textarea {...field} className="resize-none" placeholder="Devis description" data-testid="input-devis-desc-fr" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={devisForm.control} name="descriptionUk" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Description (EN)</TechnicalLabel></FormLabel>
                  <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} placeholder="Optional English description" data-testid="input-devis-desc-uk" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              {lots.length > 0 && (
                <FormField control={devisForm.control} name="lotId" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Lot</TechnicalLabel></FormLabel>
                    <Select onValueChange={(v) => field.onChange(v === "none" ? null : parseInt(v))} value={field.value ? String(field.value) : "none"}>
                      <FormControl><SelectTrigger data-testid="select-devis-lot"><SelectValue placeholder="None" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {lots.map((l) => <SelectItem key={l.id} value={String(l.id)}>Lot {l.lotNumber} — {l.descriptionFr}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              )}
              <div className="grid grid-cols-3 gap-4">
                <FormField control={devisForm.control} name="amountHt" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Amount HT</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcDevisTtc()} data-testid="input-devis-ht" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={devisForm.control} name="tvaRate" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>TVA %</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcDevisTtc()} data-testid="input-devis-tva" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={devisForm.control} name="amountTtc" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Amount TTC</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-devis-ttc" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField control={devisForm.control} name="invoicingMode" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Invoicing Mode</TechnicalLabel></FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-testid="select-devis-mode"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="mode_a">Mode A — Simple invoicing</SelectItem>
                        <SelectItem value="mode_b">Mode B — Situation de Travaux</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={devisForm.control} name="status" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Status</TechnicalLabel></FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-testid="select-devis-status"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="live">Live</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="void">Void</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <Button type="submit" className="w-full" disabled={createDevisMutation.isPending} data-testid="button-submit-devis">
                <span className="text-[9px] font-bold uppercase tracking-widest">
                  {createDevisMutation.isPending ? "Creating..." : "Create Devis"}
                </span>
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DevisDetailInline({ devis, projectId, contractors }: { devis: Devis; projectId: string; contractors: Contractor[] }) {
  const { toast } = useToast();
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [avenantDialogOpen, setAvenantDialogOpen] = useState(false);
  const [lineItemDialogOpen, setLineItemDialogOpen] = useState(false);

  const { data: invoices } = useQuery<Invoice[]>({
    queryKey: ["/api/devis", devis.id, "invoices"],
  });
  const { data: avenants } = useQuery<Avenant[]>({
    queryKey: ["/api/devis", devis.id, "avenants"],
  });
  const { data: lineItems } = useQuery<DevisLineItem[]>({
    queryKey: ["/api/devis", devis.id, "line-items"],
    enabled: devis.invoicingMode === "mode_b",
  });

  const originalHt = parseFloat(devis.amountHt);
  const approvedAvenants = (avenants ?? []).filter((a) => a.status === "approved");
  const pvTotal = approvedAvenants.filter((a) => a.type === "pv").reduce((s, a) => s + parseFloat(a.amountHt), 0);
  const mvTotal = approvedAvenants.filter((a) => a.type === "mv").reduce((s, a) => s + parseFloat(a.amountHt), 0);
  const adjustedHt = originalHt + pvTotal - mvTotal;
  const invoicedHt = (invoices ?? []).reduce((s, i) => s + parseFloat(i.amountHt), 0);
  const remainingHt = adjustedHt - invoicedHt;
  const progress = adjustedHt > 0 ? Math.min((invoicedHt / adjustedHt) * 100, 100) : 0;

  const invoiceForm = useForm<z.infer<typeof invoiceFormSchema>>({
    resolver: zodResolver(invoiceFormSchema),
    defaultValues: {
      devisId: devis.id,
      contractorId: devis.contractorId,
      projectId: parseInt(projectId),
      certificateNumber: "",
      invoiceNumber: (invoices?.length ?? 0) + 1,
      amountHt: "0.00",
      tvaAmount: "0.00",
      amountTtc: "0.00",
      dateIssued: null,
      dateSent: null,
      datePaid: null,
      status: "pending",
      pdfPath: null,
      notes: null,
    },
  });

  const avenantForm = useForm<z.infer<typeof avenantFormSchema>>({
    resolver: zodResolver(avenantFormSchema),
    defaultValues: {
      devisId: devis.id,
      avenantNumber: "",
      type: "pv",
      descriptionFr: "",
      descriptionUk: null,
      amountHt: "0.00",
      amountTtc: "0.00",
      dateSigned: null,
      status: "draft",
      pvmvRef: null,
    },
  });

  const lineItemForm = useForm<z.infer<typeof lineItemFormSchema>>({
    resolver: zodResolver(lineItemFormSchema),
    defaultValues: {
      devisId: devis.id,
      lineNumber: (lineItems?.length ?? 0) + 1,
      description: "",
      quantity: "1",
      unit: "u",
      unitPriceHt: "0.00",
      totalHt: "0.00",
      percentComplete: "0",
    },
  });

  const createInvoiceMutation = useMutation({
    mutationFn: async (data: z.infer<typeof invoiceFormSchema>) => {
      const res = await apiRequest("POST", `/api/devis/${devis.id}/invoices`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "invoices"] });
      setInvoiceDialogOpen(false);
      invoiceForm.reset();
      toast({ title: "Invoice created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createAvenantMutation = useMutation({
    mutationFn: async (data: z.infer<typeof avenantFormSchema>) => {
      const res = await apiRequest("POST", `/api/devis/${devis.id}/avenants`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "avenants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      setAvenantDialogOpen(false);
      avenantForm.reset();
      toast({ title: "Avenant created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createLineItemMutation = useMutation({
    mutationFn: async (data: z.infer<typeof lineItemFormSchema>) => {
      const res = await apiRequest("POST", `/api/devis/${devis.id}/line-items`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "line-items"] });
      setLineItemDialogOpen(false);
      lineItemForm.reset();
      toast({ title: "Line item added" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateLineItemMutation = useMutation({
    mutationFn: async ({ id, percentComplete }: { id: number; percentComplete: string }) => {
      const res = await apiRequest("PATCH", `/api/line-items/${id}`, { percentComplete });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "line-items"] });
      toast({ title: "Progress updated" });
    },
  });

  const recalcInvoiceTtc = () => {
    const ht = parseFloat(invoiceForm.watch("amountHt") || "0");
    const tva = ht * parseFloat(devis.tvaRate) / 100;
    invoiceForm.setValue("tvaAmount", tva.toFixed(2));
    invoiceForm.setValue("amountTtc", (ht + tva).toFixed(2));
  };

  const recalcAvenantTtc = () => {
    const ht = parseFloat(avenantForm.watch("amountHt") || "0");
    avenantForm.setValue("amountTtc", (ht * (1 + parseFloat(devis.tvaRate) / 100)).toFixed(2));
  };

  const recalcLineTotal = () => {
    const qty = parseFloat(lineItemForm.watch("quantity") || "0");
    const price = parseFloat(lineItemForm.watch("unitPriceHt") || "0");
    lineItemForm.setValue("totalHt", (qty * price).toFixed(2));
  };

  return (
    <div className="ml-4 mt-1 mb-3 border-l-2 border-[rgba(0,0,0,0.08)] pl-4 space-y-4" data-testid={`detail-devis-${devis.id}`}>
      <div className="grid grid-cols-4 gap-3">
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Original Contracted</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1">{formatCurrency(originalHt)}</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Adjusted (+ PV/MV)</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1">{formatCurrency(adjustedHt)}</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Invoiced</TechnicalLabel>
          <p className="text-[13px] font-semibold text-emerald-600 mt-1">{formatCurrency(invoicedHt)}</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Reste à Réaliser</TechnicalLabel>
          <p className={`text-[13px] font-semibold mt-1 ${remainingHt < 0 ? "text-red-600" : "text-amber-600"}`}>
            {formatCurrency(remainingHt)}
          </p>
        </div>
      </div>
      <div className="h-1.5 w-full rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
      </div>

      {devis.invoicingMode === "mode_b" && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[12px] font-black uppercase tracking-tight text-foreground">
              Devis Line Items ({lineItems?.length ?? 0})
            </h4>
            <Button variant="outline" size="sm" onClick={() => {
              lineItemForm.reset({ devisId: devis.id, lineNumber: (lineItems?.length ?? 0) + 1, description: "", quantity: "1", unit: "u", unitPriceHt: "0.00", totalHt: "0.00", percentComplete: "0" });
              setLineItemDialogOpen(true);
            }} data-testid={`button-add-line-${devis.id}`}>
              <Plus size={12} />
              <span className="text-[8px] font-bold uppercase tracking-widest">Line Item</span>
            </Button>
          </div>
          {lineItems && lineItems.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-[rgba(0,0,0,0.08)]">
                    <th className="text-left py-1 px-2 font-black uppercase tracking-widest text-[8px]">#</th>
                    <th className="text-left py-1 px-2 font-black uppercase tracking-widest text-[8px]">Description</th>
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Qty</th>
                    <th className="text-left py-1 px-2 font-black uppercase tracking-widest text-[8px]">Unit</th>
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Unit Price HT</th>
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Total HT</th>
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">% Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((item) => (
                    <tr key={item.id} className="border-b border-[rgba(0,0,0,0.03)]" data-testid={`row-line-${item.id}`}>
                      <td className="py-1.5 px-2 text-muted-foreground">{item.lineNumber}</td>
                      <td className="py-1.5 px-2 text-foreground">{item.description}</td>
                      <td className="py-1.5 px-2 text-right">{item.quantity}</td>
                      <td className="py-1.5 px-2">{item.unit}</td>
                      <td className="py-1.5 px-2 text-right">{formatCurrency(parseFloat(item.unitPriceHt))}</td>
                      <td className="py-1.5 px-2 text-right font-semibold">{formatCurrency(parseFloat(item.totalHt))}</td>
                      <td className="py-1.5 px-2">
                        <div className="flex items-center gap-1 justify-end">
                          <Input
                            type="number"
                            min="0"
                            max="100"
                            step="5"
                            defaultValue={item.percentComplete ?? "0"}
                            className="w-14 h-6 text-[10px] text-right"
                            onBlur={(e) => {
                              const val = e.target.value;
                              if (val !== (item.percentComplete ?? "0")) {
                                updateLineItemMutation.mutate({ id: item.id, percentComplete: val });
                              }
                            }}
                            data-testid={`input-line-pct-${item.id}`}
                          />
                          <span className="text-[9px] text-muted-foreground">%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground py-2">No line items. Add items for Mode B tracking.</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[12px] font-black uppercase tracking-tight text-foreground">
              <Receipt size={12} className="inline mr-1" />
              Invoices ({invoices?.length ?? 0})
            </h4>
            <Button variant="outline" size="sm" onClick={() => {
              invoiceForm.reset({
                devisId: devis.id, contractorId: devis.contractorId, projectId: parseInt(projectId),
                certificateNumber: "", invoiceNumber: (invoices?.length ?? 0) + 1,
                amountHt: "0.00", tvaAmount: "0.00", amountTtc: "0.00",
                dateIssued: null, dateSent: null, datePaid: null, status: "pending", pdfPath: null, notes: null,
              });
              setInvoiceDialogOpen(true);
            }} data-testid={`button-add-invoice-${devis.id}`}>
              <Plus size={12} />
              <span className="text-[8px] font-bold uppercase tracking-widest">Invoice</span>
            </Button>
          </div>
          {invoices && invoices.length > 0 ? (
            <div className="space-y-1.5">
              {invoices.map((inv) => (
                <div key={inv.id} className="p-2 rounded-lg border border-[rgba(0,0,0,0.05)] flex items-center justify-between gap-2 flex-wrap" data-testid={`row-invoice-${inv.id}`}>
                  <div>
                    <span className="text-[11px] font-semibold text-foreground">F{inv.invoiceNumber}</span>
                    {inv.certificateNumber && <span className="text-[10px] text-muted-foreground ml-1">({inv.certificateNumber})</span>}
                    {inv.dateIssued && <p className="text-[9px] text-muted-foreground">{inv.dateIssued}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-foreground">{formatCurrency(parseFloat(inv.amountHt))} HT</span>
                    <StatusBadge status={inv.status} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground py-2">No invoices.</p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[12px] font-black uppercase tracking-tight text-foreground">
              <FileText size={12} className="inline mr-1" />
              Avenants ({avenants?.length ?? 0})
            </h4>
            <Button variant="outline" size="sm" onClick={() => {
              avenantForm.reset({
                devisId: devis.id, avenantNumber: "", type: "pv",
                descriptionFr: "", descriptionUk: null,
                amountHt: "0.00", amountTtc: "0.00",
                dateSigned: null, status: "draft", pvmvRef: null,
              });
              setAvenantDialogOpen(true);
            }} data-testid={`button-add-avenant-${devis.id}`}>
              <Plus size={12} />
              <span className="text-[8px] font-bold uppercase tracking-widest">Avenant</span>
            </Button>
          </div>
          {avenants && avenants.length > 0 ? (
            <div className="space-y-1.5">
              {avenants.map((av) => (
                <div key={av.id} className="p-2 rounded-lg border border-[rgba(0,0,0,0.05)] flex items-center justify-between gap-2 flex-wrap" data-testid={`row-avenant-${av.id}`}>
                  <div className="flex items-center gap-1.5">
                    {av.type === "pv" ? (
                      <ArrowUpRight size={12} className="text-emerald-600" />
                    ) : (
                      <ArrowDownRight size={12} className="text-red-600" />
                    )}
                    <div>
                      <span className="text-[11px] font-semibold text-foreground">{av.type.toUpperCase()}</span>
                      <p className="text-[10px] text-muted-foreground truncate max-w-[120px]">{av.descriptionFr}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] font-semibold ${av.type === "pv" ? "text-emerald-600" : "text-red-600"}`}>
                      {av.type === "pv" ? "+" : "-"}{formatCurrency(parseFloat(av.amountHt))}
                    </span>
                    <StatusBadge status={av.status} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground py-2">No Avenants.</p>
          )}
        </div>
      </div>

      <Dialog open={invoiceDialogOpen} onOpenChange={setInvoiceDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight">New Invoice — {devis.devisCode}</DialogTitle>
          </DialogHeader>
          <Form {...invoiceForm}>
            <form onSubmit={invoiceForm.handleSubmit((d) => createInvoiceMutation.mutate(d))} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={invoiceForm.control} name="invoiceNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Invoice N°</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" onChange={(e) => field.onChange(parseInt(e.target.value))} data-testid="input-inv-number" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={invoiceForm.control} name="certificateNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Certificat Ref</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} placeholder="e.g. C43" data-testid="input-inv-cert" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={invoiceForm.control} name="amountHt" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Amount HT</TechnicalLabel></FormLabel>
                  <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcInvoiceTtc()} data-testid="input-inv-ht" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={invoiceForm.control} name="tvaAmount" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>TVA</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-inv-tva" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={invoiceForm.control} name="amountTtc" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Amount TTC</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-inv-ttc" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={invoiceForm.control} name="dateIssued" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Issue Date</TechnicalLabel></FormLabel>
                  <FormControl><Input type="date" {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-inv-date" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={invoiceForm.control} name="status" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Status</TechnicalLabel></FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger data-testid="select-inv-status"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="sent">Sent</SelectItem>
                      <SelectItem value="paid">Paid</SelectItem>
                      <SelectItem value="overdue">Overdue</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={invoiceForm.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Notes</TechnicalLabel></FormLabel>
                  <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-inv-notes" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <Button type="submit" className="w-full" disabled={createInvoiceMutation.isPending} data-testid="button-submit-invoice">
                <span className="text-[9px] font-bold uppercase tracking-widest">
                  {createInvoiceMutation.isPending ? "Creating..." : "Create Invoice"}
                </span>
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={avenantDialogOpen} onOpenChange={setAvenantDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight">New Avenant — {devis.devisCode}</DialogTitle>
          </DialogHeader>
          <Form {...avenantForm}>
            <form onSubmit={avenantForm.handleSubmit((d) => createAvenantMutation.mutate(d))} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={avenantForm.control} name="type" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Type</TechnicalLabel></FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-testid="select-av-type"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="pv">PV (Plus-value)</SelectItem>
                        <SelectItem value="mv">MV (Moins-value)</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={avenantForm.control} name="avenantNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Avenant N°</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} placeholder="AV-01" data-testid="input-av-number" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={avenantForm.control} name="descriptionFr" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Description (FR)</TechnicalLabel></FormLabel>
                  <FormControl><Textarea {...field} className="resize-none" data-testid="input-av-desc-fr" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={avenantForm.control} name="amountHt" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Amount HT</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcAvenantTtc()} data-testid="input-av-ht" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={avenantForm.control} name="amountTtc" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Amount TTC</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-av-ttc" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={avenantForm.control} name="status" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Status</TechnicalLabel></FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger data-testid="select-av-status"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="approved">Approved</SelectItem>
                      <SelectItem value="rejected">Rejected</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <Button type="submit" className="w-full" disabled={createAvenantMutation.isPending} data-testid="button-submit-avenant">
                <span className="text-[9px] font-bold uppercase tracking-widest">
                  {createAvenantMutation.isPending ? "Creating..." : "Create Avenant"}
                </span>
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {devis.invoicingMode === "mode_b" && (
        <Dialog open={lineItemDialogOpen} onOpenChange={setLineItemDialogOpen}>
          <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-[16px] font-black uppercase tracking-tight">New Line Item</DialogTitle>
            </DialogHeader>
            <Form {...lineItemForm}>
              <form onSubmit={lineItemForm.handleSubmit((d) => createLineItemMutation.mutate(d))} className="space-y-4">
                <FormField control={lineItemForm.control} name="description" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Description</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} data-testid="input-line-desc" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <div className="grid grid-cols-3 gap-4">
                  <FormField control={lineItemForm.control} name="quantity" render={({ field }) => (
                    <FormItem>
                      <FormLabel><TechnicalLabel>Quantity</TechnicalLabel></FormLabel>
                      <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcLineTotal()} data-testid="input-line-qty" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={lineItemForm.control} name="unit" render={({ field }) => (
                    <FormItem>
                      <FormLabel><TechnicalLabel>Unit</TechnicalLabel></FormLabel>
                      <FormControl><Input {...field} placeholder="u, m², ml..." data-testid="input-line-unit" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={lineItemForm.control} name="unitPriceHt" render={({ field }) => (
                    <FormItem>
                      <FormLabel><TechnicalLabel>Unit Price HT</TechnicalLabel></FormLabel>
                      <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcLineTotal()} data-testid="input-line-pu" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
                <FormField control={lineItemForm.control} name="totalHt" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Total HT</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-line-total" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <Button type="submit" className="w-full" disabled={createLineItemMutation.isPending} data-testid="button-submit-line">
                  <span className="text-[9px] font-bold uppercase tracking-widest">
                    {createLineItemMutation.isPending ? "Adding..." : "Add Line Item"}
                  </span>
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
