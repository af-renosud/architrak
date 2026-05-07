/**
 * Task #175 — Design contract upload + review widget.
 *
 * Two responsibilities:
 *   1. Drag-and-drop / click-to-pick PDF, POST to /api/design-contracts/preview,
 *      then open the review modal pre-filled with the AI extraction.
 *   2. Bubble the validated, architect-confirmed payload up to the parent
 *      via `onConfirmed`. The parent (New Project dialog or project-detail
 *      card) decides what to do with it — the New Project dialog defers
 *      the actual POST until after `trackProject` succeeds; the
 *      project-detail card POSTs immediately.
 *
 * The PDF iframe in the modal is fed by /api/design-contracts/preview-pdf
 * (auth-scoped) so the architect can read the contract while editing the
 * extracted values.
 */
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Upload, FileText, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/queryClient";
import { DESIGN_CONTRACT_ERROR_CODES } from "@shared/design-contract-errors";
import {
  DESIGN_CONTRACT_TRIGGER_EVENTS,
  type DesignContractTriggerEvent,
} from "@shared/schema";

interface ExtractedMilestone {
  sequence: number;
  labelFr: string;
  labelEn: string | null;
  percentage: number;
  amountTtc: number;
  triggerEvent: DesignContractTriggerEvent;
}

interface ExtractedDesignContract {
  documentType: "design_contract" | "unknown";
  totalHt: number | null;
  totalTva: number | null;
  totalTtc: number | null;
  tvaRate: number | null;
  conceptionAmountHt: number | null;
  planningAmountHt: number | null;
  contractDate: string | null;
  contractReference: string | null;
  clientName: string | null;
  architectName: string | null;
  projectAddress: string | null;
  milestones: ExtractedMilestone[];
  confidence: Record<string, number>;
  warnings: string[];
}

interface PreviewResponse {
  stagingKey: string;
  originalFilename: string;
  extracted: ExtractedDesignContract;
}

export interface ConfirmedDesignContract {
  stagingKey: string;
  originalFilename: string;
  totalHt: number | null;
  totalTva: number | null;
  totalTtc: number;
  tvaRate: number | null;
  conceptionAmountHt: number | null;
  planningAmountHt: number | null;
  contractDate: string | null;
  contractReference: string | null;
  extractionConfidence: Record<string, number> | null;
  extractionWarnings: string[] | null;
  milestones: ExtractedMilestone[];
}

interface DesignContractUploadProps {
  /** Existing confirmed payload — surfaces a "ready to submit" badge. */
  confirmed: ConfirmedDesignContract | null;
  onConfirmed: (payload: ConfirmedDesignContract) => void;
  onCleared?: () => void;
  /** "create" surface (project doesn't exist yet) hides the per-PDF
   *  re-upload note; "replace" surface (project detail) shows it. */
  mode?: "create" | "replace";
}

const TRIGGER_LABELS: Record<DesignContractTriggerEvent, string> = {
  file_opened: "File opened",
  concept_signed: "Concept signed",
  permit_deposited: "Permit deposited",
  final_plans_signed: "Final plans signed",
  manual: "Manual tick",
};

function fmtEur(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);
}

