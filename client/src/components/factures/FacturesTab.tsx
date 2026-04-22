import { useState, useRef } from "react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ChevronRight, FileText, Upload, FileUp, Loader2, Save, Calendar, Building2, Hash, Receipt, CheckCircle2, ShieldCheck, AlertTriangle, Trash2, Sparkles } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Invoice, Contractor, Devis } from "@shared/schema";
import { AdvisoriesList, AdvisoryBadge } from "@/components/advisories/AdvisoriesList";
import { TvaDerivedHint } from "@/components/ui/tva-derived-hint";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

interface FacturesTabProps {
  projectId: string;
  contractors: Contractor[];
  isArchived?: boolean;
}

export function FacturesTab({ projectId, contractors, isArchived = false }: FacturesTabProps) {
  const { toast } = useToast();
  const [expandedInvoice, setExpandedInvoice] = useState<number | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [selectedDevisId, setSelectedDevisId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: invoices, isLoading } = useQuery<Invoice[]>({
    queryKey: ["/api/projects", projectId, "invoices"],
  });

  const { data: devisList } = useQuery<Devis[]>({
    queryKey: ["/api/projects", projectId, "devis"],
  });

  const contractorMap = new Map(contractors.map(c => [c.id, c.name]));
  const devisMap = new Map((devisList ?? []).map(d => [d.id, d]));

  const uploadMutation = useMutation({
    mutationFn: async ({ file, devisId }: { file: File; devisId: number }) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/devis/${devisId}/invoices/upload`, {
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
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      setUploadDialogOpen(false);
      setSelectedDevisId(null);
      const ext = data.extraction;
      if (ext.confidence === "low") {
        toast({ title: "Invoice uploaded — review needed", description: `${data.fileName} — amounts could not be extracted automatically. Please check the invoice record.`, variant: "destructive" });
      } else {
        toast({ title: "Invoice uploaded successfully", description: `${data.fileName} — ${formatCurrency(ext.amountHt)} HT / ${formatCurrency(ext.amountTtc)} TTC detected` });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const totalHt = (invoices ?? []).reduce((s, i) => s + parseFloat(i.amountHt), 0);
  const totalTtc = (invoices ?? []).reduce((s, i) => s + parseFloat(i.amountTtc), 0);
  const draftCount = (invoices ?? []).filter(i => i.status === "draft").length;
  const pendingCount = (invoices ?? []).filter(i => i.status === "pending").length;
  const paidCount = (invoices ?? []).filter(i => i.status === "paid").length;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-16 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <LuxuryCard data-testid="card-factures-count">
          <TechnicalLabel>Total Factures</TechnicalLabel>
          <p className="text-[20px] font-light text-foreground mt-1" data-testid="text-factures-count">{invoices?.length ?? 0}</p>
        </LuxuryCard>
        <LuxuryCard data-testid="card-factures-total">
          <TechnicalLabel>Total Amount</TechnicalLabel>
          <p className="text-[16px] font-semibold text-foreground mt-1">{formatCurrency(totalTtc)} <span className="text-[9px] text-muted-foreground">TTC</span></p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(totalHt)} HT</p>
        </LuxuryCard>
        {draftCount > 0 && (
          <LuxuryCard data-testid="card-factures-draft">
            <TechnicalLabel>Draft (AI Review)</TechnicalLabel>
            <p className="text-[20px] font-light text-blue-600 mt-1" data-testid="text-factures-draft">{draftCount}</p>
          </LuxuryCard>
        )}
        <LuxuryCard data-testid="card-factures-pending">
          <TechnicalLabel>Pending</TechnicalLabel>
          <p className="text-[20px] font-light text-amber-600 mt-1">{pendingCount}</p>
        </LuxuryCard>
        <LuxuryCard data-testid="card-factures-paid">
          <TechnicalLabel>Paid</TechnicalLabel>
          <p className="text-[20px] font-light text-emerald-600 mt-1">{paidCount}</p>
        </LuxuryCard>
      </div>

      <div className="flex items-center justify-end">
        <Button onClick={() => setUploadDialogOpen(true)} disabled={isArchived} data-testid="button-upload-facture">
          <Upload size={14} />
          <span className="text-[9px] font-bold uppercase tracking-widest">Upload Invoice</span>
        </Button>
      </div>

      {invoices && invoices.length > 0 ? (
        <div className="space-y-3">
          {invoices.map((inv) => {
            const dv = devisMap.get(inv.devisId);
            return (
              <div key={inv.id}>
                <LuxuryCard data-testid={`card-facture-${inv.id}`}>
                  <div
                    className="flex items-center justify-between gap-3 flex-wrap cursor-pointer"
                    onClick={() => setExpandedInvoice(expandedInvoice === inv.id ? null : inv.id)}
                    data-testid={`row-facture-toggle-${inv.id}`}
                  >
                    <div className="flex items-center gap-3 flex-wrap min-w-0 flex-1">
                      {expandedInvoice === inv.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[16px] font-black text-[#0B2545] tracking-tight" data-testid={`text-facture-number-${inv.id}`}>
                            Facture #{inv.invoiceNumber}
                          </span>
                          {inv.certificateNumber && <TechnicalLabel>Cert: {inv.certificateNumber}</TechnicalLabel>}
                        </div>
                        <p className="text-[12px] text-foreground mt-0.5 truncate">
                          {contractorMap.get(inv.contractorId) ?? `Contractor #${inv.contractorId}`}
                        </p>
                        <span className="text-[10px] text-muted-foreground">
                          {dv ? dv.devisCode : `Devis #${inv.devisId}`}
                          {inv.dateIssued && ` · ${new Date(inv.dateIssued).toLocaleDateString("fr-FR")}`}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      {inv.pdfPath && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-3 gap-1.5 border-[#0B2545]/20 text-[#0B2545] hover:bg-[#0B2545]/5"
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(`/api/invoices/${inv.id}/pdf`, "_blank");
                          }}
                          data-testid={`button-view-pdf-facture-${inv.id}`}
                        >
                          <FileText size={12} />
                          <span className="text-[9px] font-bold uppercase tracking-widest">View PDF</span>
                        </Button>
                      )}
                      <div className="text-right">
                        <span className="text-[14px] font-semibold text-foreground" data-testid={`text-facture-ttc-${inv.id}`}>
                          {formatCurrency(parseFloat(inv.amountTtc))}
                        </span>
                        <p className="text-[9px] text-muted-foreground">TTC</p>
                        <span className="text-[10px] text-muted-foreground" data-testid={`text-facture-ht-${inv.id}`}>
                          {formatCurrency(parseFloat(inv.amountHt))} HT
                        </span>
                      </div>
                      <AdvisoryBadge subject={{ type: "invoice", id: inv.id }} />
                      <StatusBadge status={inv.status} />
                    </div>
                  </div>
                </LuxuryCard>

                {expandedInvoice === inv.id && (
                  <InvoiceDetailInline
                    invoice={inv}
                    projectId={projectId}
                    devis={dv}
                    contractorName={contractorMap.get(inv.contractorId) ?? `#${inv.contractorId}`}
                    isArchived={isArchived}
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <LuxuryCard data-testid="card-empty-factures">
          <p className="text-[12px] text-muted-foreground text-center py-6">
            No invoices for this project yet. Upload an invoice PDF to get started.
          </p>
        </LuxuryCard>
      )}

      <Dialog open={uploadDialogOpen} onOpenChange={(open) => { if (!uploadMutation.isPending) setUploadDialogOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight">Upload Invoice PDF</DialogTitle>
            <DialogDescription className="text-[11px]">Select the Devis this invoice relates to, then upload the contractor's invoice PDF.</DialogDescription>
          </DialogHeader>
          {uploadMutation.isPending ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-[#0B2545]" />
              <p className="text-[11px] text-muted-foreground text-center">Processing PDF... Extracting invoice details</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="text-[11px] font-semibold text-foreground block mb-1.5">Devis</label>
                <select
                  className="w-full border rounded-xl px-3 py-2 text-[12px] bg-white"
                  value={selectedDevisId ?? ""}
                  onChange={(e) => setSelectedDevisId(e.target.value ? Number(e.target.value) : null)}
                  data-testid="select-devis-for-upload"
                >
                  <option value="">Select a Devis...</option>
                  {(devisList ?? []).filter(d => d.status !== "void").map(d => (
                    <option key={d.id} value={d.id}>
                      {d.devisCode} — {contractorMap.get(d.contractorId) ?? `#${d.contractorId}`} — {formatCurrency(parseFloat(d.amountTtc))}
                    </option>
                  ))}
                </select>
              </div>
              {selectedDevisId && (
                <div
                  className="border-2 border-dashed border-[#c1a27b]/40 rounded-2xl p-8 text-center cursor-pointer hover:border-[#c1a27b] hover:bg-[#c1a27b]/5 transition-all"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="dropzone-facture-upload"
                >
                  <FileUp className="h-8 w-8 mx-auto mb-2 text-[#c1a27b]" />
                  <p className="text-[12px] font-semibold text-foreground">Click to select invoice PDF</p>
                  <p className="text-[10px] text-muted-foreground mt-1">PDF files only — the AI will extract invoice number, amounts, and date</p>
                </div>
              )}
              {!selectedDevisId && (
                <p className="text-[10px] text-muted-foreground text-center py-4">Please select a Devis above first</p>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file && selectedDevisId) uploadMutation.mutate({ file, devisId: selectedDevisId });
                  if (e.target) e.target.value = "";
                }}
                data-testid="input-facture-file"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ValidationWarning {
  field: string;
  expected: number | string | boolean;
  actual: number | string | boolean | undefined;
  message: string;
  severity: "error" | "warning";
}

function ConfidenceIndicator({ score }: { score: number }) {
  const color = score >= 80 ? "text-emerald-600" : score >= 50 ? "text-amber-600" : "text-rose-600";
  const bgColor = score >= 80 ? "bg-emerald-100" : score >= 50 ? "bg-amber-100" : "bg-rose-100";
  const label = score >= 80 ? "High" : score >= 50 ? "Medium" : "Low";
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md ${bgColor}`} data-testid="indicator-ai-confidence">
      <Sparkles size={12} className={color} />
      <span className={`text-[11px] font-semibold ${color}`}>{label} ({score}%)</span>
    </div>
  );
}

function DraftReviewPanel({ invoice, projectId, devis, isArchived = false }: {
  invoice: Invoice;
  projectId: string;
  devis?: Devis;
  isArchived?: boolean;
}) {
  const { toast } = useToast();
  const warnings = (invoice.validationWarnings as ValidationWarning[] | null) ?? [];
  const confidence = invoice.aiConfidence ?? 50;

  const [editAmountHt, setEditAmountHt] = useState(invoice.amountHt);
  const [editAmountTtc, setEditAmountTtc] = useState(invoice.amountTtc);
  const [editInvoiceNumber, setEditInvoiceNumber] = useState(String(invoice.invoiceNumber));
  const [editDateIssued, setEditDateIssued] = useState(invoice.dateIssued ?? "");

  const fieldWarnings = (field: string) => warnings.filter(w => w.field === field);

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const corrections: Record<string, any> = {};
      if (editAmountHt !== invoice.amountHt) corrections.amountHt = editAmountHt;
      if (editAmountTtc !== invoice.amountTtc) corrections.amountTtc = editAmountTtc;
      if (editInvoiceNumber !== String(invoice.invoiceNumber)) corrections.invoiceNumber = editInvoiceNumber;
      if (editDateIssued !== (invoice.dateIssued ?? "")) corrections.dateIssued = editDateIssued || null;

      const res = await apiRequest("POST", `/api/invoices/${invoice.id}/confirm`, corrections);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      toast({ title: "Invoice confirmed", description: "Invoice moved to pending — ready for approval" });
    },
    onError: (error: Error) => {
      toast({ title: "Confirmation failed", description: error.message, variant: "destructive" });
    },
  });

  const discardMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/invoices/${invoice.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      toast({ title: "Draft discarded", description: "The draft invoice has been deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  return (
    <div className="p-4 rounded-xl border-2 border-blue-200 bg-blue-50/30 space-y-4" data-testid={`panel-draft-review-${invoice.id}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <Sparkles size={16} className="text-blue-600" />
          <div>
            <p className="text-[13px] font-semibold text-blue-800">AI-Extracted Invoice — Review Required</p>
            <p className="text-[10px] text-blue-600 mt-0.5">Verify the values below, edit if needed, then confirm to proceed</p>
          </div>
        </div>
        <ConfidenceIndicator score={confidence} />
      </div>

      {warnings.length > 0 && (
        <div className="space-y-1.5" data-testid={`list-validation-warnings-${invoice.id}`}>
          {warnings.map((w, idx) => (
            <div
              key={idx}
              className={`flex items-start gap-2 p-2 rounded-md text-[11px] ${w.severity === "error" ? "bg-rose-50 text-rose-700 border border-rose-200" : "bg-amber-50 text-amber-700 border border-amber-200"}`}
              data-testid={`warning-${w.field}-${idx}`}
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Persisted Advisories
        </p>
        <AdvisoriesList subject={{ type: "invoice", id: invoice.id }} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] font-semibold text-foreground block mb-1">
            Amount HT
            {fieldWarnings("amountHt").length > 0 && <Badge variant="destructive" className="ml-1 text-[8px]">Flagged</Badge>}
          </label>
          <Input
            type="number"
            step="0.01"
            value={editAmountHt}
            onChange={(e) => setEditAmountHt(e.target.value)}
            className="text-[12px]"
            data-testid={`input-draft-ht-${invoice.id}`}
          />
        </div>
        <div>
          <label className="text-[10px] font-semibold text-foreground block mb-1">
            Amount TTC
            {fieldWarnings("amountTtc").length > 0 && <Badge variant="destructive" className="ml-1 text-[8px]">Flagged</Badge>}
          </label>
          <Input
            type="number"
            step="0.01"
            value={editAmountTtc}
            onChange={(e) => setEditAmountTtc(e.target.value)}
            className="text-[12px]"
            data-testid={`input-draft-ttc-${invoice.id}`}
          />
        </div>
        <div className="col-span-2">
          <TvaDerivedHint
            amountHt={editAmountHt}
            amountTtc={editAmountTtc}
            testId={`text-draft-invoice-tva-derived-${invoice.id}`}
          />
        </div>
        <div>
          <label className="text-[10px] font-semibold text-foreground block mb-1">Invoice Number</label>
          <Input
            type="text"
            value={editInvoiceNumber}
            onChange={(e) => setEditInvoiceNumber(e.target.value)}
            className="text-[12px]"
            data-testid={`input-draft-invoice-number-${invoice.id}`}
          />
        </div>
        <div>
          <label className="text-[10px] font-semibold text-foreground block mb-1">Date Issued</label>
          <Input
            type="date"
            value={editDateIssued}
            onChange={(e) => setEditDateIssued(e.target.value)}
            className="text-[12px]"
            data-testid={`input-draft-date-${invoice.id}`}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-rose-600 border-rose-200"
          onClick={() => discardMutation.mutate()}
          disabled={discardMutation.isPending || confirmMutation.isPending || isArchived}
          data-testid={`button-discard-draft-${invoice.id}`}
        >
          {discardMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          <span className="text-[9px] font-bold uppercase tracking-widest">
            {discardMutation.isPending ? "Deleting..." : "Discard"}
          </span>
        </Button>
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => confirmMutation.mutate()}
          disabled={confirmMutation.isPending || discardMutation.isPending || isArchived}
          data-testid={`button-confirm-draft-${invoice.id}`}
        >
          {confirmMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
          <span className="text-[9px] font-bold uppercase tracking-widest">
            {confirmMutation.isPending ? "Confirming..." : "Confirm Invoice"}
          </span>
        </Button>
      </div>
    </div>
  );
}

function InvoiceDetailInline({ invoice, projectId, devis, contractorName, isArchived = false }: {
  invoice: Invoice;
  projectId: string;
  devis?: Devis;
  contractorName: string;
  isArchived?: boolean;
}) {
  const { toast } = useToast();
  const [notes, setNotes] = useState(invoice.notes ?? "");
  const [notesEditing, setNotesEditing] = useState(false);

  const updateNotesMutation = useMutation({
    mutationFn: async (newNotes: string) => {
      await apiRequest("PATCH", `/api/invoices/${invoice.id}`, { notes: newNotes });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "invoices"] });
      setNotesEditing(false);
      toast({ title: "Notes saved" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save notes", description: error.message, variant: "destructive" });
    },
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/invoices/${invoice.id}/approve`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fee-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      const commission = data.commissionAmount;
      if (commission > 0) {
        toast({ title: "Invoice approved", description: `${formatCurrency(commission)} commission added to Honoraires` });
      } else {
        toast({ title: "Invoice approved", description: "No commission rate set — set Honoraires % in the project header" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Approval failed", description: error.message, variant: "destructive" });
    },
  });


  return (
    <div className="ml-4 mt-2 space-y-4 border-l-2 border-[#c1a27b]/30 pl-4 pb-2">
      <div className="space-y-1.5" data-testid={`section-advisories-invoice-${invoice.id}`}>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Extraction Advisories
        </p>
        <AdvisoriesList subject={{ type: "invoice", id: invoice.id }} />
      </div>

      {invoice.status === "draft" && (
        <DraftReviewPanel invoice={invoice} projectId={projectId} devis={devis} isArchived={isArchived} />
      )}

      {invoice.status === "pending" && (
        <div className="p-4 rounded-xl border-2 border-amber-200 bg-amber-50/50 flex items-center justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-amber-800">Pending Approval</p>
            <p className="text-[10px] text-amber-600 mt-0.5">Review the extracted data below, then approve to calculate commission</p>
          </div>
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={approveMutation.isPending || isArchived}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
            data-testid={`button-approve-invoice-${invoice.id}`}
          >
            {approveMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            <span className="text-[10px] font-bold uppercase tracking-widest">
              {approveMutation.isPending ? "Approving..." : "Approve Invoice"}
            </span>
          </Button>
        </div>
      )}

      {invoice.status === "approved" && (
        <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50/50 flex items-center gap-2">
          <CheckCircle2 size={16} className="text-emerald-600" />
          <p className="text-[12px] font-semibold text-emerald-700">Approved — commission calculated and added to Honoraires</p>
        </div>
      )}

      {invoice.status !== "draft" && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
              <TechnicalLabel>Amount HT</TechnicalLabel>
              <p className="text-[15px] font-semibold text-foreground mt-1" data-testid={`text-detail-ht-${invoice.id}`}>
                {formatCurrency(parseFloat(invoice.amountHt))}
              </p>
            </div>
            <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
              <TechnicalLabel>TVA (derived)</TechnicalLabel>
              <p className="text-[15px] font-semibold text-foreground mt-1" data-testid={`text-detail-tva-${invoice.id}`}>
                {formatCurrency(parseFloat(invoice.amountTtc) - parseFloat(invoice.amountHt))}
              </p>
            </div>
            <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
              <TechnicalLabel>Amount TTC</TechnicalLabel>
              <p className="text-[15px] font-semibold text-[#0B2545] mt-1" data-testid={`text-detail-ttc-${invoice.id}`}>
                {formatCurrency(parseFloat(invoice.amountTtc))}
              </p>
            </div>
            <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
              <TechnicalLabel>Status</TechnicalLabel>
              <div className="mt-2"><StatusBadge status={invoice.status} /></div>
            </div>
          </div>
          <TvaDerivedHint
            amountHt={invoice.amountHt}
            amountTtc={invoice.amountTtc}
            testId={`text-invoice-detail-tva-derived-${invoice.id}`}
          />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
              <div className="flex items-center gap-1.5 mb-1">
                <Building2 size={10} className="text-muted-foreground" />
                <TechnicalLabel>Contractor</TechnicalLabel>
              </div>
              <p className="text-[12px] font-medium text-foreground">{contractorName}</p>
            </div>
            <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
              <div className="flex items-center gap-1.5 mb-1">
                <Receipt size={10} className="text-muted-foreground" />
                <TechnicalLabel>Related Devis</TechnicalLabel>
              </div>
              <p className="text-[12px] font-medium text-foreground">
                {devis ? `${devis.devisCode} — ${devis.descriptionFr}` : `Devis #${invoice.devisId}`}
              </p>
            </div>
            <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
              <div className="flex items-center gap-1.5 mb-1">
                <Calendar size={10} className="text-muted-foreground" />
                <TechnicalLabel>Dates</TechnicalLabel>
              </div>
              <div className="text-[11px] space-y-0.5">
                {invoice.dateIssued ? (
                  <p className="font-medium text-foreground">Issued: {new Date(invoice.dateIssued).toLocaleDateString("fr-FR")}</p>
                ) : (
                  <p className="text-muted-foreground italic">No issue date</p>
                )}
                {invoice.dateSent && <p className="text-foreground">Sent: {new Date(invoice.dateSent).toLocaleDateString("fr-FR")}</p>}
                {invoice.datePaid && <p className="text-emerald-600 font-medium">Paid: {new Date(invoice.datePaid).toLocaleDateString("fr-FR")}</p>}
              </div>
            </div>
          </div>
        </>
      )}

      {invoice.certificateNumber && (
        <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50/50">
          <div className="flex items-center gap-1.5 mb-1">
            <Hash size={10} className="text-emerald-600" />
            <TechnicalLabel>Payment Certificate</TechnicalLabel>
          </div>
          <p className="text-[12px] text-emerald-700 font-semibold">Certificat: {invoice.certificateNumber}</p>
        </div>
      )}

      <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
        <div className="flex items-center justify-between mb-2">
          <TechnicalLabel>Notes</TechnicalLabel>
          {!notesEditing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[9px] font-bold uppercase tracking-widest"
              onClick={() => setNotesEditing(true)}
              disabled={isArchived}
              data-testid={`button-edit-notes-${invoice.id}`}
            >
              Edit
            </Button>
          )}
        </div>
        {notesEditing ? (
          <div className="space-y-2">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="text-[12px] min-h-[80px]"
              placeholder="Add notes about this invoice..."
              data-testid={`textarea-notes-${invoice.id}`}
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" className="h-7 text-[9px]" onClick={() => { setNotes(invoice.notes ?? ""); setNotesEditing(false); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-7 text-[9px] gap-1"
                onClick={() => updateNotesMutation.mutate(notes)}
                disabled={updateNotesMutation.isPending}
                data-testid={`button-save-notes-${invoice.id}`}
              >
                <Save size={10} />
                {updateNotesMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <p className={`text-[12px] ${notes ? "text-foreground" : "text-muted-foreground italic"}`}>
            {notes || "No notes yet. Click Edit to add notes."}
          </p>
        )}
      </div>
    </div>
  );
}
