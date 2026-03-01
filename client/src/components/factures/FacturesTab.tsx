import { useState, useRef } from "react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ChevronRight, FileText, Upload, FileUp, Loader2, ExternalLink, Save } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Invoice, Contractor, Devis } from "@shared/schema";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

interface FacturesTabProps {
  projectId: string;
  contractors: Contractor[];
}

export function FacturesTab({ projectId, contractors }: FacturesTabProps) {
  const { toast } = useToast();
  const [expandedInvoice, setExpandedInvoice] = useState<number | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
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

  const [selectedDevisId, setSelectedDevisId] = useState<number | null>(null);

  const totalHt = (invoices ?? []).reduce((s, i) => s + parseFloat(i.amountHt), 0);
  const totalTtc = (invoices ?? []).reduce((s, i) => s + parseFloat(i.amountTtc), 0);
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
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <LuxuryCard data-testid="card-factures-count">
          <TechnicalLabel>Total Factures</TechnicalLabel>
          <p className="text-[20px] font-light text-foreground mt-1" data-testid="text-factures-count">{invoices?.length ?? 0}</p>
        </LuxuryCard>
        <LuxuryCard data-testid="card-factures-total">
          <TechnicalLabel>Total Amount</TechnicalLabel>
          <p className="text-[16px] font-semibold text-foreground mt-1">{formatCurrency(totalTtc)} <span className="text-[9px] text-muted-foreground">TTC</span></p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(totalHt)} HT</p>
        </LuxuryCard>
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
        <Button
          onClick={() => setUploadDialogOpen(true)}
          data-testid="button-upload-facture"
        >
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
                          {dv && <span className="text-muted-foreground ml-2">— {dv.devisCode}</span>}
                        </p>
                        {inv.dateIssued && (
                          <span className="text-[10px] text-muted-foreground">
                            Issued: {new Date(inv.dateIssued).toLocaleDateString("fr-FR")}
                          </span>
                        )}
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
                      <StatusBadge status={inv.status} />
                    </div>
                  </div>
                </LuxuryCard>

                {expandedInvoice === inv.id && (
                  <InvoiceDetailInline invoice={inv} projectId={projectId} devis={dv} contractorName={contractorMap.get(inv.contractorId) ?? `#${inv.contractorId}`} />
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

function InvoiceDetailInline({ invoice, projectId, devis, contractorName }: {
  invoice: Invoice;
  projectId: string;
  devis?: Devis;
  contractorName: string;
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

  return (
    <div className="ml-4 mt-2 space-y-4 border-l-2 border-[#c1a27b]/30 pl-4 pb-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Amount HT</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1">{formatCurrency(parseFloat(invoice.amountHt))}</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>TVA</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1">{formatCurrency(parseFloat(invoice.tvaAmount))}</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Amount TTC</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1">{formatCurrency(parseFloat(invoice.amountTtc))}</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Status</TechnicalLabel>
          <div className="mt-1"><StatusBadge status={invoice.status} /></div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Contractor</TechnicalLabel>
          <p className="text-[12px] text-foreground mt-1">{contractorName}</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Related Devis</TechnicalLabel>
          <p className="text-[12px] text-foreground mt-1">{devis ? devis.devisCode : `#${invoice.devisId}`}</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Dates</TechnicalLabel>
          <div className="text-[11px] mt-1 space-y-0.5">
            {invoice.dateIssued && <p>Issued: {new Date(invoice.dateIssued).toLocaleDateString("fr-FR")}</p>}
            {invoice.dateSent && <p>Sent: {new Date(invoice.dateSent).toLocaleDateString("fr-FR")}</p>}
            {invoice.datePaid && <p className="text-emerald-600">Paid: {new Date(invoice.datePaid).toLocaleDateString("fr-FR")}</p>}
            {!invoice.dateIssued && !invoice.dateSent && !invoice.datePaid && <p className="text-muted-foreground">No dates recorded</p>}
          </div>
        </div>
      </div>

      {invoice.pdfPath && (
        <div className="rounded-2xl border border-[rgba(0,0,0,0.08)] overflow-hidden bg-white/50">
          <div className="flex items-center justify-between px-4 py-2 border-b border-[rgba(0,0,0,0.06)]">
            <TechnicalLabel>Original PDF</TechnicalLabel>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 gap-1.5 border-[#0B2545]/20 text-[#0B2545] hover:bg-[#0B2545]/5"
              onClick={() => window.open(`/api/invoices/${invoice.id}/pdf`, "_blank")}
              data-testid={`button-open-pdf-newtab-${invoice.id}`}
            >
              <ExternalLink size={12} />
              <span className="text-[9px] font-bold uppercase tracking-widest">Open in New Tab</span>
            </Button>
          </div>
          <iframe
            src={`/api/invoices/${invoice.id}/pdf`}
            className="w-full h-[500px] border-0"
            title={`Invoice ${invoice.invoiceNumber} PDF`}
            data-testid={`iframe-pdf-facture-${invoice.id}`}
          />
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

      {invoice.certificateNumber && (
        <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50/50">
          <TechnicalLabel>Payment Certificate</TechnicalLabel>
          <p className="text-[12px] text-emerald-700 mt-1 font-semibold">Certificat: {invoice.certificateNumber}</p>
        </div>
      )}
    </div>
  );
}
