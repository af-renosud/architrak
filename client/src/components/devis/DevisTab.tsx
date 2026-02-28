import { useState, useCallback, useRef } from "react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, ChevronDown, ChevronRight, FileText, ArrowUpRight, ArrowDownRight, Receipt, Upload, FileUp, Loader2 } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertDevisLineItemSchema, insertAvenantSchema, insertInvoiceSchema } from "@shared/schema";
import type { Devis, Contractor, Lot, DevisLineItem, Avenant, Invoice } from "@shared/schema";
import { z } from "zod";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

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
  const [expandedDevis, setExpandedDevis] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: devisList, isLoading } = useQuery<Devis[]>({
    queryKey: ["/api/projects", projectId, "devis"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/devis/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      const ext = data.extraction;
      const matchInfo = ext.matchConfidence > 0
        ? ` • Matched: ${ext.contractorName} (${Math.round(ext.matchConfidence)}%)`
        : "";
      toast({
        title: "Devis created from PDF",
        description: `${ext.documentType || "document"} — ${formatCurrency(parseFloat(data.devis.amountHt))} HT${matchInfo}${ext.lineItemsCreated > 0 ? ` • ${ext.lineItemsCreated} line items` : ""}`,
      });
      setUploading(false);
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
      setUploading(false);
    },
  });

  const handleFileSelect = useCallback((file: File) => {
    if (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) {
      toast({ title: "Invalid file", description: "Please upload a PDF file", variant: "destructive" });
      return;
    }
    setUploading(true);
    uploadMutation.mutate(file);
  }, [uploadMutation, toast]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  if (isLoading) {
    return <LuxuryCard><Skeleton className="h-40 w-full" /></LuxuryCard>;
  }

  return (
    <div className="space-y-4">
      {uploading ? (
        <LuxuryCard>
          <div className="py-12 text-center">
            <Loader2 className="mx-auto mb-4 animate-spin text-[#0B2545]" size={40} />
            <p className="text-[13px] font-semibold text-foreground mb-1">
              Processing PDF...
            </p>
            <p className="text-[11px] text-muted-foreground">
              Converting pages, extracting contractor, amounts, and line items
            </p>
          </div>
        </LuxuryCard>
      ) : (
        <div
          className={`border-2 border-dashed rounded-2xl p-8 text-center transition-colors cursor-pointer ${dragOver ? "border-[#0B2545] bg-[#0B2545]/5" : "border-[rgba(0,0,0,0.12)] hover:border-[#0B2545]/40"}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          data-testid="dropzone-devis-pdf"
        >
          <FileUp className="mx-auto mb-3 text-muted-foreground" size={36} strokeWidth={1} />
          <p className="text-[12px] font-semibold text-foreground mb-0.5">
            Drop a quotation PDF here or click to browse
          </p>
          <p className="text-[10px] text-muted-foreground">
            AI will extract contractor, amounts, and line items automatically
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileSelect(file);
              if (e.target) e.target.value = "";
            }}
            data-testid="input-devis-pdf"
          />
        </div>
      )}

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
      ) : !uploading ? (
        <LuxuryCard data-testid="card-empty-devis">
          <p className="text-[12px] text-muted-foreground text-center py-6">
            No Devis for this project yet. Drop a quotation PDF above to get started.
          </p>
        </LuxuryCard>
      ) : null}
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
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Unit Price</th>
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Total HT</th>
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Progress %</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li) => (
                    <tr key={li.id} className="border-b border-[rgba(0,0,0,0.04)]">
                      <td className="py-1 px-2">{li.lineNumber}</td>
                      <td className="py-1 px-2">{li.description}</td>
                      <td className="py-1 px-2 text-right">{li.quantity}</td>
                      <td className="py-1 px-2 text-right">{li.unitPriceHt ? formatCurrency(parseFloat(li.unitPriceHt)) : "-"}</td>
                      <td className="py-1 px-2 text-right font-medium">{formatCurrency(parseFloat(li.totalHt))}</td>
                      <td className="py-1 px-2 text-right">
                        <Input
                          type="number"
                          className="h-6 w-16 text-[10px] text-right inline-block"
                          defaultValue={li.percentComplete ?? "0"}
                          min={0}
                          max={100}
                          step={5}
                          onBlur={(e) => updateLineItemMutation.mutate({ id: li.id, percentComplete: e.target.value })}
                          data-testid={`input-line-progress-${li.id}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground text-center py-4">No line items yet.</p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h4 className="text-[12px] font-black uppercase tracking-tight text-foreground">
          Avenants ({avenants?.length ?? 0})
        </h4>
        <Button variant="outline" size="sm" onClick={() => {
          avenantForm.reset({ devisId: devis.id, avenantNumber: "", type: "pv", descriptionFr: "", descriptionUk: null, amountHt: "0.00", amountTtc: "0.00", dateSigned: null, status: "draft", pvmvRef: null });
          setAvenantDialogOpen(true);
        }} data-testid={`button-add-avenant-${devis.id}`}>
          <Plus size={12} />
          <span className="text-[8px] font-bold uppercase tracking-widest">Avenant</span>
        </Button>
      </div>
      {avenants && avenants.length > 0 ? (
        <div className="space-y-2">
          {avenants.map((a) => (
            <div key={a.id} className="flex items-center justify-between p-2 rounded-xl border border-[rgba(0,0,0,0.06)] bg-white/30" data-testid={`row-avenant-${a.id}`}>
              <div className="flex items-center gap-2">
                {a.type === "pv" ? <ArrowUpRight size={12} className="text-emerald-600" /> : <ArrowDownRight size={12} className="text-rose-500" />}
                <span className="text-[11px]">{a.descriptionFr}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[12px] font-semibold ${a.type === "pv" ? "text-emerald-600" : "text-rose-500"}`}>
                  {a.type === "pv" ? "+" : "-"}{formatCurrency(parseFloat(a.amountHt))}
                </span>
                <StatusBadge status={a.status} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground text-center py-2">No avenants.</p>
      )}

      <div className="flex items-center justify-between">
        <h4 className="text-[12px] font-black uppercase tracking-tight text-foreground">
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
          <Receipt size={12} />
          <span className="text-[8px] font-bold uppercase tracking-widest">Invoice</span>
        </Button>
      </div>
      {invoices && invoices.length > 0 ? (
        <div className="space-y-2">
          {invoices.map((inv) => (
            <div key={inv.id} className="flex items-center justify-between p-2 rounded-xl border border-[rgba(0,0,0,0.06)] bg-white/30" data-testid={`row-invoice-${inv.id}`}>
              <div className="flex items-center gap-2">
                <FileText size={12} className="text-muted-foreground" />
                <span className="text-[11px]">Invoice #{inv.invoiceNumber}</span>
                {inv.certificateNumber && <TechnicalLabel>Cert: {inv.certificateNumber}</TechnicalLabel>}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-foreground">{formatCurrency(parseFloat(inv.amountHt))}</span>
                <StatusBadge status={inv.status} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground text-center py-2">No invoices.</p>
      )}

      <Dialog open={invoiceDialogOpen} onOpenChange={setInvoiceDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight">New Invoice</DialogTitle>
            <DialogDescription className="text-[11px]">Record a contractor invoice against this devis</DialogDescription>
          </DialogHeader>
          <Form {...invoiceForm}>
            <form onSubmit={invoiceForm.handleSubmit((d) => createInvoiceMutation.mutate(d))} className="space-y-4">
              <FormField control={invoiceForm.control} name="invoiceNumber" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Invoice N°</TechnicalLabel></FormLabel>
                  <FormControl><Input {...field} type="number" data-testid="input-invoice-number" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-3 gap-4">
                <FormField control={invoiceForm.control} name="amountHt" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>HT</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcInvoiceTtc()} data-testid="input-invoice-ht" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={invoiceForm.control} name="tvaAmount" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>TVA</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-invoice-tva" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={invoiceForm.control} name="amountTtc" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>TTC</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-invoice-ttc" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
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
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight">New Avenant</DialogTitle>
            <DialogDescription className="text-[11px]">Add a plus-value or moins-value variation</DialogDescription>
          </DialogHeader>
          <Form {...avenantForm}>
            <form onSubmit={avenantForm.handleSubmit((d) => createAvenantMutation.mutate(d))} className="space-y-4">
              <FormField control={avenantForm.control} name="type" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Type</TechnicalLabel></FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger data-testid="select-avenant-type"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="pv">Plus-value (PV)</SelectItem>
                      <SelectItem value="mv">Moins-value (MV)</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={avenantForm.control} name="descriptionFr" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Description</TechnicalLabel></FormLabel>
                  <FormControl><Textarea {...field} className="resize-none" data-testid="input-avenant-desc" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={avenantForm.control} name="amountHt" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Amount HT</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcAvenantTtc()} data-testid="input-avenant-ht" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={avenantForm.control} name="amountTtc" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Amount TTC</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-avenant-ttc" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <Button type="submit" className="w-full" disabled={createAvenantMutation.isPending} data-testid="button-submit-avenant">
                <span className="text-[9px] font-bold uppercase tracking-widest">
                  {createAvenantMutation.isPending ? "Creating..." : "Create Avenant"}
                </span>
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={lineItemDialogOpen} onOpenChange={setLineItemDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight">Add Line Item</DialogTitle>
            <DialogDescription className="text-[11px]">Add a line item to this devis for progress tracking</DialogDescription>
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
                    <FormLabel><TechnicalLabel>Qty</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.001" onBlur={() => recalcLineTotal()} data-testid="input-line-qty" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={lineItemForm.control} name="unitPriceHt" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Unit Price</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcLineTotal()} data-testid="input-line-price" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={lineItemForm.control} name="totalHt" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Total HT</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-line-total" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <Button type="submit" className="w-full" disabled={createLineItemMutation.isPending} data-testid="button-submit-line">
                <span className="text-[9px] font-bold uppercase tracking-widest">
                  {createLineItemMutation.isPending ? "Adding..." : "Add Line Item"}
                </span>
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
