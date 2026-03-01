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
import { Plus, ChevronDown, ChevronRight, FileText, ArrowUpRight, ArrowDownRight, Upload, Loader2, ExternalLink, Check, Ban, AlertTriangle, Eye, EyeOff } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertDevisLineItemSchema, insertAvenantSchema, insertLotSchema } from "@shared/schema";
import type { Devis, Contractor, Lot, DevisLineItem, Avenant, Invoice } from "@shared/schema";
import { z } from "zod";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

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
  const [showVoid, setShowVoid] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: devisList, isLoading } = useQuery<Devis[]>({
    queryKey: ["/api/projects", projectId, "devis"],
  });

  const voidCount = devisList?.filter(d => d.status === "void").length ?? 0;
  const filteredDevisList = showVoid ? devisList : devisList?.filter(d => d.status !== "void");

  const activeDevis = devisList?.filter(d => d.status !== "void") ?? [];
  const totalDevisCount = activeDevis.length;
  const totalAmountTtc = activeDevis.reduce((sum, d) => sum + parseFloat(d.amountTtc?.toString() ?? "0"), 0);
  const totalAmountHt = activeDevis.reduce((sum, d) => sum + parseFloat(d.amountHt?.toString() ?? "0"), 0);
  const pendingDevisCount = activeDevis.filter(d => d.signOffStage !== "signed").length;
  const signedDevisCount = activeDevis.filter(d => d.signOffStage === "signed").length;

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


  if (isLoading) {
    return <LuxuryCard><Skeleton className="h-40 w-full" /></LuxuryCard>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <LuxuryCard data-testid="card-devis-count">
          <TechnicalLabel>Total Devis</TechnicalLabel>
          <p className="text-[20px] font-light text-foreground mt-1" data-testid="text-devis-count">{totalDevisCount}</p>
        </LuxuryCard>
        <LuxuryCard data-testid="card-devis-total">
          <TechnicalLabel>Total Amount</TechnicalLabel>
          <p className="text-[16px] font-semibold text-foreground mt-1">{formatCurrency(totalAmountTtc)} <span className="text-[9px] text-muted-foreground">TTC</span></p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(totalAmountHt)} HT</p>
        </LuxuryCard>
        <LuxuryCard data-testid="card-devis-pending">
          <TechnicalLabel>Pending</TechnicalLabel>
          <p className="text-[20px] font-light text-amber-600 mt-1" data-testid="text-devis-pending">{pendingDevisCount}</p>
        </LuxuryCard>
        <LuxuryCard data-testid="card-devis-signed">
          <TechnicalLabel>Signed</TechnicalLabel>
          <p className="text-[20px] font-light text-emerald-600 mt-1" data-testid="text-devis-signed">{signedDevisCount}</p>
        </LuxuryCard>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {uploading ? (
            <Button variant="outline" size="sm" className="h-7 text-[10px] px-3 gap-1.5" disabled data-testid="button-upload-devis">
              <Loader2 size={12} className="animate-spin" />
              Processing...
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px] px-3 gap-1.5"
              onClick={() => fileInputRef.current?.click()}
              data-testid="button-upload-devis"
            >
              <Upload size={12} />
              Upload Devis
            </Button>
          )}
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
        {voidCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-3 gap-1.5"
            onClick={() => setShowVoid(!showVoid)}
            data-testid="button-toggle-void"
          >
            {showVoid ? <EyeOff size={12} /> : <Eye size={12} />}
            {showVoid ? "Hide" : "Show"} Void [{voidCount}]
          </Button>
        )}
      </div>

      {filteredDevisList && filteredDevisList.length > 0 ? (
        <div className="space-y-3">
          {filteredDevisList.map((d) => (
            <div key={d.id}>
              <LuxuryCard data-testid={`card-devis-${d.id}`}>
                <div
                  className={`flex items-center justify-between gap-3 flex-wrap cursor-pointer ${d.status === "void" ? "opacity-50" : ""}`}
                  onClick={() => setExpandedDevis(expandedDevis === d.id ? null : d.id)}
                  data-testid={`row-devis-toggle-${d.id}`}
                >
                  <div className="flex items-center gap-3 flex-wrap min-w-0 flex-1">
                    {expandedDevis === d.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[16px] font-black text-[#0B2545] tracking-tight" data-testid={`text-devis-code-${d.id}`}>{d.devisCode}</span>
                        {d.devisNumber && <span className="text-[11px] text-muted-foreground">N° {d.devisNumber}</span>}
                      </div>
                      <p className="text-[12px] text-foreground mt-0.5 truncate">{d.descriptionFr}</p>
                      <span className="text-[10px] text-muted-foreground">
                        {contractors.find((c) => c.id === d.contractorId)?.name ?? `#${d.contractorId}`}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    {d.pdfStorageKey && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-3 gap-1.5 border-[#0B2545]/20 text-[#0B2545] hover:bg-[#0B2545]/5"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(`/api/devis/${d.id}/pdf`, "_blank");
                        }}
                        data-testid={`button-view-pdf-${d.id}`}
                      >
                        <FileText size={12} />
                        <span className="text-[9px] font-bold uppercase tracking-widest">View PDF</span>
                      </Button>
                    )}
                    <div className="text-right">
                      <span className="text-[14px] font-semibold text-foreground" data-testid={`text-devis-ttc-${d.id}`}>
                        {formatCurrency(parseFloat(d.amountTtc))}
                      </span>
                      <p className="text-[9px] text-muted-foreground">TTC</p>
                      <span className="text-[10px] text-muted-foreground" data-testid={`text-devis-ht-${d.id}`}>
                        {formatCurrency(parseFloat(d.amountHt))} HT
                      </span>
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
                  lots={lots}
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

const CHECK_COLORS: Record<string, { bg: string; border: string; ring: string }> = {
  green: { bg: "bg-emerald-500", border: "border-l-emerald-500", ring: "ring-emerald-300" },
  amber: { bg: "bg-amber-400", border: "border-l-amber-400", ring: "ring-amber-200" },
  red: { bg: "bg-rose-500", border: "border-l-rose-500", ring: "ring-rose-300" },
  unchecked: { bg: "", border: "border-l-transparent", ring: "" },
};

function LineItemWithCheck({ li, onUpdate }: { li: DevisLineItem; onUpdate: (data: Record<string, string>) => void }) {
  const status = li.checkStatus || "unchecked";
  const notes = li.checkNotes || "";
  const colors = CHECK_COLORS[status] || CHECK_COLORS.unchecked;
  const [notesOpen, setNotesOpen] = useState(!!notes);

  const toggleStatus = (newStatus: string) => {
    onUpdate({ checkStatus: status === newStatus ? "unchecked" : newStatus });
  };

  return (
    <>
      <tr className={`border-l-[3px] ${colors.border}`}>
        <td className="py-1.5 px-2 text-[11px]">{li.lineNumber}</td>
        <td className="py-1.5 px-2 text-[11px]">{li.description}</td>
        <td className="py-1.5 px-2 text-[11px] text-right">{li.quantity}</td>
        <td className="py-1.5 px-2 text-[11px] text-right">{li.unitPriceHt ? formatCurrency(parseFloat(li.unitPriceHt)) : "-"}</td>
        <td className="py-1.5 px-2 text-[11px] text-right font-medium">{formatCurrency(parseFloat(li.totalHt))}</td>
        <td className="py-1.5 px-2">
          <div className="flex items-center justify-end gap-1">
            <Input
              type="number"
              className="h-6 w-16 text-[10px] text-right inline-block"
              defaultValue={li.percentComplete ?? "0"}
              min={0}
              max={100}
              step={5}
              onBlur={(e) => onUpdate({ percentComplete: e.target.value })}
              data-testid={`input-line-progress-${li.id}`}
            />
            <div className="flex items-center gap-0.5 ml-1">
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "green" ? "bg-emerald-500 border-emerald-600 ring-2 ring-emerald-300" : "border-emerald-400 hover:bg-emerald-50"}`}
                onClick={() => toggleStatus("green")}
                title="Approved"
                data-testid={`button-check-green-${li.id}`}
              >
                {status === "green" && <Check size={12} className="text-white" />}
              </button>
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "amber" ? "bg-amber-400 border-amber-500 ring-2 ring-amber-200" : "border-amber-400 hover:bg-amber-50"}`}
                onClick={() => toggleStatus("amber")}
                title="Questioned"
                data-testid={`button-check-amber-${li.id}`}
              >
                {status === "amber" && <span className="text-white text-[10px] font-bold">?</span>}
              </button>
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "red" ? "bg-rose-500 border-rose-600 ring-2 ring-rose-300" : "border-rose-400 hover:bg-rose-50"}`}
                onClick={() => toggleStatus("red")}
                title="Rejected"
                data-testid={`button-check-red-${li.id}`}
              >
                {status === "red" && <span className="text-white text-[10px] font-bold">✕</span>}
              </button>
            </div>
            <button
              className={`w-6 h-6 rounded-md border transition-all flex items-center justify-center ml-0.5 ${notesOpen ? "bg-[#c1a27b]/10 border-[#c1a27b] text-[#c1a27b]" : notes ? "border-[#c1a27b]/50 text-[#c1a27b]" : "border-gray-200 text-gray-400 hover:text-[#c1a27b] hover:border-[#c1a27b]/50"}`}
              onClick={() => setNotesOpen(!notesOpen)}
              title={notesOpen ? "Hide notes" : "Show notes"}
              data-testid={`button-toggle-notes-${li.id}`}
            >
              <FileText size={11} />
            </button>
          </div>
        </td>
      </tr>
      {notesOpen && (
        <tr className={`border-l-[3px] ${colors.border}`}>
          <td colSpan={6} className="px-2 pb-2 pt-0.5">
            <input
              type="text"
              className="w-full h-7 px-3 text-[11px] rounded-lg border-2 outline-none transition-colors bg-white"
              style={{ borderColor: "#c1a27b" }}
              placeholder="Notes"
              defaultValue={notes}
              onBlur={(e) => {
                if (e.target.value !== notes) {
                  onUpdate({ checkNotes: e.target.value });
                }
              }}
              data-testid={`input-line-notes-${li.id}`}
            />
          </td>
        </tr>
      )}
      {!notesOpen && notes && (
        <tr className={`border-l-[3px] ${colors.border}`}>
          <td colSpan={6} className="px-2 pb-1 pt-0">
            <p className="text-[10px] text-[#c1a27b] italic truncate cursor-pointer" onClick={() => setNotesOpen(true)} data-testid={`text-note-preview-${li.id}`}>
              {notes}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

function DevisDetailInline({ devis, projectId, contractors, lots }: { devis: Devis; projectId: string; contractors: Contractor[]; lots: Lot[] }) {
  const { toast } = useToast();
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [avenantDialogOpen, setAvenantDialogOpen] = useState(false);
  const [lineItemDialogOpen, setLineItemDialogOpen] = useState(false);
  const [addingNewLot, setAddingNewLot] = useState(false);
  const [newLotNumber, setNewLotNumber] = useState("");
  const [newLotDescription, setNewLotDescription] = useState("");
  const [descriptionUkLocal, setDescriptionUkLocal] = useState(devis.descriptionUk || "");

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

  const tvaMultiplier = 1 + (parseFloat(devis.tvaRate) || 20) / 100;
  const originalHt = parseFloat(devis.amountHt);
  const originalTtc = parseFloat(devis.amountTtc);
  const approvedAvenants = (avenants ?? []).filter((a) => a.status === "approved");
  const pvTotal = approvedAvenants.filter((a) => a.type === "pv").reduce((s, a) => s + parseFloat(a.amountHt), 0);
  const mvTotal = approvedAvenants.filter((a) => a.type === "mv").reduce((s, a) => s + parseFloat(a.amountHt), 0);
  const adjustedHt = originalHt + pvTotal - mvTotal;
  const adjustedTtc = adjustedHt * tvaMultiplier;
  const invoicedHt = (invoices ?? []).reduce((s, i) => s + parseFloat(i.amountHt), 0);
  const invoicedTtc = (invoices ?? []).reduce((s, i) => s + parseFloat(i.amountTtc), 0);
  const remainingHt = adjustedHt - invoicedHt;
  const remainingTtc = adjustedTtc - invoicedTtc;
  const progress = adjustedHt > 0 ? Math.min((invoicedHt / adjustedHt) * 100, 100) : 0;

  const invoiceFileRef = useRef<HTMLInputElement>(null);

  const uploadInvoiceMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/devis/${devis.id}/invoices/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "invoices"] });
      setInvoiceDialogOpen(false);
      const ext = data.extraction;
      if (ext.confidence === "low") {
        toast({ title: "Invoice uploaded — review needed", description: `${data.fileName} — amounts could not be extracted automatically. Please check the invoice record.`, variant: "destructive" });
      } else {
        toast({ title: "Invoice uploaded successfully", description: `${data.fileName} — ${formatCurrency(ext.amountHt)} HT detected` });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
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
    mutationFn: async ({ id, ...data }: { id: number; [key: string]: any }) => {
      const res = await apiRequest("PATCH", `/api/line-items/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "line-items"] });
    },
  });

  const updateDevisMutation = useMutation({
    mutationFn: async (data: Record<string, string | null>) => {
      const res = await apiRequest("PATCH", `/api/devis/${devis.id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
    },
  });

  const createLotMutation = useMutation({
    mutationFn: async (data: { lotNumber: string; descriptionFr: string }) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/lots`, data);
      return res.json();
    },
    onSuccess: (newLot: Lot) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "lots"] });
      updateDevisMutation.mutate({ lotId: newLot.id } as any);
      setAddingNewLot(false);
      setNewLotNumber("");
      setNewLotDescription("");
      toast({ title: "Lot created and assigned" });
    },
    onError: (error: Error) => {
      toast({ title: "Error creating lot", description: error.message, variant: "destructive" });
    },
  });

  const [voidDialogOpen, setVoidDialogOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");

  const recalcAvenantTtc = () => {
    const ht = parseFloat(avenantForm.watch("amountHt") || "0");
    avenantForm.setValue("amountTtc", (ht * (1 + parseFloat(devis.tvaRate) / 100)).toFixed(2));
  };

  const recalcLineTotal = () => {
    const qty = parseFloat(lineItemForm.watch("quantity") || "0");
    const price = parseFloat(lineItemForm.watch("unitPriceHt") || "0");
    lineItemForm.setValue("totalHt", (qty * price).toFixed(2));
  };

  const isVoid = devis.status === "void";
  const missingLot = !devis.lotId;
  const missingDescriptionUk = !devis.descriptionUk || devis.descriptionUk.trim() === "";
  const signOffBlocked = missingLot || missingDescriptionUk;

  const SIGN_OFF_STAGES = [
    { key: "received", label: "Received" },
    { key: "checked_internal", label: "Checked Internally" },
    { key: "approved_for_signing", label: "Approved for Signing" },
    { key: "sent_to_client", label: "Sent to Client" },
    { key: "client_signed_off", label: "Client Signed Off" },
  ];
  const currentStageIndex = SIGN_OFF_STAGES.findIndex(s => s.key === devis.signOffStage);

  return (
    <div className={`ml-4 mt-1 mb-3 border-l-2 border-[rgba(0,0,0,0.08)] pl-4 space-y-4 ${isVoid ? "opacity-50" : ""}`} data-testid={`detail-devis-${devis.id}`}>
      {isVoid && (
        <div className="flex items-center gap-3 p-3 rounded-xl bg-red-50 border border-red-200">
          <Ban size={16} className="text-red-500 shrink-0" />
          <div>
            <p className="text-[12px] font-bold text-red-700">This quotation is void</p>
            {devis.voidReason && <p className="text-[10px] text-red-600 mt-0.5">{devis.voidReason}</p>}
            <p className="text-[9px] text-red-500 mt-0.5">Excluded from all financial calculations</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 text-[9px] font-bold uppercase tracking-widest border-red-300 text-red-600 hover:bg-red-100"
            onClick={() => {
              updateDevisMutation.mutate({ status: "pending", voidReason: null });
              toast({ title: "Quotation restored", description: "Devis is no longer void" });
            }}
            data-testid={`button-unvoid-${devis.id}`}
          >
            Restore
          </Button>
        </div>
      )}

      {!isVoid && (
        <div className="space-y-3" data-testid={`section-signoff-requirements-${devis.id}`}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <TechnicalLabel>Lot Assignment</TechnicalLabel>
              <p className="text-[9px] text-muted-foreground">Required for Certificat de Paiement</p>
              {!addingNewLot ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <Select
                    value={devis.lotId ? String(devis.lotId) : ""}
                    onValueChange={(val) => {
                      if (val === "__new__") {
                        setAddingNewLot(true);
                      } else {
                        updateDevisMutation.mutate({ lotId: parseInt(val) } as any);
                        toast({ title: "Lot assigned" });
                      }
                    }}
                  >
                    <SelectTrigger className="flex-1" data-testid={`select-lot-${devis.id}`}>
                      <SelectValue placeholder="Select a lot..." />
                    </SelectTrigger>
                    <SelectContent>
                      {lots.map((lot) => (
                        <SelectItem key={lot.id} value={String(lot.id)}>
                          {lot.lotNumber} — {lot.descriptionFr}
                        </SelectItem>
                      ))}
                      <SelectItem value="__new__">+ Add new lot</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-2 p-2 rounded-lg border border-[rgba(0,0,0,0.08)] bg-white/50">
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="Lot number (e.g. LOT3)"
                      value={newLotNumber}
                      onChange={(e) => setNewLotNumber(e.target.value)}
                      className="text-[11px]"
                      data-testid={`input-new-lot-number-${devis.id}`}
                    />
                    <Input
                      placeholder="Description"
                      value={newLotDescription}
                      onChange={(e) => setNewLotDescription(e.target.value)}
                      className="text-[11px]"
                      data-testid={`input-new-lot-desc-${devis.id}`}
                    />
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!newLotNumber.trim() || !newLotDescription.trim() || createLotMutation.isPending}
                      onClick={() => createLotMutation.mutate({ lotNumber: newLotNumber.trim(), descriptionFr: newLotDescription.trim() })}
                      data-testid={`button-save-new-lot-${devis.id}`}
                    >
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {createLotMutation.isPending ? "Saving..." : "Save Lot"}
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setAddingNewLot(false); setNewLotNumber(""); setNewLotDescription(""); }}
                      data-testid={`button-cancel-new-lot-${devis.id}`}
                    >
                      <span className="text-[9px] font-bold uppercase tracking-widest">Cancel</span>
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <TechnicalLabel>Works Description (English)</TechnicalLabel>
              <p className="text-[9px] text-muted-foreground">Required for Certificat de Paiement</p>
              <div className="relative">
                <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-md" style={{ backgroundColor: "#c1a27b" }} />
                <Input
                  className="pl-4 text-[11px]"
                  placeholder="Enter works description in English..."
                  value={descriptionUkLocal}
                  onChange={(e) => setDescriptionUkLocal(e.target.value)}
                  onBlur={(e) => {
                    const val = e.target.value.trim();
                    if (val !== (devis.descriptionUk || "")) {
                      updateDevisMutation.mutate({ descriptionUk: val || null });
                      toast({ title: "Works description updated" });
                    }
                  }}
                  data-testid={`input-description-uk-${devis.id}`}
                />
              </div>
            </div>
          </div>

          {signOffBlocked && (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200" data-testid={`warning-signoff-blocked-${devis.id}`}>
              <AlertTriangle size={14} className="text-amber-500 shrink-0" />
              <p className="text-[10px] text-amber-700 font-medium">
                Lot assignment and English works description are required before sign-off can proceed
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5 py-2" data-testid={`stepper-signoff-${devis.id}`}>
        {SIGN_OFF_STAGES.map((stage, idx) => {
          const isCompleted = idx <= currentStageIndex && !isVoid;
          const isCurrent = idx === currentStageIndex && !isVoid;
          return (
            <div key={stage.key} className="flex items-center gap-1.5 flex-1">
              <button
                className={`flex-1 px-2 py-1.5 rounded-lg border text-[9px] font-bold uppercase tracking-wide text-center transition-all
                  ${isVoid
                    ? "border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed"
                    : isCurrent
                      ? "border-[#0B2545] bg-[#0B2545] text-white shadow-sm"
                      : isCompleted
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700 cursor-pointer hover:bg-emerald-100"
                        : "border-slate-200 bg-white text-slate-400 cursor-pointer hover:border-slate-300 hover:text-slate-600"
                  }`}
                onClick={() => {
                  if (!isVoid) {
                    if (signOffBlocked && idx > 0) {
                      toast({ title: "Sign-off blocked", description: "Lot assignment and English works description are required before advancing", variant: "destructive" });
                      return;
                    }
                    updateDevisMutation.mutate({ signOffStage: stage.key });
                    toast({ title: `Stage: ${stage.label}` });
                  }
                }}
                disabled={isVoid || (signOffBlocked && idx > 0)}
                data-testid={`button-stage-${stage.key}-${devis.id}`}
              >
                {stage.label}
              </button>
              {idx < SIGN_OFF_STAGES.length - 1 && (
                <ChevronRight size={10} className={isCompleted && idx < currentStageIndex ? "text-emerald-400" : "text-slate-300"} />
              )}
            </div>
          );
        })}
        {!isVoid && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 gap-1 ml-2 border-red-200 text-red-500 hover:bg-red-50 hover:text-red-700 shrink-0"
            onClick={() => setVoidDialogOpen(true)}
            data-testid={`button-void-${devis.id}`}
          >
            <Ban size={10} />
            <span className="text-[8px] font-bold uppercase tracking-widest">Void</span>
          </Button>
        )}
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Original Contracted</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1">{formatCurrency(originalTtc)} <span className="text-[9px] text-muted-foreground">TTC</span></p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(originalHt)} HT</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Adjusted (+ PV/MV)</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1">{formatCurrency(adjustedTtc)} <span className="text-[9px] text-muted-foreground">TTC</span></p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(adjustedHt)} HT</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Invoiced</TechnicalLabel>
          <p className="text-[13px] font-semibold text-emerald-600 mt-1">{formatCurrency(invoicedTtc)} <span className="text-[9px] text-muted-foreground">TTC</span></p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(invoicedHt)} HT</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Reste à Réaliser</TechnicalLabel>
          <p className={`text-[13px] font-semibold mt-1 ${remainingHt < 0 ? "text-red-600" : "text-amber-600"}`}>
            {formatCurrency(remainingTtc)} <span className="text-[9px] text-muted-foreground">TTC</span>
          </p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(remainingHt)} HT</p>
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
                    <LineItemWithCheck
                      key={li.id}
                      li={li}
                      onUpdate={(data) => updateLineItemMutation.mutate({ id: li.id, ...data })}
                    />
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
        <Button variant="outline" size="sm" onClick={() => setInvoiceDialogOpen(true)} data-testid={`button-upload-invoice-${devis.id}`}>
          <Upload size={12} />
          <span className="text-[8px] font-bold uppercase tracking-widest">Upload Invoice</span>
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

      <Dialog open={invoiceDialogOpen} onOpenChange={(open) => { if (!uploadInvoiceMutation.isPending) setInvoiceDialogOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight">Upload Invoice PDF</DialogTitle>
            <DialogDescription className="text-[11px]">Upload the contractor's invoice document. The system will extract amounts and details automatically.</DialogDescription>
          </DialogHeader>
          {uploadInvoiceMutation.isPending ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-[#0B2545]" />
              <p className="text-[11px] text-muted-foreground text-center">Processing PDF... Extracting invoice details</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div
                className="border-2 border-dashed border-[#c1a27b]/40 rounded-2xl p-8 text-center cursor-pointer hover:border-[#c1a27b] hover:bg-[#c1a27b]/5 transition-all"
                onClick={() => invoiceFileRef.current?.click()}
                data-testid={`dropzone-invoice-upload-${devis.id}`}
              >
                <FileUp className="h-8 w-8 mx-auto mb-2 text-[#c1a27b]" />
                <p className="text-[12px] font-semibold text-foreground">Click to select invoice PDF</p>
                <p className="text-[10px] text-muted-foreground mt-1">PDF files only — the AI will extract invoice number, amounts, and date</p>
              </div>
              <input
                ref={invoiceFileRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadInvoiceMutation.mutate(file);
                  e.target.value = "";
                }}
                data-testid={`input-invoice-file-${devis.id}`}
              />
            </div>
          )}
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

      <Dialog open={voidDialogOpen} onOpenChange={setVoidDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight text-red-700">Mark Quotation as Void</DialogTitle>
            <DialogDescription className="text-[11px]">
              This quotation will be excluded from all financial calculations and tracking. You can restore it later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <TechnicalLabel>Reason for voiding</TechnicalLabel>
              <Textarea
                className="mt-1 resize-none text-[11px]"
                placeholder="e.g. Mistake, change of contractor, budget revision..."
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                data-testid="input-void-reason"
              />
            </div>
            <Button
              className="w-full bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                updateDevisMutation.mutate({ status: "void", voidReason: voidReason || null });
                toast({ title: "Quotation voided", description: "Excluded from all calculations" });
                setVoidDialogOpen(false);
                setVoidReason("");
              }}
              disabled={updateDevisMutation.isPending}
              data-testid="button-confirm-void"
            >
              <Ban size={14} />
              <span className="text-[9px] font-bold uppercase tracking-widest">
                {updateDevisMutation.isPending ? "Voiding..." : "Confirm Void"}
              </span>
            </Button>
          </div>
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
