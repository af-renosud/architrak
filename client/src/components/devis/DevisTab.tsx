import { useState, useCallback, useRef } from "react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Plus, ChevronDown, ChevronRight, FileText, ArrowUpRight, ArrowDownRight, Upload, Loader2, ExternalLink, Check, Ban, AlertTriangle, Eye, EyeOff, ShieldCheck, ShieldAlert, ShieldX, Trash2, X, Tag, Settings as SettingsIcon, Wand2, Pencil, UserCog } from "lucide-react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertDevisLineItemSchema, insertAvenantSchema, insertLotSchema } from "@shared/schema";
import type { Devis, Contractor, Lot, LotCatalog, DevisLineItem, Avenant, Invoice, DevisRefEdit } from "@shared/schema";
import { formatLotDescription } from "@shared/lot-label";
import { z } from "zod";
import { AdvisoriesList, AdvisoryBadge } from "@/components/advisories/AdvisoriesList";
import { DevisTranslationSection } from "@/components/devis/DevisTranslationSection";
import { ContractorSelect } from "@/components/ui/contractor-select";
import { TvaDerivedHint } from "@/components/ui/tva-derived-hint";
import {
  partitionDraftWarnings,
  focusContractorSelect,
  ContractorAdvisoryBanner,
  GenericValidationWarningsList,
  type DraftValidationWarning,
} from "@/components/devis/draft-warnings";

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
  isArchived?: boolean;
}

export function DevisTab({ projectId, contractors, lots, isArchived = false }: DevisTabProps) {
  const { toast } = useToast();
  const [expandedDevis, setExpandedDevis] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showVoid, setShowVoid] = useState(false);
  const [draftReviewData, setDraftReviewData] = useState<{
    devisId: number;
    extraction: any;
    validation: any;
    devis: any;
  } | null>(null);
  const [editRefsFor, setEditRefsFor] = useState<Devis | null>(null);
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
      setUploading(false);
      if (data.devis?.status === "draft" && data.validation) {
        setDraftReviewData({
          devisId: data.devis.id,
          extraction: data.extraction,
          validation: data.validation,
          devis: data.devis,
        });
      } else {
        const ext = data.extraction;
        const matchInfo = ext.matchConfidence > 0
          ? ` • Matched: ${ext.contractorName} (${Math.round(ext.matchConfidence)}%)`
          : "";
        toast({
          title: "Devis created from PDF",
          description: `${ext.documentType || "document"} — ${formatCurrency(parseFloat(data.devis.amountHt))} HT${matchInfo}${ext.lineItemsCreated > 0 ? ` • ${ext.lineItemsCreated} line items` : ""}`,
        });
      }
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
              disabled={isArchived}
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
                        {d.devisNumber && <span className="text-[11px] text-muted-foreground" data-testid={`text-devis-number-${d.id}`}>N° {d.devisNumber}</span>}
                        {d.ref2 && <span className="text-[11px] text-muted-foreground" data-testid={`text-devis-ref2-${d.id}`}>Ref {d.ref2}</span>}
                        {d.status !== "void" && !isArchived && (
                          <button
                            type="button"
                            className="p-0.5 text-muted-foreground hover:text-[#0B2545] transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditRefsFor(d);
                            }}
                            title="Edit contractor, devis code & references"
                            data-testid={`button-edit-devis-refs-${d.id}`}
                          >
                            <Pencil size={11} />
                          </button>
                        )}
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
                    <AdvisoryBadge subject={{ type: "devis", id: d.id }} />
                    <StatusBadge status={d.status} />
                    {d.status === "draft" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDraftReviewData({
                            devisId: d.id,
                            extraction: {
                              contractorName: contractors.find(c => c.id === d.contractorId)?.name ?? "Unknown",
                              contractorId: d.contractorId,
                            },
                            validation: {
                              isValid: !(d.validationWarnings as any[])?.some((w: any) => w.severity === "error"),
                              warnings: (d.validationWarnings as any[]) || [],
                              confidenceScore: d.aiConfidence ?? 50,
                            },
                            devis: d,
                          });
                        }}
                        disabled={isArchived}
                        data-testid={`button-review-draft-${d.id}`}
                      >
                        <ShieldAlert size={12} />
                        <span className="text-[9px] font-bold uppercase tracking-widest">Review</span>
                      </Button>
                    )}
                  </div>
                </div>
              </LuxuryCard>

              {expandedDevis === d.id && (
                <DevisDetailInline
                  devis={d}
                  projectId={projectId}
                  contractors={contractors}
                  lots={lots}
                  isArchived={isArchived}
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

      {draftReviewData && (
        <DraftReviewPanel
          data={draftReviewData}
          projectId={projectId}
          contractors={contractors}
          onClose={() => setDraftReviewData(null)}
          isArchived={isArchived}
        />
      )}

      {editRefsFor && (
        <EditDevisRefsDialog
          devis={editRefsFor}
          projectId={projectId}
          contractors={contractors}
          onClose={() => setEditRefsFor(null)}
        />
      )}
    </div>
  );
}

const REF_FIELD_LABELS: Record<string, string> = {
  devisCode: "Devis Code",
  devisNumber: "Supplier Reference (N°)",
  ref2: "Additional Reference",
  contractorId: "Contractor",
};

function parseContractorRef(v: string | null | undefined): { id: number | null; name: string } | null {
  if (v == null || v === "") return null;
  const colonAt = v.indexOf(":");
  if (colonAt <= 0) return { id: null, name: v };
  const idStr = v.slice(0, colonAt);
  const name = v.slice(colonAt + 1);
  const id = Number(idStr);
  return { id: Number.isFinite(id) ? id : null, name };
}

function formatRefValue(v: string | null | undefined, field?: string) {
  if (v == null || v === "") return "—";
  if (field === "contractorId") {
    const parsed = parseContractorRef(v);
    return parsed?.name || v;
  }
  return v;
}

