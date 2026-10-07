import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink, FileText, Languages, LockKeyhole, Pencil, Plus, Save, Scissors, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useArchitectCorrection } from "./use-architect-correction";
import { correctionCents, correctionMoney, correctionProduct, createCorrectionLine, financialProjection, previewCorrectionTotals, reorderCorrectionLine, transferCorrectionPassage } from "./architect-correction-model";
import type { ArchitectCorrectionDraft, ArchitectCorrectionLine, ArchitectCorrectionSnapshot } from "./architect-correction-model";
import "./architect-correction.css";

interface Props { devisId: number; projectId: string; disabled?: boolean }
const euro = (decimal: string) => `${decimal.replace(".", ",")} €`;

function DraftField({ label, value, onChange, multiline = false, disabled = false, numeric = false }: {
  label: string; value: string; onChange: (value: string) => void; multiline?: boolean; disabled?: boolean; numeric?: boolean;
}) {
  const id = useId();
  return <div className="min-w-0">
    <label htmlFor={id} className="correction-label">{label}</label>
    {multiline ? <Textarea id={id} value={value} onChange={event => onChange(event.target.value)}
      disabled={disabled} className="resize-y text-xs bg-background" />
      : <Input id={id} value={value} onChange={event => onChange(event.target.value)}
        disabled={disabled} inputMode={numeric ? "decimal" : undefined}
        className={`text-xs bg-background ${numeric ? "correction-number" : ""}`} />}
  </div>;
}

