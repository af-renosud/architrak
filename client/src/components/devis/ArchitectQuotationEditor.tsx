import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink, FileText, Languages, LockKeyhole, Pencil, Plus, Save, Scissors, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ApiError, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useArchitectCorrection } from "./use-architect-correction";
import { correctionCents, correctionMoney, correctionProduct, correctionFinancialIssues, createCorrectionLine, financialProjection, previewCorrectionTotals, reorderCorrectionLine, transferCorrectionPassage } from "./architect-correction-model";
import type { ArchitectCorrectionDraft, ArchitectCorrectionLine, ArchitectCorrectionSnapshot } from "./architect-correction-model";
import type { DevisLineContext } from "@shared/schema";
import { DevisLineContextEditor } from "./DevisLineContextEditor";
import { QuotationApprovalReview, type TranslationReadiness } from "./QuotationApprovalReview";
import { QuotationConflictReview } from "./QuotationConflictReview";
import { mergeQuotationDraft, type MergeChoices } from "./quotation-three-way";
import { quotationWorkBlocked, setQuotationWork, useQuotationWork } from "./quotation-review-state";
import { keepQuotationDraft, readQuotationDraft } from "./quotation-draft-backup";
import type { QuotationReviewTarget } from "./QuotationExceptions";
import { quotationFieldLabel } from "./quotation-review-labels";
import { SourceTotalHelp } from "./SourceTotalHelp";
import { needsSourceConfirmation, quotationEditorField, quotationTargetRowId } from "./quotation-review-target";
import type { QuotationIssue } from "@shared/quotation-decision";
import "./architect-correction.css";

interface Props { devisId: number; projectId: string; disabled?: boolean; compact?: boolean; hideTrigger?: boolean }
const euro = (decimal: string) => `${decimal.replace(".", ",")} €`;

function DraftField({ label, value, onChange, multiline = false, disabled = false, numeric = false, field }: {
  label: string; value: string; onChange: (value: string) => void; multiline?: boolean; disabled?: boolean; numeric?: boolean; field?: string;
}) {
  const id = useId();
  return <div className="min-w-0">
    <label htmlFor={id} className="correction-label">{label}</label>
    {multiline ? <Textarea id={id} data-quotation-field={field} value={value} onChange={event => onChange(event.target.value)}
      disabled={disabled} className="resize-y text-xs bg-background" />
      : <Input id={id} data-quotation-field={field} value={value} onChange={event => onChange(event.target.value)}
        disabled={disabled} inputMode={numeric ? "decimal" : undefined}
        className={`text-xs bg-background ${numeric ? "correction-number" : ""}`} />}
  </div>;
}