function formatEditTimestamp(ts: string | Date) {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toLocaleString();
}

function DevisRefEditsHistory({ devisId, projectId }: { devisId: number; projectId: string }) {
  const { toast } = useToast();
  const { data: edits } = useQuery<DevisRefEdit[]>({
    queryKey: ["/api/devis", devisId, "ref-edits"],
  });
  const [revertCandidate, setRevertCandidate] = useState<DevisRefEdit | null>(null);

  const revertMutation = useMutation({
    mutationFn: async (edit: DevisRefEdit) => {
      const raw = edit.previousValue;
      let payload: Record<string, unknown>;
      if (edit.field === "contractorId") {
        const parsed = parseContractorRef(raw);
        if (!parsed?.id) {
          throw new Error("Cannot revert: previous contractor reference is malformed");
        }
        payload = { contractorId: parsed.id };
      } else {
        const normalized = edit.field === "devisCode" ? raw : (raw == null || raw === "" ? null : raw);
        payload = { [edit.field]: normalized };
      }
      const res = await apiRequest("PATCH", `/api/devis/${devisId}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "ref-edits"] });
      toast({ title: "Reference reverted" });
      setRevertCandidate(null);
    },
    onError: (error: Error) => {
      toast({ title: "Revert failed", description: error.message, variant: "destructive" });
    },
  });

  if (!edits || edits.length === 0) return null;
  const last = edits[0];
  const editor = last.editedByEmail ?? "Unknown editor";

  return (
    <div className="flex items-center gap-2 text-[10px] text-muted-foreground" data-testid={`section-ref-edits-${devisId}`}>
      <span data-testid={`text-last-ref-edit-${devisId}`}>
        Last edited {REF_FIELD_LABELS[last.field] ?? last.field} by {editor} on {formatEditTimestamp(last.editedAt)}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="underline hover:text-[#0B2545] transition-colors"
            data-testid={`button-ref-edit-history-${devisId}`}
          >
            View history ({edits.length})
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-96 max-h-80 overflow-y-auto" align="start" data-testid={`popover-ref-edit-history-${devisId}`}>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#0B2545]">Reference edit history</p>
            <ul className="space-y-2">
              {edits.map((e) => {
                const canRevert = e.field !== "devisCode" || (e.previousValue != null && e.previousValue !== "");
                const latestForField = edits.find((x) => x.field === e.field);
                const isCurrentValueOfField = latestForField
                  ? (latestForField.newValue ?? "") === (e.previousValue ?? "")
                  : false;
                return (
                  <li
                    key={e.id}
                    className="text-[10px] border-b border-[rgba(0,0,0,0.06)] pb-2 last:border-b-0 last:pb-0"
                    data-testid={`row-ref-edit-${e.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-foreground">
                          {REF_FIELD_LABELS[e.field] ?? e.field}
                        </div>
                        <div className="text-muted-foreground">
                          <span className="line-through">{formatRefValue(e.previousValue, e.field)}</span>
                          <span className="mx-1">→</span>
                          <span className="text-foreground">{formatRefValue(e.newValue, e.field)}</span>
                        </div>
                        <div className="text-muted-foreground mt-0.5">
                          {(e.editedByEmail ?? "Unknown editor")} · {formatEditTimestamp(e.editedAt)}
                        </div>
                      </div>
                      {canRevert && !isCurrentValueOfField && (
                        <button
                          type="button"
                          className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-[#0B2545] underline hover:text-[#1a3a6b] transition-colors disabled:opacity-50"
                          onClick={() => setRevertCandidate(e)}
                          disabled={revertMutation.isPending}
                          data-testid={`button-revert-ref-edit-${e.id}`}
                        >
                          Revert
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </PopoverContent>
      </Popover>
      <AlertDialog open={revertCandidate !== null} onOpenChange={(open) => { if (!open && !revertMutation.isPending) setRevertCandidate(null); }}>
        <AlertDialogContent data-testid={`dialog-confirm-revert-${devisId}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert this reference?</AlertDialogTitle>
            <AlertDialogDescription>
              {revertCandidate && (
                <>
                  This will set <strong>{REF_FIELD_LABELS[revertCandidate.field] ?? revertCandidate.field}</strong> back to{" "}
                  <strong>{formatRefValue(revertCandidate.previousValue)}</strong>. The change will be recorded in the edit history under your name.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revertMutation.isPending} data-testid={`button-cancel-revert-${devisId}`}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={revertMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (revertCandidate) revertMutation.mutate(revertCandidate);
              }}
              data-testid={`button-confirm-revert-${devisId}`}
            >
              {revertMutation.isPending ? "Reverting…" : "Revert"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface EditDevisRefsDialogProps {
  devis: Devis;
  projectId: string;
  contractors: Contractor[];
  onClose: () => void;
}

function EditDevisRefsDialog({ devis, projectId, contractors, onClose }: EditDevisRefsDialogProps) {
  const { toast } = useToast();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [contractorId, setContractorIdState] = useState<number>(devis.contractorId);
  const [devisCode, setDevisCode] = useState(devis.devisCode ?? "");
  const [devisNumber, setDevisNumber] = useState(devis.devisNumber ?? "");
  const [ref2, setRef2] = useState(devis.ref2 ?? "");

  const mutation = useMutation({
    mutationFn: async (payload: Record<string, string | number | null>) => {
      const res = await apiRequest("PATCH", `/api/devis/${devis.id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "ref-edits"] });
      toast({ title: "References updated" });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    if (!isAuthenticated) {
      toast({
        title: "Sign in required",
        description: "You must be signed in as an architect to edit devis references.",
        variant: "destructive",
      });
      return;
    }
    const trimmedCode = devisCode.trim();
    const trimmedNumber = devisNumber.trim();
    const trimmedRef2 = ref2.trim();
    if (!trimmedCode) {
      toast({ title: "Devis code required", description: "Devis code cannot be empty", variant: "destructive" });
      return;
    }
    const payload: Record<string, string | number | null> = {};
    if (contractorId !== devis.contractorId) payload.contractorId = contractorId;
    if (trimmedCode !== (devis.devisCode ?? "")) payload.devisCode = trimmedCode;
    if (trimmedNumber !== (devis.devisNumber ?? "")) payload.devisNumber = trimmedNumber === "" ? null : trimmedNumber;
    if (trimmedRef2 !== (devis.ref2 ?? "")) payload.ref2 = trimmedRef2 === "" ? null : trimmedRef2;
    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="dialog-edit-devis-refs">
        <DialogHeader>
          <DialogTitle className="text-[14px] font-black uppercase tracking-tight">Edit References</DialogTitle>
          <DialogDescription className="text-[11px]">
            Correct the devis code or supplier reference numbers if the AI mis-extracted them.
          </DialogDescription>
        </DialogHeader>
        {!authLoading && !isAuthenticated && (
          <div
            className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive"
            data-testid="text-edit-devis-refs-auth-warning"
          >
            You're signed out. Sign in as an architect to edit devis references — anonymous edits aren't allowed.
          </div>
        )}
        <div className="space-y-3">
          <div className="space-y-1">
            <TechnicalLabel>Contractor</TechnicalLabel>
            <ContractorSelect
              contractors={contractors}
              value={contractorId}
              onChange={setContractorIdState}
              testId="select-edit-devis-contractor"
            />
          </div>
          <div className="space-y-1">
            <TechnicalLabel>Devis Code</TechnicalLabel>
            <Input
              value={devisCode}
              onChange={(e) => setDevisCode(e.target.value)}
              className="text-[12px]"
              placeholder="e.g. GRACE_1348_1"
              data-testid="input-edit-devis-code"
            />
          </div>
          <div className="space-y-1">
            <TechnicalLabel>Supplier Reference (N°)</TechnicalLabel>
            <Input
              value={devisNumber}
              onChange={(e) => setDevisNumber(e.target.value)}
              className="text-[12px]"
              placeholder="e.g. DVP0000580"
              data-testid="input-edit-devis-number"
            />
          </div>
          <div className="space-y-1">
            <TechnicalLabel>Additional Reference</TechnicalLabel>
            <Input
              value={ref2}
              onChange={(e) => setRef2(e.target.value)}
              className="text-[12px]"
              placeholder="Optional"
              data-testid="input-edit-devis-ref2"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={mutation.isPending}
            data-testid="button-cancel-edit-devis-refs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={mutation.isPending || !devisCode.trim() || !isAuthenticated || authLoading}
            data-testid="button-save-edit-devis-refs"
          >
            {mutation.isPending ? <Loader2 size={12} className="animate-spin" /> : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface DraftReviewPanelProps {
  data: {
    devisId: number;
    extraction: any;
    validation: any;
    devis: any;
  };
  projectId: string;
  contractors: Contractor[];
  onClose: () => void;
  isArchived?: boolean;
}

interface LotReferenceWarningBannerProps {
  warnings: Array<{ field: string; expected: any; actual: any; message: string; severity: "error" | "warning" }>;
  projectId: string;
  devisId: number;
  isArchived?: boolean;
}

function LotReferenceWarningBanner({
  warnings,
  projectId,
  devisId,
  isArchived = false,
}: LotReferenceWarningBannerProps) {
  const { toast } = useToast();
  const [addingNew, setAddingNew] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newDescUk, setNewDescUk] = useState("");
  const [suggesting, setSuggesting] = useState(false);

  const { data: lotCatalog = [] } = useQuery<LotCatalog[]>({
    queryKey: ["/api/lot-catalog"],
  });

  const suggestMutation = useMutation({
    mutationFn: async (data: { descriptionFr: string; code?: string }) => {
      const res = await apiRequest("POST", "/api/lot-catalog/translate", data);
      return (await res.json()) as { translation: string };
    },
    onError: (error: Error) => {
      toast({ title: "Could not suggest translation", description: error.message, variant: "destructive" });
    },
  });

  const handleSuggest = async () => {
    const fr = newDesc.trim();
    if (!fr) return;
    setSuggesting(true);
    try {
      const result = await suggestMutation.mutateAsync({ descriptionFr: fr, code: newCode.trim() || undefined });
      if (result?.translation) setNewDescUk(result.translation);
    } catch {
      // handled in onError
    } finally {
      setSuggesting(false);
    }
  };

  const assignMutation = useMutation({
    mutationFn: async (catalogCode: string) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/lots/assign-from-catalog`, {
        catalogCode,
        devisId,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "lots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      toast({ title: "Lot assigned" });
    },
    onError: (error: Error) => {
      toast({ title: "Error assigning lot", description: error.message, variant: "destructive" });
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: { code: string; descriptionFr: string; descriptionUk?: string | null }) => {
      const res = await apiRequest("POST", `/api/lot-catalog`, data);
      return res.json();
    },
    onSuccess: (entry: LotCatalog) => {
      queryClient.invalidateQueries({ queryKey: ["/api/lot-catalog"] });
      assignMutation.mutate(entry.code);
      setAddingNew(false);
      setNewCode("");
      setNewDesc("");
      setNewDescUk("");
      toast({ title: "Lot added to master list" });
    },
    onError: (error: Error) => {
      toast({ title: "Error creating lot", description: error.message, variant: "destructive" });
    },
  });

  if (warnings.length === 0) return null;

  return (
    <div
      className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/40 p-3 space-y-2.5"
      data-testid={`banner-needs-new-lot-${devisId}`}
    >
      <div className="flex items-start gap-2">
        <Tag size={16} className="text-amber-600 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-amber-800">
            Needs new lot
          </p>
          <p className="text-[10px] mt-0.5 text-amber-800/90">
            The AI suggested lot code(s) that don't exist in the master catalog. Pick an existing master code or add a new one before confirming.
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {warnings.map((w, i) => (
              <li
                key={i}
                className="text-[10px] text-foreground/80 font-mono truncate"
                data-testid={`needs-new-lot-suggestion-${devisId}-${i}`}
              >
                AI suggested: <span className="font-semibold">"{String(w.actual ?? "")}"</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {!isArchived && (
        <div className="space-y-2 pl-6">
          {!addingNew ? (
            <div className="flex items-center gap-2 flex-wrap">
              <Select
                onValueChange={(val) => {
                  if (val === "__new__") setAddingNew(true);
                  else assignMutation.mutate(val);
                }}
                disabled={assignMutation.isPending}
              >
                <SelectTrigger className="flex-1 h-8 text-[11px] bg-white" data-testid={`select-needs-new-lot-${devisId}`}>
                  <SelectValue placeholder="Pick a master lot code..." />
                </SelectTrigger>
                <SelectContent>
                  {lotCatalog.map((entry) => (
                    <SelectItem key={entry.id} value={entry.code} data-testid={`option-needs-new-lot-${entry.code}`}>
                      {entry.code} — {formatLotDescription(entry)}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">+ Add new lot to master list</SelectItem>
                </SelectContent>
              </Select>
              <Link href="/settings">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 gap-1 text-[10px] text-amber-800 hover:text-amber-900"
                  data-testid={`link-manage-master-list-${devisId}`}
                >
                  <SettingsIcon size={11} />
                  Manage master list
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-2 p-2 rounded-md border border-amber-300 bg-white/70">
              <p className="text-[9px] text-muted-foreground">Adds to the master list — available across all projects.</p>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Code (e.g. LOT3)"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  className="text-[11px] h-8"
                  data-testid={`input-needs-new-lot-code-${devisId}`}
                />
                <Input
                  placeholder="French description"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="text-[11px] h-8"
                  data-testid={`input-needs-new-lot-desc-${devisId}`}
                />
              </div>
              <div className="relative">
                <Input
                  placeholder="English description (optional)"
                  value={newDescUk}
                  onChange={(e) => setNewDescUk(e.target.value)}
                  className="text-[11px] h-8 pr-8"
                  data-testid={`input-needs-new-lot-desc-uk-${devisId}`}
                />
                <button
                  type="button"
                  onClick={handleSuggest}
                  disabled={suggesting || newDesc.trim().length === 0}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Suggest English translation"
                  data-testid={`button-suggest-needs-new-lot-uk-${devisId}`}
                >
                  {suggesting ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  disabled={!newCode.trim() || !newDesc.trim() || createMutation.isPending || assignMutation.isPending}
                  onClick={() => createMutation.mutate({ code: newCode.trim(), descriptionFr: newDesc.trim(), descriptionUk: newDescUk.trim() || null })}
                  data-testid={`button-save-needs-new-lot-${devisId}`}
                >
                  <span className="text-[9px] font-bold uppercase tracking-widest">
                    {createMutation.isPending || assignMutation.isPending ? "Saving..." : "Save & Assign"}
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  onClick={() => { setAddingNew(false); setNewCode(""); setNewDesc(""); setNewDescUk(""); }}
                  data-testid={`button-cancel-needs-new-lot-${devisId}`}
                >
                  <span className="text-[9px] font-bold uppercase tracking-widest">Cancel</span>
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfidenceIndicator({ score }: { score: number }) {
  const color = score > 80 ? "text-emerald-600" : score >= 50 ? "text-amber-500" : "text-rose-500";
  const bgColor = score > 80 ? "bg-emerald-50 dark:bg-emerald-950/40" : score >= 50 ? "bg-amber-50 dark:bg-amber-950/40" : "bg-rose-50 dark:bg-rose-950/40";
  const borderColor = score > 80 ? "border-emerald-200 dark:border-emerald-800" : score >= 50 ? "border-amber-200 dark:border-amber-800" : "border-rose-200 dark:border-rose-800";
  const Icon = score > 80 ? ShieldCheck : score >= 50 ? ShieldAlert : ShieldX;
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border ${bgColor} ${borderColor}`} data-testid="indicator-ai-confidence">
      <Icon size={14} className={color} />
      <span className={`text-[11px] font-bold ${color}`}>{score}%</span>
      <span className="text-[9px] text-muted-foreground">AI Confidence</span>
    </div>
  );
}

function DraftReviewPanel({ data, projectId, contractors, onClose, isArchived = false }: DraftReviewPanelProps) {
  const { toast } = useToast();
  const { devisId, extraction, validation, devis } = data;
  const initialContractorId: number = devis.contractorId ?? extraction?.contractorId ?? 0;
  const [draftContractorId, setDraftContractorId] = useState<number>(initialContractorId);
  const contractorSectionRef = useRef<HTMLDivElement>(null);
  const { lotRefWarnings, contractorAdvisories, generic: warnings } =
    partitionDraftWarnings(validation?.warnings as DraftValidationWarning[] | undefined);

  const handleChooseContractor = () => {
    focusContractorSelect(contractorSectionRef.current);
  };
  const confidenceScore: number = validation?.confidenceScore ?? 50;

  const [editValues, setEditValues] = useState({
    amountHt: devis.amountHt ?? "",
    amountTtc: devis.amountTtc ?? "",
    devisCode: devis.devisCode ?? "",
    devisNumber: devis.devisNumber ?? "",
    descriptionFr: devis.descriptionFr ?? "",
    dateSent: devis.dateSent ?? "",
  });

  const fieldWarnings = (field: string) => warnings.filter(w => w.field === field);

  const confirmMutation = useMutation({
    mutationFn: async (corrections: Record<string, any>) => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/confirm`, corrections);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      toast({ title: "Devis confirmed", description: "Draft has been confirmed and is now pending" });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Confirmation failed", description: error.message, variant: "destructive" });
    },
  });

  const discardMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/devis/${devisId}`, { status: "void", voidReason: "Discarded draft — AI extraction rejected by user" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      toast({ title: "Draft discarded", description: "The draft devis has been voided" });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Discard failed", description: error.message, variant: "destructive" });
    },
  });

  const handleConfirm = async () => {
    const corrections: Record<string, any> = {};
    if (editValues.amountHt !== (devis.amountHt ?? "")) corrections.amountHt = editValues.amountHt;
    if (editValues.amountTtc !== (devis.amountTtc ?? "")) corrections.amountTtc = editValues.amountTtc;
    if (editValues.devisCode !== (devis.devisCode ?? "")) corrections.devisCode = editValues.devisCode;
    if (editValues.devisNumber !== (devis.devisNumber ?? "")) corrections.devisNumber = editValues.devisNumber;
    if (editValues.descriptionFr !== (devis.descriptionFr ?? "")) corrections.descriptionFr = editValues.descriptionFr;
    if (editValues.dateSent !== (devis.dateSent ?? "")) corrections.dateSent = editValues.dateSent;

    if (draftContractorId && draftContractorId !== initialContractorId) {
      try {
        await apiRequest("PATCH", `/api/devis/${devisId}`, { contractorId: draftContractorId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast({ title: "Could not update contractor", description: message, variant: "destructive" });
        return;
      }
    }

    confirmMutation.mutate(corrections);
  };

  const updateField = (field: string, value: string) => {
    setEditValues(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !confirmMutation.isPending && !discardMutation.isPending) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-draft-review">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-black uppercase tracking-tight flex items-center gap-3 flex-wrap">
            Review AI Extraction
            <ConfidenceIndicator score={confidenceScore} />
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            Verify AI-extracted values before confirming. Edit any incorrect fields.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {lotRefWarnings.length > 0 && (
            <LotReferenceWarningBanner
              warnings={lotRefWarnings}
              projectId={projectId}
              devisId={devisId}
              isArchived={isArchived}
            />
          )}
          <ContractorAdvisoryBanner
            warnings={contractorAdvisories}
            devisId={devisId}
            isArchived={isArchived}
            onChooseContractor={handleChooseContractor}
          />
          <GenericValidationWarningsList warnings={warnings} />

          <div className="space-y-1.5">
            <TechnicalLabel>Persisted Advisories</TechnicalLabel>
            <AdvisoriesList subject={{ type: "devis", id: devisId }} />
          </div>

          <div className="space-y-1.5" ref={contractorSectionRef}>
            <TechnicalLabel>Contractor</TechnicalLabel>
            <ContractorSelect
              contractors={contractors}
              value={draftContractorId}
              onChange={setDraftContractorId}
              disabled={isArchived}
              testId="select-draft-contractor"
              className="text-[11px]"
            />
            {draftContractorId !== initialContractorId && (
              <p className="text-[10px] text-amber-700" data-testid="text-draft-contractor-changed">
                Contractor will be reassigned when you confirm.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <TechnicalLabel>Devis Code</TechnicalLabel>
                {fieldWarnings("devisCode").map((w, i) => (
                  <Badge key={i} variant="outline" className={`text-[8px] ${w.severity === "error" ? "border-rose-300 text-rose-600" : "border-amber-300 text-amber-600"}`}>
                    {w.severity}
                  </Badge>
                ))}
              </div>
              <Input
                value={editValues.devisCode}
                onChange={(e) => updateField("devisCode", e.target.value)}
                className="text-[11px]"
                data-testid="input-draft-devis-code"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <TechnicalLabel>Devis Number</TechnicalLabel>
                {fieldWarnings("devisNumber").map((w, i) => (
                  <Badge key={i} variant="outline" className={`text-[8px] ${w.severity === "error" ? "border-rose-300 text-rose-600" : "border-amber-300 text-amber-600"}`}>
                    {w.severity}
                  </Badge>
                ))}
              </div>
              <Input
                value={editValues.devisNumber}
                onChange={(e) => updateField("devisNumber", e.target.value)}
                className="text-[11px]"
                data-testid="input-draft-devis-number"
              />
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <TechnicalLabel>Description</TechnicalLabel>
              {fieldWarnings("descriptionFr").map((w, i) => (
                <Badge key={i} variant="outline" className={`text-[8px] ${w.severity === "error" ? "border-rose-300 text-rose-600" : "border-amber-300 text-amber-600"}`}>
                  {w.severity}
                </Badge>
              ))}
            </div>
            <Textarea
              value={editValues.descriptionFr}
              onChange={(e) => updateField("descriptionFr", e.target.value)}
              className="text-[11px] resize-none"
              rows={2}
              data-testid="input-draft-description"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <TechnicalLabel>Amount HT</TechnicalLabel>
                {fieldWarnings("amountHt").map((w, i) => (
                  <Badge key={i} variant="outline" className={`text-[8px] ${w.severity === "error" ? "border-rose-300 text-rose-600" : "border-amber-300 text-amber-600"}`}>
                    {w.severity}
                  </Badge>
                ))}
              </div>
              <Input
                type="number"
                step="0.01"
                value={editValues.amountHt}
                onChange={(e) => updateField("amountHt", e.target.value)}
                className="text-[11px]"
                data-testid="input-draft-amount-ht"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <TechnicalLabel>Amount TTC</TechnicalLabel>
                {fieldWarnings("amountTtc").map((w, i) => (
                  <Badge key={i} variant="outline" className={`text-[8px] ${w.severity === "error" ? "border-rose-300 text-rose-600" : "border-amber-300 text-amber-600"}`}>
                    {w.severity}
                  </Badge>
                ))}
              </div>
              <Input
                type="number"
                step="0.01"
                value={editValues.amountTtc}
                onChange={(e) => updateField("amountTtc", e.target.value)}
                className="text-[11px]"
                data-testid="input-draft-amount-ttc"
              />
            </div>
          </div>

          <TvaDerivedHint
            amountHt={editValues.amountHt}
            amountTtc={editValues.amountTtc}
            testId="text-draft-tva-derived"
          />

          <div className="space-y-1">
            <TechnicalLabel>Date</TechnicalLabel>
            <Input
              type="date"
              value={editValues.dateSent}
              onChange={(e) => updateField("dateSent", e.target.value)}
              className="text-[11px]"
              data-testid="input-draft-date"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 border-rose-200 text-rose-600"
            onClick={() => discardMutation.mutate()}
            disabled={discardMutation.isPending || confirmMutation.isPending || isArchived}
            data-testid="button-discard-draft"
          >
            <Trash2 size={12} />
            <span className="text-[9px] font-bold uppercase tracking-widest">
              {discardMutation.isPending ? "Discarding..." : "Discard"}
            </span>
          </Button>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={confirmMutation.isPending || discardMutation.isPending}
              data-testid="button-cancel-draft-review"
            >
              <span className="text-[9px] font-bold uppercase tracking-widest">Review Later</span>
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={confirmMutation.isPending || discardMutation.isPending || isArchived}
              data-testid="button-confirm-draft"
            >
              <Check size={12} />
              <span className="text-[9px] font-bold uppercase tracking-widest">
                {confirmMutation.isPending ? "Confirming..." : "Confirm"}
              </span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const CHECK_COLORS: Record<string, { bg: string; border: string; ring: string }> = {
  green: { bg: "bg-emerald-500", border: "border-l-emerald-500", ring: "ring-emerald-300" },
  amber: { bg: "bg-amber-400", border: "border-l-amber-400", ring: "ring-amber-200" },
  red: { bg: "bg-rose-500", border: "border-l-rose-500", ring: "ring-rose-300" },
  unchecked: { bg: "", border: "border-l-transparent", ring: "" },
};

function LineItemWithCheck({ li, onUpdate, disabled = false }: { li: DevisLineItem; onUpdate: (data: Record<string, string>) => Promise<unknown> | unknown; disabled?: boolean }) {
  const { toast } = useToast();
  const status = li.checkStatus || "unchecked";
  const notes = li.checkNotes || "";
  const colors = CHECK_COLORS[status] || CHECK_COLORS.unchecked;
  const [notesOpen, setNotesOpen] = useState(!!notes);
  const [editingDesc, setEditingDesc] = useState(false);
  const [draftDesc, setDraftDesc] = useState(li.description);
  const [savingDesc, setSavingDesc] = useState(false);

  const fireUpdate = (data: Record<string, string>) => {
    void Promise.resolve(onUpdate(data)).catch(() => {});
  };

  const toggleStatus = (newStatus: string) => {
    if (disabled) return;
    fireUpdate({ checkStatus: status === newStatus ? "unchecked" : newStatus });
  };

  const enterDescEdit = () => {
    if (disabled || savingDesc) return;
    setDraftDesc(li.description);
    setEditingDesc(true);
  };

  const cancelDescEdit = () => {
    setDraftDesc(li.description);
    setEditingDesc(false);
  };

  const saveDescEdit = async () => {
    if (savingDesc) return;
    const next = draftDesc.trim();
    if (!next) {
      cancelDescEdit();
      return;
    }
    if (next === li.description) {
      setEditingDesc(false);
      return;
    }
    setSavingDesc(true);
    try {
      await Promise.resolve(onUpdate({ description: next }));
      toast({ title: "Description updated" });
      setEditingDesc(false);
    } catch (err) {
      setDraftDesc(li.description);
      setEditingDesc(false);
      toast({
        title: "Couldn't update description",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingDesc(false);
    }
  };

  return (
    <>
      <tr className={`border-l-[3px] ${colors.border} ${savingDesc ? "opacity-60" : ""}`}>
        <td className="py-1.5 px-2 text-[11px] align-top">{li.lineNumber}</td>
        <td className="py-1.5 px-2 text-[11px] align-top">
          {editingDesc ? (
            <div className="flex flex-col gap-1">
              <Textarea
                autoFocus
                value={draftDesc}
                onChange={(e) => setDraftDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelDescEdit();
                  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    saveDescEdit();
                  }
                }}
                onBlur={() => { if (editingDesc) saveDescEdit(); }}
                rows={2}
                className="text-[11px] min-h-[44px] py-1.5"
                disabled={savingDesc}
                data-testid={`textarea-line-description-${li.id}`}
              />
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={saveDescEdit}
                  disabled={savingDesc}
                  data-testid={`button-save-line-description-${li.id}`}
                >
                  {savingDesc ? <Loader2 size={10} className="animate-spin" /> : "Save"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={cancelDescEdit}
                  disabled={savingDesc}
                  data-testid={`button-cancel-line-description-${li.id}`}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div
              role={disabled ? undefined : "button"}
              tabIndex={disabled ? -1 : 0}
              onClick={enterDescEdit}
              onKeyDown={(e) => {
                if (disabled) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  enterDescEdit();
                }
              }}
              className={`whitespace-pre-wrap rounded px-1 -mx-1 outline-none ${disabled ? "" : "cursor-text hover:bg-[#c1a27b]/10 focus:ring-2 focus:ring-[#c1a27b]/40"}`}
              title={disabled ? undefined : "Click to edit"}
              data-testid={`cell-line-description-${li.id}`}
            >
              {li.description}
            </div>
          )}
        </td>
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
              onBlur={(e) => { if (!disabled) fireUpdate({ percentComplete: e.target.value }); }}
              disabled={disabled}
              data-testid={`input-line-progress-${li.id}`}
            />
            <div className="flex items-center gap-0.5 ml-1">
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "green" ? "bg-emerald-500 border-emerald-600 ring-2 ring-emerald-300" : "border-emerald-400 hover:bg-emerald-50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => toggleStatus("green")}
                disabled={disabled}
                title="Approved"
                data-testid={`button-check-green-${li.id}`}
              >
                {status === "green" && <Check size={12} className="text-white" />}
              </button>
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "amber" ? "bg-amber-400 border-amber-500 ring-2 ring-amber-200" : "border-amber-400 hover:bg-amber-50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => toggleStatus("amber")}
                disabled={disabled}
                title="Questioned"
                data-testid={`button-check-amber-${li.id}`}
              >
                {status === "amber" && <span className="text-white text-[10px] font-bold">?</span>}
              </button>
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "red" ? "bg-rose-500 border-rose-600 ring-2 ring-rose-300" : "border-rose-400 hover:bg-rose-50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => toggleStatus("red")}
                disabled={disabled}
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
              className="w-full h-7 px-3 text-[11px] rounded-lg border-2 outline-none transition-colors bg-white disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ borderColor: "#c1a27b" }}
              placeholder="Notes"
              defaultValue={notes}
              onBlur={(e) => {
                if (disabled) return;
                if (e.target.value !== notes) {
                  fireUpdate({ checkNotes: e.target.value });
                }
              }}
              disabled={disabled}
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

function DevisDetailInline({ devis, projectId, contractors, lots, isArchived = false }: { devis: Devis; projectId: string; contractors: Contractor[]; lots: Lot[]; isArchived?: boolean }) {
  const { toast } = useToast();
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [avenantDialogOpen, setAvenantDialogOpen] = useState(false);
  const [lineItemDialogOpen, setLineItemDialogOpen] = useState(false);
  const [addingNewLot, setAddingNewLot] = useState(false);
  const [newLotNumber, setNewLotNumber] = useState("");
  const [newLotDescription, setNewLotDescription] = useState("");
  const [newLotDescriptionUk, setNewLotDescriptionUk] = useState("");
  const [suggestingLotUk, setSuggestingLotUk] = useState(false);
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
  const { data: translationLineItems } = useQuery<DevisLineItem[]>({
    queryKey: ["/api/devis", devis.id, "line-items"],
  });

  const originalHt = parseFloat(devis.amountHt);
  const originalTtc = parseFloat(devis.amountTtc);
  const approvedAvenants = (avenants ?? []).filter((a) => a.status === "approved");
  const pvTotal = approvedAvenants.filter((a) => a.type === "pv").reduce((s, a) => s + parseFloat(a.amountHt), 0);
  const mvTotal = approvedAvenants.filter((a) => a.type === "mv").reduce((s, a) => s + parseFloat(a.amountHt), 0);
  const pvTotalTtc = approvedAvenants.filter((a) => a.type === "pv").reduce((s, a) => s + parseFloat(a.amountTtc), 0);
  const mvTotalTtc = approvedAvenants.filter((a) => a.type === "mv").reduce((s, a) => s + parseFloat(a.amountTtc), 0);
  const adjustedHt = originalHt + pvTotal - mvTotal;
  const adjustedTtc = originalTtc + pvTotalTtc - mvTotalTtc;
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

  const { data: lotCatalog = [] } = useQuery<LotCatalog[]>({
    queryKey: ["/api/lot-catalog"],
  });

  const assignFromCatalogMutation = useMutation({
    mutationFn: async (catalogCode: string) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/lots/assign-from-catalog`, {
        catalogCode,
        devisId: devis.id,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "lots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      toast({ title: "Lot assigned" });
    },
    onError: (error: Error) => {
      toast({ title: "Error assigning lot", description: error.message, variant: "destructive" });
    },
  });

  const createCatalogLotMutation = useMutation({
    mutationFn: async (data: { code: string; descriptionFr: string; descriptionUk?: string | null }) => {
      const res = await apiRequest("POST", `/api/lot-catalog`, data);
      return res.json();
    },
    onSuccess: (newEntry: LotCatalog) => {
      queryClient.invalidateQueries({ queryKey: ["/api/lot-catalog"] });
      assignFromCatalogMutation.mutate(newEntry.code);
      setAddingNewLot(false);
      setNewLotNumber("");
      setNewLotDescription("");
      setNewLotDescriptionUk("");
      toast({ title: "Lot added to master list and assigned" });
    },
    onError: (error: Error) => {
      toast({ title: "Error creating lot", description: error.message, variant: "destructive" });
    },
  });

  const suggestLotUkMutation = useMutation({
    mutationFn: async (data: { descriptionFr: string; code?: string }) => {
      const res = await apiRequest("POST", "/api/lot-catalog/translate", data);
      return (await res.json()) as { translation: string };
    },
    onError: (error: Error) => {
      toast({ title: "Could not suggest translation", description: error.message, variant: "destructive" });
    },
  });

  const handleSuggestNewLotUk = async () => {
    const fr = newLotDescription.trim();
    if (!fr) return;
    setSuggestingLotUk(true);
    try {
      const result = await suggestLotUkMutation.mutateAsync({ descriptionFr: fr, code: newLotNumber.trim() || undefined });
      if (result?.translation) setNewLotDescriptionUk(result.translation);
    } catch {
      // handled in onError
    } finally {
      setSuggestingLotUk(false);
    }
  };

  const currentLot = devis.lotId ? lots.find(l => l.id === devis.lotId) : undefined;
  const currentCatalogCode = currentLot?.lotNumber ?? "";

  const [voidDialogOpen, setVoidDialogOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");

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
      {!isVoid && (() => {
        const lotRefWarnings = ((devis.validationWarnings as any[]) || []).filter(
          (w: any) => w?.field === "lotReferences",
        );
        if (lotRefWarnings.length === 0) return null;
        return (
          <LotReferenceWarningBanner
            warnings={lotRefWarnings}
            projectId={projectId}
            devisId={devis.id}
            isArchived={isArchived}
          />
        );
      })()}
      <div className="space-y-1.5" data-testid={`section-advisories-${devis.id}`}>
        <TechnicalLabel>Extraction Advisories</TechnicalLabel>
        <AdvisoriesList subject={{ type: "devis", id: devis.id }} />
      </div>
      <DevisRefEditsHistory devisId={devis.id} projectId={projectId} />
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
            disabled={isArchived}
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
                    value={currentCatalogCode}
                    onValueChange={(val) => {
                      if (val === "__new__") {
                        setAddingNewLot(true);
                      } else {
                        assignFromCatalogMutation.mutate(val);
                      }
                    }}
                    disabled={isArchived || assignFromCatalogMutation.isPending}
                  >
                    <SelectTrigger className="flex-1" data-testid={`select-lot-${devis.id}`}>
                      <SelectValue placeholder="Select a lot..." />
                    </SelectTrigger>
                    <SelectContent>
                      {lotCatalog.map((entry) => (
                        <SelectItem key={entry.id} value={entry.code} data-testid={`option-lot-${entry.code}`}>
                          {entry.code} — {formatLotDescription(entry)}
                        </SelectItem>
                      ))}
                      <SelectItem value="__new__">+ Add new lot</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-2 p-2 rounded-lg border border-[rgba(0,0,0,0.08)] bg-white/50">
                  <p className="text-[9px] text-muted-foreground">Adds to the master list — available across all projects.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="Code (e.g. LOT3)"
                      value={newLotNumber}
                      onChange={(e) => setNewLotNumber(e.target.value)}
                      className="text-[11px]"
                      data-testid={`input-new-lot-number-${devis.id}`}
                    />
                    <Input
                      placeholder="French description"
                      value={newLotDescription}
                      onChange={(e) => setNewLotDescription(e.target.value)}
                      className="text-[11px]"
                      data-testid={`input-new-lot-desc-${devis.id}`}
                    />
                  </div>
                  <div className="relative">
                    <Input
                      placeholder="English description (optional)"
                      value={newLotDescriptionUk}
                      onChange={(e) => setNewLotDescriptionUk(e.target.value)}
                      className="text-[11px] pr-8"
                      data-testid={`input-new-lot-desc-uk-${devis.id}`}
                    />
                    <button
                      type="button"
                      onClick={handleSuggestNewLotUk}
                      disabled={suggestingLotUk || newLotDescription.trim().length === 0 || isArchived}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Suggest English translation"
                      data-testid={`button-suggest-new-lot-uk-${devis.id}`}
                    >
                      {suggestingLotUk ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!newLotNumber.trim() || !newLotDescription.trim() || createCatalogLotMutation.isPending || assignFromCatalogMutation.isPending || isArchived}
                      onClick={() => createCatalogLotMutation.mutate({ code: newLotNumber.trim(), descriptionFr: newLotDescription.trim(), descriptionUk: newLotDescriptionUk.trim() || null })}
                      data-testid={`button-save-new-lot-${devis.id}`}
                    >
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {createCatalogLotMutation.isPending ? "Saving..." : "Save & Assign"}
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setAddingNewLot(false); setNewLotNumber(""); setNewLotDescription(""); setNewLotDescriptionUk(""); }}
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
                  disabled={isArchived}
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
                  if (!isVoid && !isArchived) {
                    if (signOffBlocked && idx > 0) {
                      toast({ title: "Sign-off blocked", description: "Lot assignment and English works description are required before advancing", variant: "destructive" });
                      return;
                    }
                    updateDevisMutation.mutate({ signOffStage: stage.key });
                    toast({ title: `Stage: ${stage.label}` });
                  }
                }}
                disabled={isVoid || isArchived || (signOffBlocked && idx > 0)}
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
            disabled={isArchived}
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
      <TvaDerivedHint
        amountHt={adjustedHt}
        amountTtc={adjustedTtc}
        testId={`text-devis-detail-tva-derived-${devis.id}`}
      />
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
            }} disabled={isArchived} data-testid={`button-add-line-${devis.id}`}>
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
                      onUpdate={(data) => updateLineItemMutation.mutateAsync({ id: li.id, ...data })}
                      disabled={isArchived}
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

      <DevisTranslationSection
        devisId={devis.id}
        devisCode={devis.devisCode}
        lineItems={translationLineItems ?? []}
      />

      <div className="flex items-center justify-between">
        <h4 className="text-[12px] font-black uppercase tracking-tight text-foreground">
          Avenants ({avenants?.length ?? 0})
        </h4>
        <Button variant="outline" size="sm" onClick={() => {
          avenantForm.reset({ devisId: devis.id, avenantNumber: "", type: "pv", descriptionFr: "", descriptionUk: null, amountHt: "0.00", amountTtc: "0.00", dateSigned: null, status: "draft", pvmvRef: null });
          setAvenantDialogOpen(true);
        }} disabled={isArchived} data-testid={`button-add-avenant-${devis.id}`}>
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
        <Button variant="outline" size="sm" onClick={() => setInvoiceDialogOpen(true)} disabled={isArchived} data-testid={`button-upload-invoice-${devis.id}`}>
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
                <Upload className="h-8 w-8 mx-auto mb-2 text-[#c1a27b]" />
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
                    <FormControl><Input {...field} type="number" step="0.01" data-testid="input-avenant-ht" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={avenantForm.control} name="amountTtc" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Amount TTC</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" data-testid="input-avenant-ttc" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <TvaDerivedHint
                amountHt={avenantForm.watch("amountHt")}
                amountTtc={avenantForm.watch("amountTtc")}
                testId="text-avenant-tva-derived"
              />
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