export function DesignContractUpload({ confirmed, onConfirmed, onCleared, mode = "create" }: DesignContractUploadProps) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [draft, setDraft] = useState<ConfirmedDesignContract | null>(null);

  const previewMutation = useMutation({
    mutationFn: async (file: File): Promise<PreviewResponse> => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/design-contracts/preview", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      const text = await res.text();
      let data: unknown = text;
      try { data = JSON.parse(text); } catch { /* not json */ }
      if (!res.ok) {
        const message = (data && typeof data === "object" && "message" in data && typeof (data as { message: unknown }).message === "string")
          ? (data as { message: string }).message
          : `${res.status}: ${text}`;
        throw new ApiError(res.status, message, data);
      }
      return data as PreviewResponse;
    },
    onSuccess: (data) => {
      setPreview(data);
      setDraft({
        stagingKey: data.stagingKey,
        originalFilename: data.originalFilename,
        totalHt: data.extracted.totalHt,
        totalTva: data.extracted.totalTva,
        totalTtc: data.extracted.totalTtc ?? 0,
        tvaRate: data.extracted.tvaRate,
        conceptionAmountHt: data.extracted.conceptionAmountHt,
        planningAmountHt: data.extracted.planningAmountHt,
        contractDate: data.extracted.contractDate,
        contractReference: data.extracted.contractReference,
        extractionConfidence: data.extracted.confidence,
        extractionWarnings: data.extracted.warnings,
        milestones: data.extracted.milestones.map((m, i) => ({ ...m, sequence: i + 1 })),
      });
      setReviewOpen(true);
    },
    onError: (err: Error) => {
      const code = err instanceof ApiError ? err.code : undefined;
      let title = "Upload failed";
      if (code === DESIGN_CONTRACT_ERROR_CODES.NOT_A_DESIGN_CONTRACT) title = "Not a design contract";
      else if (code === DESIGN_CONTRACT_ERROR_CODES.AI_TRANSIENT) title = "AI temporarily unavailable";
      else if (code === DESIGN_CONTRACT_ERROR_CODES.INVALID_PDF) title = "Invalid PDF";
      toast({ title, description: err.message, variant: "destructive" });
    },
  });

  function handleFile(file: File | null) {
    if (!file) return;
    if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      toast({ title: "PDF required", description: "Please upload a PDF file.", variant: "destructive" });
      return;
    }
    previewMutation.mutate(file);
  }

  function updateDraft(patch: Partial<ConfirmedDesignContract>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }
  function updateMilestone(idx: number, patch: Partial<ExtractedMilestone>) {
    setDraft((d) => {
      if (!d) return d;
      const next = [...d.milestones];
      next[idx] = { ...next[idx], ...patch };
      return { ...d, milestones: next };
    });
  }
  function addMilestone() {
    setDraft((d) => {
      if (!d) return d;
      return {
        ...d,
        milestones: [
          ...d.milestones,
          {
            sequence: d.milestones.length + 1,
            labelFr: "",
            labelEn: null,
            percentage: 0,
            amountTtc: 0,
            triggerEvent: "manual",
          },
        ],
      };
    });
  }
  function removeMilestone(idx: number) {
    setDraft((d) => d ? { ...d, milestones: d.milestones.filter((_, i) => i !== idx).map((m, i) => ({ ...m, sequence: i + 1 })) } : d);
  }

  const pctSum = draft ? draft.milestones.reduce((a, m) => a + (Number(m.percentage) || 0), 0) : 0;
  const amtSum = draft ? draft.milestones.reduce((a, m) => a + (Number(m.amountTtc) || 0), 0) : 0;
  const totalsValid = draft
    ? Math.abs(pctSum - 100) < 0.05 && Math.abs(amtSum - draft.totalTtc) < 0.05 && draft.totalTtc > 0 && draft.milestones.length > 0
    : false;

  function handleConfirm() {
    if (!draft || !totalsValid) return;
    onConfirmed(draft);
    setReviewOpen(false);
    toast({ title: "Design contract ready", description: "The contract is staged and will be saved with the project." });
  }

  return (
    <div className="space-y-3">
      <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
        Design Contract (PDF) <span className="text-destructive">*</span>
      </Label>
      {confirmed ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 space-y-2" data-testid="design-contract-confirmed">
          <div className="flex items-start gap-2">
            <CheckCircle2 size={16} className="text-emerald-600 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-emerald-900 truncate" data-testid="text-confirmed-filename">{confirmed.originalFilename}</div>
              <div className="text-[10px] text-emerald-700">
                {fmtEur(confirmed.totalTtc)} TTC · {confirmed.milestones.length} milestone{confirmed.milestones.length === 1 ? "" : "s"}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setReviewOpen(true); setDraft(confirmed); }}
              data-testid="button-edit-design-contract"
              className="h-7 text-[10px]"
            >Edit</Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { onCleared?.(); inputRef.current && (inputRef.current.value = ""); }}
              data-testid="button-clear-design-contract"
              className="h-7 text-[10px]"
            ><X size={12} /></Button>
          </div>
        </div>
      ) : (
        <div
          className="rounded-md border-2 border-dashed border-border p-4 text-center hover:border-[#0B2545] transition-colors cursor-pointer"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0] ?? null); }}
          data-testid="dropzone-design-contract"
        >
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            data-testid="input-design-contract-file"
          />
          {previewMutation.isPending ? (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              Extracting contract details with AI…
            </div>
          ) : (
            <div className="space-y-1">
              <Upload size={20} className="mx-auto text-muted-foreground" />
              <div className="text-xs font-medium">Drop the signed design contract PDF here</div>
              <div className="text-[10px] text-muted-foreground">or click to choose a file</div>
              {mode === "replace" && (
                <div className="text-[10px] text-amber-700 mt-2">Re-uploading replaces the existing contract.</div>
              )}
            </div>
          )}
        </div>
      )}

      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-6xl max-h-[92vh] overflow-hidden flex flex-col" data-testid="dialog-design-contract-review">
          <DialogHeader>
            <DialogTitle>Review design contract extraction</DialogTitle>
            <DialogDescription>
              Verify the AI-extracted totals and payment milestones against the PDF on the left. The schedule must sum to 100% and to the contract total TTC.
            </DialogDescription>
          </DialogHeader>
          {draft && preview && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 overflow-hidden">
              <div className="border border-border rounded-md overflow-hidden bg-muted">
                <iframe
                  src={`/api/design-contracts/preview-pdf?stagingKey=${encodeURIComponent(draft.stagingKey)}&filename=${encodeURIComponent(draft.originalFilename)}`}
                  className="w-full h-full min-h-[60vh]"
                  title="Design contract PDF"
                  data-testid="iframe-design-contract-pdf"
                />
              </div>
              <div className="overflow-y-auto pr-2 space-y-4">
                {draft.extractionWarnings && draft.extractionWarnings.length > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
                    <div className="font-semibold flex items-center gap-1"><AlertTriangle size={12} /> AI warnings</div>
                    <ul className="list-disc pl-4">
                      {draft.extractionWarnings.map((w, i) => (<li key={i}>{w}</li>))}
                    </ul>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-[10px]">Total HT</Label>
                    <Input type="number" step="0.01" value={draft.totalHt ?? ""} onChange={(e) => updateDraft({ totalHt: e.target.value === "" ? null : Number(e.target.value) })} data-testid="input-total-ht" />
                  </div>
                  <div>
                    <Label className="text-[10px]">Total TVA</Label>
                    <Input type="number" step="0.01" value={draft.totalTva ?? ""} onChange={(e) => updateDraft({ totalTva: e.target.value === "" ? null : Number(e.target.value) })} data-testid="input-total-tva" />
                  </div>
                  <div>
                    <Label className="text-[10px]">Total TTC <span className="text-destructive">*</span></Label>
                    <Input type="number" step="0.01" value={draft.totalTtc} onChange={(e) => updateDraft({ totalTtc: Number(e.target.value) || 0 })} data-testid="input-total-ttc" />
                  </div>
                  <div>
                    <Label className="text-[10px]">TVA Rate %</Label>
                    <Input type="number" step="0.01" value={draft.tvaRate ?? ""} onChange={(e) => updateDraft({ tvaRate: e.target.value === "" ? null : Number(e.target.value) })} data-testid="input-tva-rate" />
                  </div>
                  <div>
                    <Label className="text-[10px]">Conception HT</Label>
                    <Input type="number" step="0.01" value={draft.conceptionAmountHt ?? ""} onChange={(e) => updateDraft({ conceptionAmountHt: e.target.value === "" ? null : Number(e.target.value) })} data-testid="input-conception-ht" />
                  </div>
                  <div>
                    <Label className="text-[10px]">Planning HT</Label>
                    <Input type="number" step="0.01" value={draft.planningAmountHt ?? ""} onChange={(e) => updateDraft({ planningAmountHt: e.target.value === "" ? null : Number(e.target.value) })} data-testid="input-planning-ht" />
                  </div>
                  <div>
                    <Label className="text-[10px]">Contract Date</Label>
                    <Input type="date" value={draft.contractDate ?? ""} onChange={(e) => updateDraft({ contractDate: e.target.value || null })} data-testid="input-contract-date" />
                  </div>
                  <div>
                    <Label className="text-[10px]">Reference</Label>
                    <Input value={draft.contractReference ?? ""} onChange={(e) => updateDraft({ contractReference: e.target.value || null })} data-testid="input-contract-reference" />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold">Payment milestones</div>
                    <Button size="sm" variant="outline" onClick={addMilestone} data-testid="button-add-milestone" className="h-7 text-[10px]">+ Add</Button>
                  </div>
                  <div className="space-y-2">
                    {draft.milestones.map((m, idx) => (
                      <div key={idx} className="grid grid-cols-12 gap-1 items-end p-2 rounded border border-border bg-card" data-testid={`row-milestone-${idx}`}>
                        <div className="col-span-4">
                          <Label className="text-[9px]">Label (FR)</Label>
                          <Input value={m.labelFr} onChange={(e) => updateMilestone(idx, { labelFr: e.target.value })} data-testid={`input-label-fr-${idx}`} />
                        </div>
                        <div className="col-span-2">
                          <Label className="text-[9px]">%</Label>
                          <Input type="number" step="0.01" value={m.percentage} onChange={(e) => updateMilestone(idx, { percentage: Number(e.target.value) || 0 })} data-testid={`input-percentage-${idx}`} />
                        </div>
                        <div className="col-span-2">
                          <Label className="text-[9px]">€ TTC</Label>
                          <Input type="number" step="0.01" value={m.amountTtc} onChange={(e) => updateMilestone(idx, { amountTtc: Number(e.target.value) || 0 })} data-testid={`input-amount-${idx}`} />
                        </div>
                        <div className="col-span-3">
                          <Label className="text-[9px]">Trigger</Label>
                          <Select value={m.triggerEvent} onValueChange={(v) => updateMilestone(idx, { triggerEvent: v as DesignContractTriggerEvent })}>
                            <SelectTrigger data-testid={`select-trigger-${idx}`}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {DESIGN_CONTRACT_TRIGGER_EVENTS.map((t) => (
                                <SelectItem key={t} value={t}>{TRIGGER_LABELS[t]}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="col-span-1">
                          <Button variant="ghost" size="sm" onClick={() => removeMilestone(idx)} data-testid={`button-remove-milestone-${idx}`} className="h-9 px-2"><X size={12} /></Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className={`text-[10px] flex items-center justify-between p-2 rounded ${totalsValid ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`} data-testid="text-milestone-totals">
                    <span>Σ percentages: <strong>{pctSum.toFixed(2)}%</strong> / 100.00%</span>
                    <span>Σ amounts: <strong>{fmtEur(amtSum)}</strong> / {fmtEur(draft.totalTtc)}</span>
                  </div>
                </div>
                <div className="flex gap-2 pt-2 border-t border-border sticky bottom-0 bg-background pb-1">
                  <Button variant="outline" onClick={() => setReviewOpen(false)} data-testid="button-cancel-review" className="flex-1">Cancel</Button>
                  <Button onClick={handleConfirm} disabled={!totalsValid} data-testid="button-confirm-design-contract" className="flex-1">
                    <FileText size={14} className="mr-1" /> Confirm
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