export function ArchitectQuotationEditor({ devisId, projectId, disabled = false, compact = false, hideTrigger = false }: Props) {
  const [open, setOpen] = useState(false);
  const [recoveringVat, setRecoveringVat] = useState(false);
  const [vatRecoveryMessage, setVatRecoveryMessage] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [draft, setDraft] = useState<ArchitectCorrectionDraft | null>(null);
  const [original, setOriginal] = useState<ArchitectCorrectionSnapshot | null>(null);
  const [selected, setSelected] = useState<string>("header");
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [baselineTtc, setBaselineTtc] = useState("");
  const [sourceTotalChoice, setSourceTotalChoice] = useState<"match" | "manual" | null>(null);
  const [baselinePage, setBaselinePage] = useState("");
  const [pdfConfirmed, setPdfConfirmed] = useState(false);
  const [target, setTarget] = useState("");
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);
  const [latest, setLatest] = useState<ArchitectCorrectionSnapshot | null>(null);
  const [mergeChoices, setMergeChoices] = useState<MergeChoices>({});
  const quotationWork = useQuotationWork(devisId);
  const ownUploadPending = quotationWork.issues.some(issue => issue.key.startsWith("image-request:workspace:"));
  const workKey = `working-draft:${devisId}`;
  const initialized = useRef(false);
  const requestedTarget = useRef<QuotationReviewTarget | null>(null);
  const [locateRequest, setLocateRequest] = useState(0);
  const [requestedField, setRequestedField] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<TranslationReadiness | null>(null);
  const [sourceConfirmationOpen, setSourceConfirmationOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourcePage, setSourcePage] = useState<number | null>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const submitLock = useRef(false);
  const mounted = useRef(true);
  const frenchInput = useRef<HTMLTextAreaElement>(null);
  const confirmId = useId();
  const targetId = useId();
  const { toast } = useToast();
  const { snapshot, save, baseline, suggest } = useArchitectCorrection(devisId, projectId, open);
  const pending = save.isPending || baseline.isPending || suggest.isPending || recoveringVat;
  const contexts = useQuery<{ contexts: DevisLineContext[] }>({
    queryKey: ["/api/devis", devisId, "line-contexts"], enabled: open,
    queryFn: async () => {
      const result = await (await apiRequest("GET", `/api/devis/${devisId}/line-contexts`)).json();
      if (!result || !Array.isArray(result.contexts)) throw new Error("Line context could not be loaded.");
      return result;
    }, retry: false,
  });
  useEffect(() => {
    const openWorkspace = (event: Event) => {
      const detail = (event as CustomEvent<number | QuotationReviewTarget>).detail;
      const target = typeof detail === "number" ? { devisId: detail } : detail;
      if (disabled || !target || target.devisId !== devisId) return;
      requestedTarget.current = target;
      if (quotationEditorField(target.field) === "sourceTtc") setSourceConfirmationOpen(true);
      if (target.page && Number.isSafeInteger(target.page) && target.page > 0) setSourcePage(target.page);
      setLocateRequest(value => value + 1);
      setOpen(true);
    };
    window.addEventListener("quotation-review-open", openWorkspace);
    return () => window.removeEventListener("quotation-review-open", openWorkspace);
  }, [devisId, disabled]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open || !snapshot.data || snapshot.isFetching || initialized.current) return;
    initialized.current = true;
    setBaselineTtc(""); setBaselinePage(""); setPdfConfirmed(false); setSourceTotalChoice(null);
    const backup = readQuotationDraft(devisId);
    const recovered = backup ? mergeQuotationDraft(backup.original.draft, backup.draft, snapshot.data.draft) : null;
    setOriginal(structuredClone(backup && recovered?.conflicts.length ? backup.original : snapshot.data));
    const loadedDraft = structuredClone(backup && recovered?.conflicts.length ? backup.draft : recovered?.draft ?? snapshot.data.draft);
    setDraft(loadedDraft);
    const requested = requestedTarget.current;
    const requestedRow = requested?.rowId == null ? undefined : loadedDraft.lines.find(line => line.id === requested.rowId);
    setSelected(requestedRow?.clientKey ?? "header");
    setRequestedField(quotationEditorField(requested?.field, requested?.rowId == null) ?? null);
    requestedTarget.current = null;
    setError(backup ? "Your unsaved working draft was restored in this tab. Review it before saving." : null);
    setStale(!!recovered?.conflicts.length); setSavedMessage(false); setVatRecoveryMessage(null);
    setLatest(recovered?.conflicts.length ? snapshot.data : null); setMergeChoices({});
    if (requested?.rowId != null && !requestedRow) setError("The requested working row is no longer present. Review the current working quotation; no rows have been changed.");
  }, [open, snapshot.data, snapshot.isFetching, devisId]);
  useEffect(() => {
    if (!open || !draft || !initialized.current || !requestedTarget.current) return;
    const target = requestedTarget.current;
    requestedTarget.current = null;
    const row = target.rowId == null ? undefined : draft.lines.find(line => line.id === target.rowId);
    setSelected(row?.clientKey ?? "header");
    setRequestedField(quotationEditorField(target.field, target.rowId == null) ?? null);
    setSelection(null); setTarget("");
    if (target.rowId != null && !row) setError("The requested working row is no longer present. Review the current working quotation; no rows have been changed.");
  }, [open, draft, locateRequest]);
  useEffect(() => {
    if (!open || !draft || !requestedField) return;
    const timer = window.setTimeout(() => {
      const field = Array.from(workspace.current?.querySelectorAll<HTMLElement>("[data-quotation-field]") ?? [])
        .find(element => element.dataset.quotationField === requestedField && !element.closest("[hidden]"));
      field?.focus({ preventScroll: true });
      field?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, !!draft, selected, requestedField, locateRequest, sourceConfirmationOpen]);
  const financialIssues = useMemo(() => draft ? correctionFinancialIssues(draft) : [], [draft]);
  const totals = useMemo(() => {
    if (!draft) return { value: null, error: null };
    try { return { value: previewCorrectionTotals(draft), error: null }; }
    catch (cause) { return { value: null, error: cause instanceof Error ? cause.message : "Review financial values." }; }
  }, [draft]);
  let difference: string | null = null;
  if (totals.value && original?.baseline) {
    try { difference = correctionMoney(correctionCents(totals.value.ttc) - correctionCents(original.baseline.ttc)); }
    catch { /* The server validates source data; malformed baseline fails closed below. */ }
  }
  const financialAllowed = !disabled && !original?.financialBlockedReason && !original?.blockedReason;
  const headerReconciliation = !!(financialAllowed && totals.value && original?.workingTotals && difference === "0.00"
    && (totals.value.ht !== original.workingTotals.ht || totals.value.ttc !== original.workingTotals.ttc));
  const dirty = headerReconciliation || !!draft && !!original && JSON.stringify(draft) !== JSON.stringify(original.draft);
  useEffect(() => {
    if (original && draft) keepQuotationDraft(devisId, dirty || stale ? { original, draft } : null);
  }, [devisId, draft, original, dirty, stale]);
  useEffect(() => {
    setQuotationWork(devisId, workKey, dirty || pending || stale, pending ? "Working quotation is saving or updating." :
      stale ? "Compare concurrent changes before saving." : dirty ? "Working quotation has unsaved changes." : "");
  }, [devisId, workKey, dirty, pending, stale]);
  useEffect(() => {
    if (!open) return;
    const protect = (event: BeforeUnloadEvent) => {
      if (quotationWorkBlocked(devisId)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [open, devisId]);
  // Context saves also advance the working version. Rebase our local draft, never reset it.
  useEffect(() => {
    if (!initialized.current || !snapshot.data || !original || !draft || pending || snapshot.data.version === original.version) return;
    const result = mergeQuotationDraft(original.draft, draft, snapshot.data.draft);
    if (result.conflicts.length) {
      setLatest(snapshot.data); setMergeChoices({}); setStale(true);
    } else {
      setOriginal(snapshot.data); setDraft(result.draft); setStale(false); setLatest(null); setError(null);
    }
    // Snapshot identity alone triggers reconciliation; typing must not reset conflict choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.data]);
  const comparison = useMemo(() => latest && original && draft
    ? mergeQuotationDraft(original.draft, draft, latest.draft) : null, [latest, original, draft]);
  const financialDirty = headerReconciliation || !!draft && !!original && financialProjection(draft) !== financialProjection(original.draft);
  const editable = !pending && !disabled && !original?.blockedReason;
  const currentIndex = draft?.lines.findIndex(line => line.clientKey === selected) ?? -1;
  const current = draft && currentIndex >= 0 ? draft.lines[currentIndex] : null;
  const numericEditable = editable && financialAllowed;
  const sourceConfirmationRequired = !original?.baseline && (financialDirty || !!readiness?.blockers.some(issue =>
    needsSourceConfirmation(issue.code)));
  // Only the original stored extraction may supply this suggestion, never working totals.
  const extractedTtc = original?.extractedSourceTotal?.ttc;
  const sourceSuggestion = typeof extractedTtc === "string" && /^\d{1,10}(?:\.\d{1,2})?$/.test(extractedTtc) ? extractedTtc : null;
  const sourceTtcInput = (sourceTotalChoice === "match" ? sourceSuggestion ?? "" : baselineTtc).replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
  const proposedSourceTtc = sourceSuggestion && sourceTotalChoice !== "manual" ? sourceSuggestion : sourceTtcInput;
  let provisionalDifference: string | null = null;
  if (totals.value && /^\d+(?:\.\d{1,2})?$/.test(proposedSourceTtc)) {
    try { provisionalDifference = correctionMoney(correctionCents(totals.value.ttc) - correctionCents(proposedSourceTtc)); }
    catch { /* Invalid source input remains unconfirmed; no comparison is asserted. */ }
  }
  const sourceConfirmationHint = !sourceTtcInput ? "Enter the final VAT-inclusive total printed on the original PDF."
    : !/^\d+(?:\.\d{1,2})?$/.test(sourceTtcInput) ? "Use an amount such as 75059.00 or 75 059,00, with no more than two decimal places."
      : !/^[1-9]\d*$/.test(baselinePage) ? "Enter the PDF page number where that total is printed."
        : !pdfConfirmed ? "Tick the confirmation after comparing the amount with the original PDF."
          : `Ready to confirm ${sourceTtcInput.replace(".", ",")} € from PDF page ${baselinePage}.`;
  const locate = (key: string, target?: QuotationIssue["target"]) => {
    const rowId = quotationTargetRowId(key, target);
    const row = draft?.lines.find(line => rowId == null ? line.clientKey === key : line.id === rowId);
    setSelected(row?.clientKey ?? "header");
    const field = quotationEditorField(target?.field, !row);
    const isSource = target?.section === "source" || key === "source" || field === "sourceTtc";
    setRequestedField(field ?? (isSource && !original?.baseline ? "sourceTtc" : null));
    if (isSource) setSourceConfirmationOpen(true);
    if (target?.page && Number.isSafeInteger(target.page) && target.page > 0) setSourcePage(target.page);
    setSelection(null); setTarget(""); setLocateRequest(value => value + 1);
  };
  const validationMessage = financialDirty
    ? !original?.baseline ? "Confirm the original PDF total including VAT before saving financial changes."
      : totals.error ?? (difference === null ? "Source totals could not be read."
        : difference !== "0.00" ? "Working total including VAT must match the confirmed original PDF total before financial changes can be saved." : null)
    : null;
  const updateDraft = (change: Partial<ArchitectCorrectionDraft>) => {
    setDraft(previous => previous ? { ...previous, ...change } : previous);
    setSavedMessage(false);
  };
  const updateLine = (change: Partial<ArchitectCorrectionLine>) => {
    setDraft(previous => previous ? { ...previous, lines: previous.lines.map(line =>
      line.clientKey === selected ? { ...line, ...change } : line) } : previous);
    setSavedMessage(false);
  };
  const addLine = (kind: ArchitectCorrectionLine["kind"]) => {
    const line = createCorrectionLine(kind, `new-${crypto.randomUUID()}`);
    setDraft(previous => previous ? { ...previous, lines: [...previous.lines, line] } : previous);
    setSelected(line.clientKey); setSavedMessage(false); setSelection(null);
  };
  const dismiss = () => {
    if (submitLock.current || pending || ownUploadPending) {
      setError(ownUploadPending ? "An image is still uploading in this editor. Wait for it to finish before closing; your text is preserved." : "An editor update is still running. Please wait for it to finish before closing.");
      return;
    }
    if (dirty) setDiscardOpen(true);
    else { setOpen(false); initialized.current = false; }
  };
  const reportError = (cause: unknown) => {
    if (!mounted.current) return;
    setError(cause instanceof Error ? cause.message : "The correction could not be saved. Your draft is still here.");
    if (cause instanceof ApiError && cause.status === 409) {
      setStale(true);
      // Refresh the cached snapshot for a later reopen, never the active draft.
      void snapshot.refetch().then(result => {
        if (result.data) { setLatest(result.data); setMergeChoices({}); }
      });
    }
  };
  const saveDraft = async () => {
    if (!draft || !original || !editable || !dirty || validationMessage || submitLock.current || stale) return;
    submitLock.current = true;
    setError(null);
    const submitted = structuredClone(draft);
    try {
      const result = await save.mutateAsync({ ...submitted, expectedVersion: original.version });
      // A request can finish after route unmount. Do not recover an already-persisted new row as a duplicate.
      const backup = readQuotationDraft(devisId);
      if (backup?.original.version === original.version && JSON.stringify(backup.draft) === JSON.stringify(submitted)) {
        keepQuotationDraft(devisId, null);
        setQuotationWork(devisId, workKey, false);
      }
      if (!mounted.current) return;
      setOriginal(result); setDraft(structuredClone(result.draft)); setSavedMessage(true); setLatest(null);
      const selectedIndex = submitted.lines.findIndex(line => line.clientKey === selected);
      if (selectedIndex >= 0) {
        const submittedLine = submitted.lines[selectedIndex];
        const persistedLine = result.draft.lines.find(line => line.clientKey === selected ||
          submittedLine.id !== null && line.id === submittedLine.id) ?? result.draft.lines[selectedIndex];
        if (persistedLine) setSelected(persistedLine.clientKey);
      }
      toast({ title: "Architect correction saved", description: "Original PDF and source TTC are unchanged. Previous translation approval has been cleared." });
    } catch (cause) { reportError(cause); }
    finally { submitLock.current = false; }
  };
  const recoverVat = async () => {
    if (!original || !draft || pending || stale || financialDirty) return;
    setRecoveringVat(true); setError(null);
    try {
      const response = await apiRequest("POST", `/api/devis/${devisId}/architect-correction/source-vat`, { expectedVersion: original.version });
      const result = await response.json() as { expectedVersion: string; rates: Array<{ clientKey: string; vatRate: string }> };
      if (result.expectedVersion !== original.version) throw new Error("Quotation changed. No rates were applied.");
      updateDraft({ lines: draft.lines.map(line => ({ ...line,
        vatRate: line.vatRate || result.rates.find(rate => rate.clientKey === line.clientKey)?.vatRate || "",
      })) });
      setVatRecoveryMessage("Missing VAT rates recovered from the original PDF. Review the working TTC below, then Save correction. Your wording and context have not been changed.");
    } catch (cause) { reportError(cause); }
    finally { setRecoveringVat(false); }
  };
  const establishBaseline = async () => {
    if (!original || original.baseline || !pdfConfirmed || !sourceTtcInput || !/^[1-9]\d*$/.test(baselinePage)
      || submitLock.current || !editable || stale) return;
    let ttc: string;
    try {
      if (!/^\d+(?:\.\d{1,2})?$/.test(sourceTtcInput)) throw new Error("Transcribe the source TTC with no more than two decimal places.");
      const cents = correctionCents(sourceTtcInput);
      if (cents < BigInt(0)) throw new Error("Source TTC cannot be negative.");
      ttc = correctionMoney(cents);
    } catch (cause) { reportError(cause); return; }
    submitLock.current = true; setError(null);
    try {
      const result = await baseline.mutateAsync({ expectedVersion: original.version,
        ttc, page: Number(baselinePage), confirmedFromPdf: true });
      if (!mounted.current) return;
      // Establishing source evidence does not overwrite unsaved content.
      setOriginal(result);
      toast({ title: "Original PDF total confirmed", description: "Your working figures and unsaved wording have not been changed." });
    } catch (cause) { reportError(cause); }
    finally { submitLock.current = false; }
  };
  const transfer = (move: boolean) => {
    if (!draft || currentIndex < 0) return;
    const to = draft.lines.findIndex(line => line.clientKey === target);
    const range = selection && selection.end > selection.start ? selection : { start: 0, end: current!.descriptionFr.length };
    updateDraft({ lines: transferCorrectionPassage(draft.lines, currentIndex, to, range.start, range.end, move) });
    setSelection(null);
  };
  const splitContext = () => {
    if (!draft || !current || !selection || selection.end <= selection.start) return;
    const contextual = createCorrectionLine("context", `new-${crypto.randomUUID()}`);
    const lines = [...draft.lines];
    lines.splice(currentIndex + 1, 0, contextual);
    const next = transferCorrectionPassage(lines, currentIndex, currentIndex + 1, selection.start, selection.end, true);
    updateDraft({ lines: next }); setSelected(contextual.clientKey); setSelection(null);
  };
  const fillEnglish = async () => {
    if (!draft || !original || !editable || stale || submitLock.current) return;
    submitLock.current = true; setSuggestionError(null);
    try {
      const result = await suggest.mutateAsync({ ...structuredClone(draft), expectedVersion: original.version });
      if (!mounted.current) return;
      setDraft(previous => previous ? { ...previous,
        headerEn: previous.headerEn || result.suggestion.header.description || "",
        explanationEn: previous.explanationEn || result.suggestion.header.descriptionExplanation || "",
        summaryEn: previous.summaryEn || result.suggestion.header.summary || "",
        lines: previous.lines.map((line, index) => {
          const fresh = result.suggestion.lines.find(l => l.lineNumber === index + 1);
          return fresh ? { ...line, descriptionEn: line.descriptionEn || fresh.translation,
            explanationEn: line.explanationEn || fresh.explanation || "" } : line;
        }) } : previous);
      setSavedMessage(false);
      toast({ title: "English suggestions added to empty fields", description: "Existing manual English was preserved. Review this unsaved draft before saving." });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) reportError(cause);
      else setSuggestionError(cause instanceof Error ? cause.message : "Suggestions are unavailable.");
    } finally { submitLock.current = false; }
  };

  return <>
    <div hidden={hideTrigger} className={compact ? "architect-correction review-source-editor-trigger" : "architect-correction px-3 py-3"} data-testid={`architect-correction-entry-${devisId}`}>
      {error && <p role="alert" className="mb-2 text-xs text-destructive">{stale ? "Stale working quotation · your draft is preserved. " : "Working quotation · your draft is preserved. "}{error}</p>}
      {(dirty || pending) && <p data-workflow-attention className="mb-2 text-[11px] text-muted-foreground">{pending ? "Working quotation · save or update in progress. Keep this project open." : "Working quotation · unsaved correction draft."}</p>}
      <div className={compact ? "" : "correction-banner rounded-lg flex flex-wrap items-center justify-between gap-3 px-4 py-3"}>
        {!compact && <div className="flex items-start gap-3">
          <Pencil size={15} className="mt-0.5 shrink-0" />
          <div><p className="text-xs font-semibold">Architect’s working version</p>
            <p className="text-[11px] text-muted-foreground mt-1">Correct descriptions, translations and figures. The contractor’s original PDF remains the legal reference.</p>
          </div>
        </div>}
        <Button type="button" size="sm" variant="outline" onClick={() => { setDraft(null); setOriginal(null); initialized.current = false; setOpen(true); }} disabled={disabled}
          className="border-[#94734c]/40 bg-[#f8f5ef] text-[#0b2545] text-[11px] gap-2 shrink-0">
          <Pencil size={13} /> Edit working quotation
        </Button>
      </div>
    </div>
    <Dialog open={open} onOpenChange={next => { if (!next) dismiss(); }}>
      <DialogContent className="architect-correction max-w-[1540px] w-[calc(100vw-24px)] max-h-[94dvh] overflow-y-auto p-0 gap-0"
        onEscapeKeyDown={event => { if (dirty || pending) { event.preventDefault(); dismiss(); } }}
        onPointerDownOutside={event => { if (dirty || pending) { event.preventDefault(); dismiss(); } }}>
        <DialogHeader className="px-5 pt-6 pb-4 md:px-7 border-b border-[#d8cbb9]">
          <div className="flex items-center gap-2 text-[#94734c]"><ShieldCheck size={14} /><span className="text-[10px] uppercase tracking-[.15em] font-semibold">Review/edit → Save → Review and approve</span></div>
          <DialogTitle className="text-xl tracking-tight text-[#0b2545]">Review the interpretation. Keep the original.</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed max-w-[700px]">
            Compare the original with the working wording, figures and client context. Save only what you change, then approve the saved translation. Optional AI suggestions are not required.
          </DialogDescription>
          <a href={`/api/devis/${devisId}/pdf?variant=original`} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-xs underline underline-offset-4 w-fit">
            <FileText size={13} /> Open original contractor PDF <ExternalLink size={12} />
          </a>
          <Button type="button" variant="outline" size="sm" className="review-source-toggle w-fit"
            aria-expanded={sourceOpen} aria-controls={`working-source-${devisId}`}
            onClick={() => setSourceOpen(value => !value)}>{sourceOpen ? "Hide source PDF" : "Show source PDF alongside review"}</Button>
        </DialogHeader>
        {snapshot.isLoading && !draft ? <div className="p-6 space-y-4" aria-label="Loading quotation editor"><Skeleton className="h-20 w-full" /><Skeleton className="h-12 w-1/3" /><Skeleton className="h-64 w-full" /></div>
          : snapshot.isError && !draft ? <div className="p-7 space-y-3" role="alert"><p className="text-sm font-semibold">The working quotation could not be loaded.</p>
            <p className="text-xs text-muted-foreground">{snapshot.error.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void snapshot.refetch()}>Retry loading</Button></div>
          : draft && original ? <><div className="review-split" ref={workspace}>
            <aside id={`working-source-${devisId}`} className="review-pdf" data-source-open={sourceOpen}
              aria-label="Original contractor PDF alongside working quotation">
              <div className="review-pdf-heading"><strong>Original contractor PDF</strong>
                <a className="underline" href={`/api/devis/${devisId}/pdf?variant=original${sourcePage ? `#page=${sourcePage}` : ""}`}
                  target="_blank" rel="noopener noreferrer">Open PDF in new tab</a></div>
              <iframe title="Original contractor PDF" src={`/api/devis/${devisId}/pdf?variant=original${sourcePage ? `#page=${sourcePage}` : ""}`} />
            </aside>
            <div className="review-editing min-w-0">
            <div className="px-5 py-4 md:px-7 space-y-3">
              <QuotationApprovalReview devisId={devisId} disabled={disabled || pending || dirty || stale || snapshot.isFetching || contexts.isFetching || contexts.isError}
                onReadiness={setReadiness}
                onRefreshWorking={async () => {
                  const result = await snapshot.refetch();
                  if (result.isError) throw result.error;
                }}
                onCloseEditor={dismiss}
                onLocate={locate} />
              <p role="status" aria-live="polite" className="review-save-state">
                {stale ? "Conflict · your draft is preserved. Compare concurrent changes before saving." :
                  save.isPending ? "Saving your correction…" : baseline.isPending ? "Confirming source evidence…" :
                  error ? "Attention · your working draft is preserved. See the message below." :
                  dirty ? financialDirty ? "Unsaved figures and wording · financial changes must reconcile before saving." :
                    "Unsaved wording · can be saved without changing or confirming the source total." :
                    "Saved working quotation · no save is needed unless you make a change."}
              </p>
              {vatRecoveryMessage && <p role="status" className="rounded-md border p-3 text-sm">{vatRecoveryMessage}</p>}
              {(financialIssues.length > 0 || vatRecoveryMessage) && <section className="rounded-lg border border-amber-300 p-4 space-y-3" aria-label="Financial checks">
                <h3 className="font-semibold text-sm">{financialIssues.length ? `Financial checks — ${financialIssues.length} fields need attention` : "Recovered VAT — review before saving"}</h3>
                <p className="text-xs">Your wording and context can still be saved. Approval requires the actual VAT and amounts from the original PDF; no rates are assumed.</p>
                {financialIssues.length > 0 && <SourceTotalHelp kind="missing" />}
                <a className="text-xs underline" href={`/api/devis/${devisId}/pdf?variant=original`} target="_blank" rel="noreferrer">Open original PDF alongside this editor</a>
                {original.baseline && <div><Button type="button" size="sm" variant="outline" disabled={!numericEditable || stale || financialDirty} onClick={() => void recoverVat()}>
                  {recoveringVat ? "Reading original PDF…" : "Recover missing VAT from original PDF"}
                </Button><p className="text-xs text-muted-foreground mt-1">Only uniquely matched source items with reconciled totals are accepted. Rates are added to this draft for your review, not saved automatically.</p></div>}
                <div className="max-h-64 overflow-y-auto space-y-2">
                  {draft.lines.map((line, index) => (financialIssues.some(issue => issue.key === line.clientKey) || vatRecoveryMessage && line.kind === "priced" && line.included) && <div key={line.clientKey} className="grid grid-cols-[1fr_100px] gap-3 items-center border-t pt-2">
                    <button type="button" className="text-left text-xs underline" onClick={() => locate(line.clientKey, {
                      section: "financial", rowId: line.id ?? undefined,
                      field: financialIssues.find(issue => issue.key === line.clientKey)?.field,
                    })}>
                      Item {index + 1} · {line.descriptionFr.slice(0, 85)}
                      {financialIssues.filter(issue => issue.key === line.clientKey).map(issue => <span key={issue.message} className="block text-amber-900">{issue.message}</span>)}
                    </button>
                    <DraftField label={`Item ${index + 1} VAT (%)`} value={line.vatRate} numeric disabled={!numericEditable || stale}
                      onChange={vatRate => updateDraft({ lines: draft.lines.map(row => row.clientKey === line.clientKey ? { ...row, vatRate } : row) })} />
                  </div>)}
                  {financialIssues.filter(issue => issue.key === "header").map(issue => <button key={issue.message} type="button" className="block text-xs underline"
                    onClick={() => locate("header", { section: "financial", field: issue.field })}>{issue.message}</button>)}
                </div>
              </section>}
              {original.blockedReason && <div role="alert" className="correction-banner rounded-lg p-3 text-xs flex items-start gap-2"><LockKeyhole size={14} className="shrink-0" />{original.blockedReason}</div>}
              {original.financialBlockedReason && !original.blockedReason && <div className="correction-banner rounded-lg p-3 text-xs flex items-start gap-2"><LockKeyhole size={14} className="shrink-0" /><div>{original.financialBlockedReason}<p className="mt-1 text-muted-foreground">Content may be edited; committed financial identities and figures are protected.</p></div></div>}
              {original.baseline ? <div data-quotation-field="sourceTtc" tabIndex={-1}
                className="correction-banner rounded-lg px-4 py-3 flex flex-wrap justify-between gap-3">
                <div className="flex items-start gap-2"><LockKeyhole size={14} className="mt-0.5" /><div>
                  <p className="text-[10px] uppercase tracking-wider font-semibold">Original PDF total including VAT · confirmed</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{original.baseline.sourceFileName} · confirmed by {original.baseline.confirmedBy}</p>
                </div></div><p className="correction-number text-lg font-semibold">{euro(original.baseline.ttc)}</p>
              </div> : <div className="space-y-2">
                {!sourceConfirmationRequired && <Button type="button" variant="ghost" size="sm"
                  aria-expanded={sourceConfirmationOpen} aria-controls={`source-confirmation-${devisId}`}
                  onClick={() => setSourceConfirmationOpen(value => !value)}>Confirm source total (optional)</Button>}
                {(sourceConfirmationRequired || sourceConfirmationOpen) && <section id={`source-confirmation-${devisId}`}
                  className="correction-banner rounded-lg p-4 space-y-3" aria-label="Confirm source TTC">
                <div className="flex items-start gap-2"><FileText size={16} className="shrink-0 mt-0.5" /><div><h3 className="text-xs font-semibold">Confirm the original PDF total including VAT</h3>
                  <p className="text-[11px] text-muted-foreground mt-1">This check has not been recorded yet; that does not mean the total is wrong. Compare the final TTC with the original PDF, enter its page and confirm below. {sourceConfirmationRequired ? "Confirmation is needed before approval or saving financial changes." : "The current checklist does not require this optional confirmation."}</p>
                  <SourceTotalHelp /></div></div>
                {sourceSuggestion ? <div className="space-y-2">
                  <p className="text-xs">Total read from the original PDF (TTC): <strong className="correction-number">{euro(sourceSuggestion)}</strong> · check against the PDF before confirming.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" aria-pressed={sourceTotalChoice === "match"}
                      data-quotation-field={sourceTotalChoice === null ? "sourceTtc" : undefined}
                      disabled={!editable || stale} onClick={() => { setSourceTotalChoice("match"); setPdfConfirmed(false); setSourceOpen(true); }}>Matches the PDF</Button>
                    <Button type="button" size="sm" variant="outline" aria-pressed={sourceTotalChoice === "manual"}
                      disabled={!editable || stale} onClick={() => { setSourceTotalChoice("manual"); setPdfConfirmed(false); setRequestedField("sourceTtc"); setLocateRequest(value => value + 1); setSourceOpen(true); }}>Enter a different total</Button>
                  </div>
                </div> : <p className="text-xs">No total is available from the original extraction. Enter the final TTC printed on the original PDF.</p>}
                <div className="text-xs space-y-1 border-t border-[#d8cbb9] pt-3" aria-label="Provisional total comparison">
                  <p className="font-semibold">Provisional comparison · original PDF total not yet confirmed</p>
                  {totals.value ? <>
                    <p>Computed working TTC: <strong className="correction-number">{euro(totals.value.ttc)}</strong>
                      {provisionalDifference !== null && <> · Proposed original TTC: <strong className="correction-number">{euro(proposedSourceTtc)}</strong></>}</p>
                    <p>{provisionalDifference === null ? "Enter the original PDF total to compare before confirming."
                      : provisionalDifference === "0.00" ? "No difference in these figures; the original PDF still needs your confirmation."
                        : `Working minus proposed original TTC: ${euro(provisionalDifference)}. Confirming the original will not balance this difference; review the working figures separately.`}</p>
                  </> : <p>Working TTC cannot yet be calculated. Resolve missing VAT or other financial fields shown above. Confirming the original PDF total does not resolve those gaps.</p>}
                </div>
                <div className="grid gap-3 md:grid-cols-[1fr_120px_auto] items-end">
                  {(!sourceSuggestion || sourceTotalChoice === "manual") ? <DraftField label="Final TTC on original PDF (€)" field="sourceTtc" value={baselineTtc} onChange={value => { setBaselineTtc(value); setPdfConfirmed(false); }} numeric disabled={!editable || stale} />
                    : <p className="text-xs">{sourceTotalChoice === "match" ? `Selected original PDF total: ${euro(sourceSuggestion)}` : "Choose whether this amount matches the original PDF."}</p>}
                  <DraftField label="PDF page" value={baselinePage} onChange={value => { setBaselinePage(value); setPdfConfirmed(false); if (/^[1-9]\d*$/.test(value)) setSourcePage(Number(value)); }} numeric disabled={!editable || stale} />
                  <Button type="button" size="sm" variant="outline" disabled={!editable || stale || !pdfConfirmed || !/^\d+(?:\.\d{1,2})?$/.test(sourceTtcInput) || !/^[1-9]\d*$/.test(baselinePage)}
                    onClick={() => void establishBaseline()}><LockKeyhole size={13} className="mr-2" />{baseline.isPending ? "Confirming…" : "Confirm original PDF total"}</Button>
                </div>
                <div className="flex items-start gap-2 text-[11px]"><input id={confirmId} type="checkbox" checked={pdfConfirmed}
                  disabled={!editable || stale} onChange={event => setPdfConfirmed(event.target.checked)} className="mt-0.5 accent-[#0b2545]" />
                  <label htmlFor={confirmId}>I have read the original PDF and confirmed this TTC, including its VAT, discounts and accepted options.</label></div>
                <p role="status" className="text-xs text-muted-foreground">{sourceConfirmationHint}</p>
                </section>}
                {!sourceConfirmationRequired && <p className="text-[11px] text-muted-foreground">{readiness
                  ? "No manual source confirmation is requested by the current checklist."
                  : "The saved-version checklist determines whether source confirmation is needed."} Financial edits may require an independently confirmed source total.</p>}
              </div>}
              {original.advisoryMessages.length > 0 && <details className="text-[11px] border border-[#d8cbb9] rounded-lg px-3 py-2">
                <summary className="cursor-pointer font-semibold">Extraction observations · advisory, not a human approval gate</summary>
                <ul className="list-disc pl-4 mt-2 space-y-1 text-muted-foreground">{original.advisoryMessages.map((message, index) => <li key={index}>{message}</li>)}</ul>
              </details>}
              {error && <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 text-rose-900 p-3 text-xs space-y-2">
                <p className="font-semibold">{stale ? "The quotation changed. Your draft has not been overwritten." : error?.startsWith("Your unsaved working draft was restored") ? "Unsaved draft restored" : "Your draft is preserved"}</p>
                <p>{error}</p>{stale && <p>Compare your draft with the latest saved changes below. Choose overlapping values, then rebase and save in this workspace.</p>}
                <Button type="button" size="sm" variant="outline" onClick={() => {
                  const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob); const link = document.createElement("a");
                  link.href = url; link.download = `devis-${devisId}-unsaved-correction.json`; link.click(); URL.revokeObjectURL(url);
                }}>Download draft backup</Button>
              </div>}
            </div>
            {latest && comparison && <QuotationConflictReview conflicts={comparison.conflicts} choices={mergeChoices}
              onChoice={(key, choice) => setMergeChoices(previous => ({ ...previous, [key]: choice }))}
              onApply={() => {
                const merged = mergeQuotationDraft(original.draft, draft, latest.draft, mergeChoices);
                if (merged.conflicts.length) return;
                setOriginal(latest); setDraft(merged.draft); setLatest(null); setStale(false); setError(null); setSavedMessage(false);
              }} />}
            <div className="correction-editor-grid border-t border-[#d8cbb9]">
              <nav className="p-3 md:border-r border-[#d8cbb9] bg-[#f8f5ef]" aria-label="Working quotation sections">
                <button type="button" className={`text-left w-full p-3 rounded-md text-xs ${selected === "header" ? "bg-[#0b2545] text-[#f8f5ef]" : "hover:bg-[#ece6db]"}`}
                  onClick={() => { setSelected("header"); setSelection(null); }}><span className="block font-semibold">Header & overview</span><span className="block text-[10px] opacity-75 mt-1">French · English · explanations</span></button>
                <p className="correction-label px-3 mt-5">{draft.lines.length} stable content rows</p>
                <div className="correction-row-list space-y-1">
                  {draft.lines.map((line, index) => <button type="button" key={line.clientKey}
                    onClick={() => { setSelected(line.clientKey); setSelection(null); setTarget(""); }}
                    className={`w-full rounded-md p-3 text-left text-xs ${selected === line.clientKey ? "bg-[#0b2545] text-[#f8f5ef]" : "hover:bg-[#ece6db]"}`}>
                    <span className="flex justify-between gap-2"><span className="font-semibold">{String(index + 1).padStart(2, "0")} · {line.kind === "context" ? "Context" : "Priced item"}</span>
                      {!line.included && line.kind === "priced" && <span className="text-[9px]">OPTION</span>}</span>
                    <span className="block truncate text-[11px] opacity-75 mt-1">{line.descriptionFr || "New content — not yet described"}</span>
                    {line.id === null && <span className="block text-[9px] opacity-60 mt-1">New · unsaved</span>}
                  </button>)}
                </div>
                <div className="grid gap-2 mt-4">
                  <Button type="button" size="sm" variant="outline" onClick={() => void fillEnglish()} disabled={!editable || stale}
                    className="text-[11px] justify-start"><Languages size={12} className="mr-2" />{suggest.isPending ? "Suggesting English…" : "Fill empty English fields"}</Button>
                  {suggestionError && <p role="alert" className="text-xs text-destructive">Optional English suggestions unavailable: {suggestionError} You can keep editing and save your own wording.</p>}
                  <Button type="button" size="sm" variant="outline" onClick={() => addLine("context")} disabled={!editable} className="text-[11px] justify-start"><Plus size={12} className="mr-2" />Add context-only line</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => addLine("priced")} disabled={!numericEditable} className="text-[11px] justify-start"><Plus size={12} className="mr-2" />Add priced line</Button>
                </div>
                {!draft.lines.length && <p className="text-[11px] text-muted-foreground px-2 mt-3">No working rows yet. Add content or a priced item to construct the interpretation.</p>}
              </nav>
              <main className="p-5 md:p-7 min-w-0">
                {requestedField && <p role="status" className="mb-3 text-xs text-muted-foreground">Finding target · {quotationFieldLabel(requestedField)}. Review against the original PDF before editing.</p>}
                {selected === "header" ? <div className="space-y-5">
                  <h3 className="text-sm font-semibold">Header & contextual overview</h3>
                  <div className="grid gap-4 md:grid-cols-2">
                    <DraftField label="French header" field="headerFr" value={draft.headerFr} onChange={headerFr => updateDraft({ headerFr })} multiline disabled={!editable} />
                    <DraftField label="English header" field="headerEn" value={draft.headerEn} onChange={headerEn => updateDraft({ headerEn })} multiline disabled={!editable} />
                    <DraftField label="French header explanation" field="explanationFr" value={draft.explanationFr} onChange={explanationFr => updateDraft({ explanationFr })} multiline disabled={!editable} />
                    <DraftField label="English header explanation" field="explanationEn" value={draft.explanationEn} onChange={explanationEn => updateDraft({ explanationEn })} multiline disabled={!editable} />
                  </div>
                  <DraftField label="English overview" field="summaryEn" value={draft.summaryEn} onChange={summaryEn => updateDraft({ summaryEn })} multiline disabled={!editable} />
                  <div className="border-t border-[#d8cbb9] pt-4 space-y-2">
                    <label className="correction-label" htmlFor={`${confirmId}-vat-rounding`}>VAT rounding on source PDF</label>
                    <select id={`${confirmId}-vat-rounding`} data-quotation-field="vatRounding" value={draft.vatRounding ?? "bucket"} disabled={!numericEditable}
                      onChange={event => updateDraft({ vatRounding: event.target.value as "bucket" | "line" })}
                      className="w-full h-9 rounded-md border border-input bg-background text-xs px-2">
                      <option value="bucket">Once per VAT-rate subtotal</option><option value="line">Per individual line</option>
                    </select>
                    <DraftField label="Document discount HT (€)" field="discountHt" value={draft.discountHt} onChange={discountHt => updateDraft({ discountHt })} numeric disabled={!numericEditable} />
                    <p className="text-[11px] text-muted-foreground">A positive discount reduces the included HT. The preview allocates it proportionally across actual VAT buckets; no 20% default or balancing adjustment is added.</p>
                  </div>
                </div> : current ? <section className="space-y-5" aria-label={`Edit row ${currentIndex + 1}`}>
                  <div className="flex justify-between flex-wrap items-start gap-3">
                    <div><h3 className="text-sm font-semibold">{current.kind === "context" ? "Context-only line" : "Priced item"} {currentIndex + 1}</h3>
                      <p className="text-[10px] text-muted-foreground mt-1">{current.id !== null ? "Questions and evidence remain attached to this row." : "New line · an identity will be assigned on save"}</p>
                      {current.id !== null && <details className="mt-2 text-[10px] text-muted-foreground"><summary className="cursor-pointer">Technical details</summary><p>Stable row ID: {current.id}</p></details>}</div>
                    <div className="flex gap-1">
                      <Button type="button" size="icon" variant="outline" aria-label="Move row up" disabled={!editable || currentIndex === 0} onClick={() => updateDraft({ lines: reorderCorrectionLine(draft.lines, currentIndex, currentIndex - 1) })}><ArrowUp size={13} /></Button>
                      <Button type="button" size="icon" variant="outline" aria-label="Move row down" disabled={!editable || currentIndex === draft.lines.length - 1} onClick={() => updateDraft({ lines: reorderCorrectionLine(draft.lines, currentIndex, currentIndex + 1) })}><ArrowDown size={13} /></Button>
                      {current.id === null && <Button type="button" size="icon" variant="outline" aria-label="Remove unsaved row" disabled={!editable} onClick={() => {
                        updateDraft({ lines: draft.lines.filter(line => line.clientKey !== current.clientKey) }); setSelected("header");
                      }}><Trash2 size={13} /></Button>}
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div><label className="correction-label" htmlFor={`${confirmId}-description`}>Full French description</label>
                      <Textarea id={`${confirmId}-description`} data-quotation-field="descriptionFr" ref={frenchInput} value={current.descriptionFr} disabled={!editable}
                        onChange={event => { updateLine({ descriptionFr: event.target.value }); setSelection(null); }}
                        onSelect={event => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
                        className="resize-y text-xs bg-background" /></div>
                    <DraftField label="English translation" field="descriptionEn" value={current.descriptionEn} onChange={descriptionEn => updateLine({ descriptionEn })} multiline disabled={!editable} />
                    <DraftField label="French explanation" field="explanationFr" value={current.explanationFr} onChange={explanationFr => updateLine({ explanationFr })} multiline disabled={!editable} />
                    <DraftField label="English explanation" field="explanationEn" value={current.explanationEn} onChange={explanationEn => updateLine({ explanationEn })} multiline disabled={!editable} />
                  </div>
                  <p className="text-[11px] text-muted-foreground">French changes do not rewrite your English text. Review both languages before approving the corrected package.</p>
                  <div className="correction-row p-4 space-y-3">
                    <h4 className="text-xs font-semibold">Realign content without moving money</h4>
                    <p className="text-[11px] text-muted-foreground">Select a passage in the French description, or use the whole description. Copy or move only that text to another row. Prices, translations, IDs and evidence stay put.</p>
                    <label className="correction-label" htmlFor={targetId}>Destination row</label>
                    <select id={targetId} value={target} disabled={!editable} onChange={event => setTarget(event.target.value)}
                      className="w-full h-9 rounded-md border border-input bg-background text-xs px-2">
                      <option value="">Choose destination…</option>
                      {draft.lines.filter(line => line.clientKey !== current.clientKey).map(line => <option key={line.clientKey} value={line.clientKey}>
                        {draft.lines.indexOf(line) + 1} · {line.descriptionFr.slice(0, 70) || "Untitled context"}
                      </option>)}
                    </select>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" disabled={!editable || !target || !current.descriptionFr} onClick={() => transfer(false)} className="text-[11px]"><Copy size={12} className="mr-2" />Copy {selection && selection.end > selection.start ? "selected passage" : "description"}</Button>
                      <Button type="button" size="sm" variant="outline" disabled={!editable || !target || !current.descriptionFr} onClick={() => transfer(true)} className="text-[11px]"><Scissors size={12} className="mr-2" />Move {selection && selection.end > selection.start ? "selected passage" : "description"}</Button>
                      <Button type="button" size="sm" variant="outline" disabled={!editable || !selection || selection.end <= selection.start}
                        onClick={splitContext} className="text-[11px]"><Plus size={12} className="mr-2" />Split selection into context</Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">Reordering above moves the complete row as a display unit. Existing rows cannot be deleted or merged financially here.</p>
                  </div>
                  {current.kind === "context" ? <div className="flex gap-2 p-3 rounded-lg bg-[#eee8dd] text-[11px]"><ShieldCheck size={14} className="shrink-0" />Context-only content never creates a charge or adds VAT.</div>
                    : <div className="border-t border-[#d8cbb9] pt-4 space-y-3">
                      <h4 className="text-xs font-semibold">Working figures · reconciled as a complete batch</h4>
                      <div className="grid gap-3 grid-cols-1 md:grid-cols-3">
                        <DraftField label="Quantity" field="quantity" value={current.quantity} onChange={quantity => updateLine({ quantity })} numeric disabled={!numericEditable} />
                        <DraftField label="Unit" field="unit" value={current.unit} onChange={unit => updateLine({ unit })} disabled={!numericEditable} />
                        <DraftField label="Unit price HT (€)" field="unitPriceHt" value={current.unitPriceHt} onChange={unitPriceHt => updateLine({ unitPriceHt })} numeric disabled={!numericEditable} />
                        <DraftField label="Line amount HT (€)" field="totalHt" value={current.totalHt} onChange={totalHt => updateLine({ totalHt })} numeric disabled={!numericEditable} />
                        <DraftField label="Actual VAT rate (%)" field="vatRate" value={current.vatRate} onChange={vatRate => updateLine({ vatRate })} numeric disabled={!numericEditable} />
                        <div className="flex items-end"><Button type="button" variant="outline" size="sm" disabled={!numericEditable} className="text-[11px] w-full" onClick={() => {
                          try { updateLine({ totalHt: correctionProduct(current.quantity, current.unitPriceHt) }); }
                          catch (cause) { reportError(cause); }
                        }}>Calculate quantity × unit price</Button></div>
                      </div>
                      <label className="text-[11px] flex items-start gap-2"><input type="checkbox" data-quotation-field="included" checked={current.included} disabled={!numericEditable}
                        onChange={event => updateLine({ included: event.target.checked })} className="mt-0.5 accent-[#0b2545]" />Include this item in the financial total (uncheck for an unaccepted option).</label>
                      <p className="text-[10px] text-muted-foreground">Amounts may be edited explicitly to represent the contractor’s actual line rounding. Enter 0% for exempt or reverse-charge VAT; an empty VAT rate is not assumed to be 20%.</p>
                    </div>}
                </section> : null}
                {contexts.isLoading && <Skeleton className="h-24 w-full mt-5" />}
                {contexts.isError && <div role="alert" className="text-xs mt-5">Context could not be loaded. <Button type="button" size="sm" variant="outline" onClick={() => void contexts.refetch()}>Retry context</Button></div>}
                {contexts.data && draft.lines.map((line, index) => <div key={line.clientKey} hidden={selected !== line.clientKey}
                  data-quotation-field="context" tabIndex={-1} className="border-t mt-5 pt-5">
                  {line.id === null ? <p className="text-xs">Save this new line before adding rich context or images. Saving assigns its stable identity; wording above stays in your draft.</p> :
                    <DevisLineContextEditor devisId={devisId} lineItemId={line.id} lineNumber={index + 1}
                      context={contexts.data.contexts?.find(context => context.devisLineItemId === line.id) ?? null}
                      readOnly={disabled || !!original.blockedReason} />}
                </div>)}
              </main>
            </div>
            {original.history.length > 0 && <details className="mx-5 my-4 border border-[#d8cbb9] rounded-lg p-3 text-[11px]">
              <summary className="cursor-pointer font-semibold">Saved correction history · actor and time recorded automatically</summary>
              <ol className="mt-3 space-y-3">{original.history.map(entry => <li key={entry.id}><p>{entry.summary}</p>
                <p className="text-muted-foreground mt-1">{entry.actor} · {entry.savedAt}</p></li>)}</ol>
            </details>}
            </div></div>
            <footer className="correction-toolbar px-5 py-4 md:px-7">
              <div className="flex flex-wrap justify-between gap-4 items-center">
                <div className="min-w-0">
                  <p className="correction-label mb-1">Working TTC <span className="normal-case tracking-normal font-normal">· exact-cent preview</span></p>
                  <div className="flex flex-wrap items-baseline gap-3">
                    <strong className="correction-number text-xl">{totals.value ? euro(totals.value.ttc) : "Not yet computable"}</strong>
                    {difference !== null && <span className={`text-[11px] ${difference === "0.00" ? "text-emerald-800" : "text-amber-900"}`}>{difference === "0.00" ? <span className="inline-flex gap-1 items-center"><Check size={12} />Matches confirmed original PDF total</span> : `Difference from confirmed original PDF total: ${euro(difference)}`}</span>}
                    {difference !== null && difference !== "0.00" && <SourceTotalHelp kind="difference" />}
                  </div>
                  {validationMessage && <p className="text-[11px] text-amber-900 mt-1 flex gap-1"><TriangleAlert size={12} className="shrink-0 mt-0.5" />{validationMessage}</p>}
                  {totals.error && !financialDirty && <p className="text-[10px] text-muted-foreground mt-1">VAT treatment is incomplete. Text-only corrections remain available; complete figures before a financial batch.</p>}
                  {savedMessage && <p role="status" className="text-[11px] text-emerald-800 mt-1">Saved. Review and approve the latest checklist above.</p>}
                  <p className="text-[10px] text-muted-foreground mt-1">{financialDirty ? "Financial batch · must reconcile with the confirmed source total." : "Wording-only saves do not require a new source-total confirmation."} Wording and figures save on request; rich context saves automatically. Original PDF and signed evidence are unchanged.</p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={dismiss}>{ownUploadPending ? "Uploading image…" : dirty ? "Close editor…" : "Close"}</Button>
                  <Button type="button" size="sm" onClick={() => void saveDraft()} disabled={!editable || !dirty || !!validationMessage || stale}
                    className="gap-2 bg-[#0b2545] hover:bg-[#173657] text-[#f8f5ef]"><Save size={13} />{save.isPending ? "Saving batch…" : "Save correction"}</Button>
                </div>
              </div>
            </footer>
          </> : null}
      </DialogContent>
    </Dialog>
    <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Keep your unsaved correction?</AlertDialogTitle>
          <AlertDialogDescription>Keep your draft in this browser tab to resume later, or discard only the editor changes. Context saves and the saved quotation are not discarded.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction onClick={() => {
            if (original && draft) keepQuotationDraft(devisId, { original, draft });
            setOpen(false); setDiscardOpen(false); initialized.current = false;
          }}>Keep draft and close</AlertDialogAction>
          <AlertDialogAction onClick={() => { setOpen(false); setDiscardOpen(false); initialized.current = false; setDraft(null); setOriginal(null); setLatest(null); setStale(false); setError(null); keepQuotationDraft(devisId, null); setQuotationWork(devisId, workKey, false); }}>Discard draft</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