export function ArchitectQuotationEditor({ devisId, projectId, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [draft, setDraft] = useState<ArchitectCorrectionDraft | null>(null);
  const [original, setOriginal] = useState<ArchitectCorrectionSnapshot | null>(null);
  const [selected, setSelected] = useState<string>("header");
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [baselineTtc, setBaselineTtc] = useState("");
  const [baselinePage, setBaselinePage] = useState("");
  const [pdfConfirmed, setPdfConfirmed] = useState(false);
  const [target, setTarget] = useState("");
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);
  const initialized = useRef(false);
  const submitLock = useRef(false);
  const mounted = useRef(true);
  const frenchInput = useRef<HTMLTextAreaElement>(null);
  const confirmId = useId();
  const targetId = useId();
  const { toast } = useToast();
  const { snapshot, save, baseline, suggest } = useArchitectCorrection(devisId, projectId, open);
  const pending = save.isPending || baseline.isPending || suggest.isPending;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open || !snapshot.data || initialized.current) return;
    initialized.current = true;
    setOriginal(snapshot.data);
    setDraft(structuredClone(snapshot.data.draft));
    setSelected("header");
    setError(null); setStale(false); setSavedMessage(false);
  }, [open, snapshot.data]);
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
  const financialDirty = headerReconciliation || !!draft && !!original && financialProjection(draft) !== financialProjection(original.draft);
  const editable = !pending && !disabled && !original?.blockedReason;
  const currentIndex = draft?.lines.findIndex(line => line.clientKey === selected) ?? -1;
  const current = draft && currentIndex >= 0 ? draft.lines[currentIndex] : null;
  const numericEditable = editable && financialAllowed;
  const validationMessage = financialDirty
    ? !original?.baseline ? "Confirm the source TTC from the original PDF before saving financial changes."
      : totals.error ?? (difference === null ? "Source totals could not be read."
        : difference !== "0.00" ? "The batch TTC must equal the locked source TTC before financial changes can be saved." : null)
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
    if (submitLock.current || pending) return;
    if (dirty) setDiscardOpen(true);
    else { setOpen(false); initialized.current = false; }
  };
  const reportError = (cause: unknown) => {
    if (!mounted.current) return;
    setError(cause instanceof Error ? cause.message : "The correction could not be saved. Your draft is still here.");
    if (cause instanceof ApiError && cause.status === 409) {
      setStale(true);
      // Refresh the cached snapshot for a later reopen, never the active draft.
      void snapshot.refetch();
    }
  };
  const saveDraft = async () => {
    if (!draft || !original || !editable || !dirty || validationMessage || submitLock.current || stale) return;
    submitLock.current = true;
    setError(null);
    const submitted = structuredClone(draft);
    try {
      const result = await save.mutateAsync({ ...submitted, expectedVersion: original.version });
      if (!mounted.current) return;
      setOriginal(result); setDraft(structuredClone(result.draft)); setSavedMessage(true);
      toast({ title: "Architect correction saved", description: "Original PDF and source TTC are unchanged. Previous translation approval has been cleared." });
    } catch (cause) { reportError(cause); }
    finally { submitLock.current = false; }
  };
  const establishBaseline = async () => {
    if (!original || !pdfConfirmed || !baselineTtc || !/^[1-9]\d*$/.test(baselinePage)
      || submitLock.current || !editable || stale) return;
    let ttc: string;
    try {
      if (!/^\d+(?:\.\d{1,2})?$/.test(baselineTtc)) throw new Error("Transcribe the source TTC with no more than two decimal places.");
      const cents = correctionCents(baselineTtc);
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
      toast({ title: "Source TTC locked", description: "Your unsaved correction has been preserved." });
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
    submitLock.current = true; setError(null);
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
    } catch (cause) { reportError(cause); } finally { submitLock.current = false; }
  };

  return <>
    <div className="architect-correction px-3 py-3" data-testid={`architect-correction-entry-${devisId}`}>
      {error && <p role="alert" className="mb-2 text-xs text-destructive">{stale ? "Stale working quotation · your draft is preserved. " : "Working quotation save failed · your draft is preserved. "}{error}</p>}
      {(dirty || pending) && <p data-workflow-attention className="mb-2 text-[11px] text-muted-foreground">{pending ? "Working quotation · save or update in progress. Keep this project open." : "Working quotation · unsaved correction draft."}</p>}
      <div className="correction-banner rounded-lg flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-start gap-3">
          <Pencil size={15} className="mt-0.5 shrink-0" />
          <div><p className="text-xs font-semibold">Architect’s working version</p>
            <p className="text-[11px] text-muted-foreground mt-1">Correct descriptions, translations and figures. The contractor’s original PDF remains the legal reference.</p>
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} disabled={disabled}
          className="border-[#94734c]/40 bg-[#f8f5ef] text-[#0b2545] text-[11px] gap-2 shrink-0">
          <Pencil size={13} /> Edit working quotation
        </Button>
      </div>
    </div>
    <Dialog open={open} onOpenChange={next => { if (!next) dismiss(); }}>
      <DialogContent className="architect-correction max-w-[1120px] w-[calc(100vw-24px)] max-h-[94dvh] overflow-y-auto p-0 gap-0"
        onEscapeKeyDown={event => { if (dirty || pending) { event.preventDefault(); dismiss(); } }}
        onPointerDownOutside={event => { if (dirty || pending) { event.preventDefault(); dismiss(); } }}>
        <DialogHeader className="px-5 pt-6 pb-4 md:px-7 border-b border-[#d8cbb9]">
          <div className="flex items-center gap-2 text-[#94734c]"><ShieldCheck size={14} /><span className="text-[10px] uppercase tracking-[.15em] font-semibold">Architect-controlled correction</span></div>
          <DialogTitle className="text-xl tracking-tight text-[#0b2545]">Review the interpretation. Keep the original.</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed max-w-[700px]">
            Save French and English content without OCR or model approval. Financial corrections apply as one batch only when the computed TTC matches the independently locked source TTC.
          </DialogDescription>
          <a href={`/api/devis/${devisId}/pdf?variant=original`} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-xs underline underline-offset-4 w-fit">
            <FileText size={13} /> Open original contractor PDF <ExternalLink size={12} />
          </a>
        </DialogHeader>
        {snapshot.isLoading && !draft ? <div className="p-6 space-y-4" aria-label="Loading quotation editor"><Skeleton className="h-20 w-full" /><Skeleton className="h-12 w-1/3" /><Skeleton className="h-64 w-full" /></div>
          : snapshot.isError && !draft ? <div className="p-7 space-y-3" role="alert"><p className="text-sm font-semibold">The working quotation could not be loaded.</p>
            <p className="text-xs text-muted-foreground">{snapshot.error.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void snapshot.refetch()}>Retry loading</Button></div>
          : draft && original ? <>
            <div className="px-5 py-4 md:px-7 space-y-3">
              {original.blockedReason && <div role="alert" className="correction-banner rounded-lg p-3 text-xs flex items-start gap-2"><LockKeyhole size={14} className="shrink-0" />{original.blockedReason}</div>}
              {original.financialBlockedReason && !original.blockedReason && <div className="correction-banner rounded-lg p-3 text-xs flex items-start gap-2"><LockKeyhole size={14} className="shrink-0" /><div>{original.financialBlockedReason}<p className="mt-1 text-muted-foreground">Content may be edited; committed financial identities and figures are protected.</p></div></div>}
              {original.baseline ? <div className="correction-banner rounded-lg px-4 py-3 flex flex-wrap justify-between gap-3">
                <div className="flex items-start gap-2"><LockKeyhole size={14} className="mt-0.5" /><div>
                  <p className="text-[10px] uppercase tracking-wider font-semibold">Source TTC · locked independently</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{original.baseline.sourceFileName} · confirmed by {original.baseline.confirmedBy}</p>
                </div></div><p className="correction-number text-lg font-semibold">{euro(original.baseline.ttc)}</p>
              </div> : <section className="correction-banner rounded-lg p-4 space-y-3" aria-label="Confirm source TTC">
                <div className="flex items-start gap-2"><FileText size={16} className="shrink-0 mt-0.5" /><div><h3 className="text-xs font-semibold">Establish the financial backstop from the PDF</h3>
                  <p className="text-[11px] text-muted-foreground mt-1">Extracted totals and working row sums are not a trusted baseline. Read the original PDF and transcribe its final TTC once. This confirmation cannot be changed by ordinary edits.</p></div></div>
                <div className="grid gap-3 md:grid-cols-[1fr_120px_auto] items-end">
                  <DraftField label="Final TTC on original PDF (€)" value={baselineTtc} onChange={setBaselineTtc} numeric disabled={!editable || stale} />
                  <DraftField label="PDF page" value={baselinePage} onChange={setBaselinePage} numeric disabled={!editable || stale} />
                  <Button type="button" size="sm" variant="outline" disabled={!editable || stale || !pdfConfirmed || !baselineTtc || !/^[1-9]\d*$/.test(baselinePage)}
                    onClick={() => void establishBaseline()}><LockKeyhole size={13} className="mr-2" />{baseline.isPending ? "Confirming…" : "Lock source TTC"}</Button>
                </div>
                <div className="flex items-start gap-2 text-[11px]"><input id={confirmId} type="checkbox" checked={pdfConfirmed}
                  disabled={!editable || stale} onChange={event => setPdfConfirmed(event.target.checked)} className="mt-0.5 accent-[#0b2545]" />
                  <label htmlFor={confirmId}>I have read the original PDF and confirmed this TTC, including its VAT, discounts and accepted options.</label></div>
              </section>}
              {original.advisoryMessages.length > 0 && <details className="text-[11px] border border-[#d8cbb9] rounded-lg px-3 py-2">
                <summary className="cursor-pointer font-semibold">Extraction observations · advisory, not a human approval gate</summary>
                <ul className="list-disc pl-4 mt-2 space-y-1 text-muted-foreground">{original.advisoryMessages.map((message, index) => <li key={index}>{message}</li>)}</ul>
              </details>}
              {error && <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 text-rose-900 p-3 text-xs space-y-2">
                <p className="font-semibold">{stale ? "The quotation changed. Your draft has not been overwritten." : "Save failed. Your draft is still here."}</p>
                <p>{error}</p>{stale && <p>Copy your draft before discarding it, then reopen the editor to compare against the latest saved version. Stale batches cannot be forced through.</p>}
                <Button type="button" size="sm" variant="outline" onClick={() => {
                  const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob); const link = document.createElement("a");
                  link.href = url; link.download = `devis-${devisId}-unsaved-correction.json`; link.click(); URL.revokeObjectURL(url);
                }}>Download draft backup</Button>
              </div>}
            </div>
            <div className="grid md:grid-cols-[230px_minmax(0,1fr)] border-t border-[#d8cbb9]">
              <nav className="p-3 md:border-r border-[#d8cbb9] bg-[#f8f5ef]" aria-label="Working quotation sections">
                <button type="button" className={`text-left w-full p-3 rounded-md text-xs ${selected === "header" ? "bg-[#0b2545] text-[#f8f5ef]" : "hover:bg-[#ece6db]"}`}
                  onClick={() => { setSelected("header"); setSelection(null); }}><span className="block font-semibold">Header & overview</span><span className="block text-[10px] opacity-75 mt-1">French · English · explanations</span></button>
                <p className="correction-label px-3 mt-5">{draft.lines.length} stable content rows</p>
                <div className="md:max-h-[430px] md:overflow-y-auto space-y-1">
                  {draft.lines.map((line, index) => <button type="button" key={line.clientKey}
                    onClick={() => { setSelected(line.clientKey); setSelection(null); setTarget(""); }}
                    className={`w-full rounded-md p-3 text-left text-xs ${selected === line.clientKey ? "bg-[#0b2545] text-[#f8f5ef]" : "hover:bg-[#ece6db]"}`}>
                    <span className="flex justify-between gap-2"><span className="font-semibold">{String(index + 1).padStart(2, "0")} · {line.kind === "context" ? "Context" : "Priced item"}</span>
                      {!line.included && line.kind === "priced" && <span className="text-[9px]">OPTION</span>}</span>
                    <span className="block truncate text-[11px] opacity-75 mt-1">{line.descriptionFr || "New content — not yet described"}</span>
                    <span className="block text-[9px] opacity-60 mt-1">{line.id !== null ? `Stable ID ${line.id}` : "New · unsaved"}</span>
                  </button>)}
                </div>
                <div className="grid gap-2 mt-4">
                  <Button type="button" size="sm" variant="outline" onClick={() => void fillEnglish()} disabled={!editable || stale}
                    className="text-[11px] justify-start"><Languages size={12} className="mr-2" />{suggest.isPending ? "Suggesting English…" : "Fill empty English fields"}</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => addLine("context")} disabled={!editable} className="text-[11px] justify-start"><Plus size={12} className="mr-2" />Add context-only line</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => addLine("priced")} disabled={!numericEditable} className="text-[11px] justify-start"><Plus size={12} className="mr-2" />Add priced line</Button>
                </div>
                {!draft.lines.length && <p className="text-[11px] text-muted-foreground px-2 mt-3">No working rows yet. Add content or a priced item to construct the interpretation.</p>}
              </nav>
              <main className="p-5 md:p-7 min-w-0">
                {selected === "header" ? <div className="space-y-5">
                  <h3 className="text-sm font-semibold">Header & contextual overview</h3>
                  <div className="grid gap-4 md:grid-cols-2">
                    <DraftField label="French header" value={draft.headerFr} onChange={headerFr => updateDraft({ headerFr })} multiline disabled={!editable} />
                    <DraftField label="English header" value={draft.headerEn} onChange={headerEn => updateDraft({ headerEn })} multiline disabled={!editable} />
                    <DraftField label="French header explanation" value={draft.explanationFr} onChange={explanationFr => updateDraft({ explanationFr })} multiline disabled={!editable} />
                    <DraftField label="English header explanation" value={draft.explanationEn} onChange={explanationEn => updateDraft({ explanationEn })} multiline disabled={!editable} />
                  </div>
                  <DraftField label="English overview" value={draft.summaryEn} onChange={summaryEn => updateDraft({ summaryEn })} multiline disabled={!editable} />
                  <div className="border-t border-[#d8cbb9] pt-4 space-y-2">
                    <label className="correction-label" htmlFor={`${confirmId}-vat-rounding`}>VAT rounding on source PDF</label>
                    <select id={`${confirmId}-vat-rounding`} value={draft.vatRounding ?? "bucket"} disabled={!numericEditable}
                      onChange={event => updateDraft({ vatRounding: event.target.value as "bucket" | "line" })}
                      className="w-full h-9 rounded-md border border-input bg-background text-xs px-2">
                      <option value="bucket">Once per VAT-rate subtotal</option><option value="line">Per individual line</option>
                    </select>
                    <DraftField label="Document discount HT (€)" value={draft.discountHt} onChange={discountHt => updateDraft({ discountHt })} numeric disabled={!numericEditable} />
                    <p className="text-[11px] text-muted-foreground">A positive discount reduces the included HT. The preview allocates it proportionally across actual VAT buckets; no 20% default or balancing adjustment is added.</p>
                  </div>
                </div> : current ? <section className="space-y-5" aria-label={`Edit row ${currentIndex + 1}`}>
                  <div className="flex justify-between flex-wrap items-start gap-3">
                    <div><h3 className="text-sm font-semibold">{current.kind === "context" ? "Context-only line" : "Priced item"} {currentIndex + 1}</h3>
                      <p className="text-[10px] text-muted-foreground mt-1">{current.id !== null ? `Stable ID ${current.id} · questions and evidence remain attached to this row` : "New line · an identity will be assigned on save"}</p></div>
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
                      <Textarea id={`${confirmId}-description`} ref={frenchInput} value={current.descriptionFr} disabled={!editable}
                        onChange={event => { updateLine({ descriptionFr: event.target.value }); setSelection(null); }}
                        onSelect={event => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
                        className="resize-y text-xs bg-background" /></div>
                    <DraftField label="English translation" value={current.descriptionEn} onChange={descriptionEn => updateLine({ descriptionEn })} multiline disabled={!editable} />
                    <DraftField label="French explanation" value={current.explanationFr} onChange={explanationFr => updateLine({ explanationFr })} multiline disabled={!editable} />
                    <DraftField label="English explanation" value={current.explanationEn} onChange={explanationEn => updateLine({ explanationEn })} multiline disabled={!editable} />
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
                        <DraftField label="Quantity" value={current.quantity} onChange={quantity => updateLine({ quantity })} numeric disabled={!numericEditable} />
                        <DraftField label="Unit" value={current.unit} onChange={unit => updateLine({ unit })} disabled={!numericEditable} />
                        <DraftField label="Unit price HT (€)" value={current.unitPriceHt} onChange={unitPriceHt => updateLine({ unitPriceHt })} numeric disabled={!numericEditable} />
                        <DraftField label="Line amount HT (€)" value={current.totalHt} onChange={totalHt => updateLine({ totalHt })} numeric disabled={!numericEditable} />
                        <DraftField label="Actual VAT rate (%)" value={current.vatRate} onChange={vatRate => updateLine({ vatRate })} numeric disabled={!numericEditable} />
                        <div className="flex items-end"><Button type="button" variant="outline" size="sm" disabled={!numericEditable} className="text-[11px] w-full" onClick={() => {
                          try { updateLine({ totalHt: correctionProduct(current.quantity, current.unitPriceHt) }); }
                          catch (cause) { reportError(cause); }
                        }}>Calculate quantity × unit price</Button></div>
                      </div>
                      <label className="text-[11px] flex items-start gap-2"><input type="checkbox" checked={current.included} disabled={!numericEditable}
                        onChange={event => updateLine({ included: event.target.checked })} className="mt-0.5 accent-[#0b2545]" />Include this item in the financial total (uncheck for an unaccepted option).</label>
                      <p className="text-[10px] text-muted-foreground">Amounts may be edited explicitly to represent the contractor’s actual line rounding. Enter 0% for exempt or reverse-charge VAT; an empty VAT rate is not assumed to be 20%.</p>
                    </div>}
                </section> : null}
              </main>
            </div>
            {original.history.length > 0 && <details className="mx-5 my-4 border border-[#d8cbb9] rounded-lg p-3 text-[11px]">
              <summary className="cursor-pointer font-semibold">Saved correction history · actor and time recorded automatically</summary>
              <ol className="mt-3 space-y-3">{original.history.map(entry => <li key={entry.id}><p>{entry.summary}</p>
                <p className="text-muted-foreground mt-1">{entry.actor} · {entry.savedAt}</p></li>)}</ol>
            </details>}
            <footer className="correction-toolbar px-5 py-4 md:px-7">
              <div className="flex flex-wrap justify-between gap-4 items-center">
                <div className="min-w-0">
                  <p className="correction-label mb-1">Working TTC <span className="normal-case tracking-normal font-normal">· exact-cent preview</span></p>
                  <div className="flex flex-wrap items-baseline gap-3">
                    <strong className="correction-number text-xl">{totals.value ? euro(totals.value.ttc) : "Not yet computable"}</strong>
                    {difference !== null && <span className={`text-[11px] ${difference === "0.00" ? "text-emerald-800" : "text-amber-900"}`}>{difference === "0.00" ? <span className="inline-flex gap-1 items-center"><Check size={12} />Matches source TTC</span> : `Difference ${euro(difference)}`}</span>}
                  </div>
                  {validationMessage && <p className="text-[11px] text-amber-900 mt-1 flex gap-1"><TriangleAlert size={12} className="shrink-0 mt-0.5" />{validationMessage}</p>}
                  {totals.error && !financialDirty && <p className="text-[10px] text-muted-foreground mt-1">VAT treatment is incomplete. Text-only corrections remain available; complete figures before a financial batch.</p>}
                  {savedMessage && <p role="status" className="text-[11px] text-emerald-800 mt-1">Saved. Review and approve the new translation version in the quotation’s Translation tab.</p>}
                  <p className="text-[10px] text-muted-foreground mt-1">No automatic save. Original PDF, locked TTC and signed evidence are not rewritten.</p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={pending} onClick={dismiss}>{dirty ? "Close editor…" : "Close"}</Button>
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
          <AlertDialogDescription>Closing without saving discards this local draft. The saved quotation and contractor PDF will not change.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction onClick={() => { setOpen(false); setDiscardOpen(false); initialized.current = false; setDraft(null); setOriginal(null); }}>Discard draft</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
