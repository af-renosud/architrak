import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink, ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { DevisLineItem } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useExtractionRowCorrection, type ExtractionRow, type ExtractionRowPreview, type ExtractionRowRequest } from "./use-extraction-row-correction";

type CorrectionLine = Pick<DevisLineItem, "id" | "devisId" | "lineNumber" | "description" | "quantity" | "unit" | "unitPriceHt" | "totalHt">;
interface Props {
  devisId: number;
  projectId: string;
  lines: CorrectionLine[];
  disabled?: boolean;
  compact?: boolean;
}
const blankRow = { lineNumber: "", description: "", quantity: "", unit: "", unitPriceHt: "", totalHt: "" };
const fields = [
  ["lineNumber", "Line number"], ["description", "Description"], ["quantity", "Quantity"],
  ["unit", "Unit"], ["unitPriceHt", "Unit price HT"], ["totalHt", "Total HT"],
] as const;
const decimal = (value: string) => /^-?\d+(?:\.\d+)?$/.test(value.trim());
const positiveInteger = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

function RowEvidence({ title, row }: { title: string; row: ExtractionRow | null }) {
  return <section aria-label={title} className="min-w-0 rounded-md border border-border p-3">
    <h4 className="font-semibold mb-2">{title}</h4>
    {row ? <dl className="space-y-2">{fields.map(([key, label]) => <div key={key}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap break-words">{row[key] ?? "Not stated"}</dd>
    </div>)}</dl> : <p className="text-muted-foreground">{title === "After correction" ? "Removed from the active quotation and translated output. Retained in the correction audit." : "No extracted row (missing from extraction)."}</p>}
  </section>;
}

export function ExtractionRowCorrection({ devisId, projectId, lines, disabled = false, compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ExtractionRowRequest["kind"]>("missing");
  const [lineId, setLineId] = useState<number | null>(null);
  const [row, setRow] = useState(blankRow);
  const [page, setPage] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [reason, setReason] = useState("");
  const [reviewedEntirePdf, setReviewedEntirePdf] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [data, setData] = useState<ExtractionRowPreview | null>(null);
  const [error, setError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"pdf" | "form">("form");
  const version = useRef(0);
  const previewLock = useRef(false);
  const submitLock = useRef(false);
  const mounted = useRef(true);
  const id = useId();
  const { toast } = useToast();
  const { preview, correction } = useExtractionRowCorrection(devisId, projectId);
  const quotationLines = lines.filter((line) => line.devisId === devisId);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; version.current++; };
  }, []);
  useEffect(() => {
    if (disabled) {
      version.current++;
      setData(null);
      setReviewed(false);
      if (!submitLock.current) setOpen(false);
    }
  }, [disabled]);

  const invalidate = () => {
    version.current++;
    setData(null);
    setReviewed(false);
    setError("");
  };
  const changeOpen = (next: boolean) => {
    if (submitLock.current || (next && disabled)) return;
    invalidate();
    setOpen(next);
  };
  const pageError = page !== "" && !positiveInteger(page) ? "Enter a whole page number greater than 0 (for example, 2)." : "";
  const validationReasons = kind === "unsupported" ? [
    !quotationLines.some((line) => line.id === lineId) ? "Choose the unsupported extracted row." : "",
    !reviewedEntirePdf ? "Review the entire original PDF and confirm that this item is absent." : "",
    reason.trim().length < 10 ? "Explain why this item is unsupported (at least 10 characters)." : "",
  ].filter(Boolean) : [
    kind === "misread" && !quotationLines.some((line) => line.id === lineId) ? "Choose the extracted row to correct." : "",
    !positiveInteger(row.lineNumber) ? "Enter a whole line number greater than 0." : "",
    !row.description.trim() ? "Enter the row description." : "",
    !decimal(row.totalHt) ? "Enter Total HT using a decimal point." : "",
    row.quantity.trim() && !decimal(row.quantity) ? "Enter a numeric quantity or leave it blank." : "",
    row.unitPriceHt.trim() && !decimal(row.unitPriceHt) ? "Enter a numeric unit price HT or leave it blank." : "",
    !positiveInteger(page) ? (pageError || "Enter the original PDF page number.") : "",
    !excerpt.trim() ? "Copy a verbatim excerpt from the original PDF." : "",
    !reason.trim() ? "Type a reason for this correction." : "",
  ].filter(Boolean);
  const valid = validationReasons.length === 0;
  const originalUrl = `/api/devis/${devisId}/pdf?variant=original`;
  const pdfUrl = positiveInteger(page) ? `${originalUrl}#page=${Number(page)}` : originalUrl;
  const previewDisabledReason = submitting ? "Recording correction; please wait." :
    disabled ? "Corrections are currently unavailable for this quotation." :
    previewing ? "Calculating the financial preview; please wait." :
    !valid ? validationReasons.join(" ") : "";
  const confirmDisabledReason = submitting ? "Recording correction; please wait." :
    disabled ? "Corrections are currently unavailable for this quotation." :
    previewing ? "Wait for the financial preview to finish." :
    !valid ? "Complete the required correction and evidence fields, then generate a financial preview." :
    !data ? "Generate a financial preview before confirming." :
    data.blockedReason !== null ? `Confirmation unavailable: ${data.blockedReason}` :
    !reviewed ? "Review the original PDF and financial preview, then tick the review confirmation." : "";
  const request = (): ExtractionRowRequest => kind === "unsupported" ? ({
    kind, lineId: lineId!, evidence: { reviewedEntirePdf: true }, reason: reason.trim(),
  }) : ({
    kind,
    ...(kind === "misread" && lineId !== null ? { lineId } : {}),
    row: {
      lineNumber: Number(row.lineNumber), description: row.description,
      quantity: row.quantity.trim() || null, unit: row.unit.trim() || null,
      unitPriceHt: row.unitPriceHt.trim() || null, totalHt: row.totalHt.trim(),
    },
    evidence: { page: Number(page), excerpt },
    reason: reason.trim(),
  });
  const getPreview = async () => {
    if (!valid || disabled || previewLock.current || submitLock.current) return;
    previewLock.current = true;
    invalidate();
    const revision = version.current;
    setPreviewing(true);
    try {
      const result = await preview.mutateAsync(request());
      if (mounted.current && revision === version.current) setData(result);
    } catch (cause) {
      if (mounted.current && revision === version.current) {
        setError(cause instanceof Error ? cause.message : "Financial preview failed. Please retry.");
      }
    } finally {
      previewLock.current = false;
      if (mounted.current) setPreviewing(false);
    }
  };
  const canSubmit = valid && !disabled && !!data && data.blockedReason === null && reviewed && !previewing && !submitting;
  const submit = async () => {
    if (submitLock.current || !canSubmit || !data) return;
    submitLock.current = true;
    setSubmitting(true);
    setError("");
    try {
      await correction.mutateAsync({ ...request(), fingerprint: data.fingerprint, confirmed: true });
      if (mounted.current) {
        setOpen(false);
        invalidate();
        setRow(blankRow); setLineId(null); setKind("missing"); setPage(""); setExcerpt(""); setReason(""); setReviewedEntirePdf(false);
        toast({ title: "Extraction corrected", description: "The original contractor PDF and source quotation totals are unchanged." });
      }
    } catch (cause) {
      if (mounted.current) {
        invalidate();
        setError(`${cause instanceof Error ? cause.message : "Correction failed."} Your entries are preserved. Generate a new financial preview before retrying.`);
      }
    } finally {
      submitLock.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  return <>
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => changeOpen(true)}
      className={compact ? "review-source-correction-trigger" : undefined}
      data-testid={`extraction-row-correction-${devisId}`}>{compact && <SlidersHorizontal size={13} />}Correct extraction</Button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-7xl sm:max-w-7xl h-[94dvh] max-h-[94dvh] flex flex-col overflow-hidden gap-3 p-4 sm:p-6"
        onEscapeKeyDown={(event) => { if (submitLock.current) event.preventDefault(); }}
        onInteractOutside={(event) => { if (submitLock.current) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle className="text-base font-black uppercase tracking-tight">Correct extracted quotation row</DialogTitle>
          <DialogDescription>Restore a missing row, repair a misread row, or remove an item absent from the original contractor PDF. This is not a commercial amendment.</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-[#c1a27b]/40 bg-[#c1a27b]/10 p-3 text-xs flex gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-[#0B2545]" />
          <p>The original PDF and source quotation totals remain immutable. Your evidence, reason, before/after rows, actor and timestamp are retained in the audit record. Use an avenant for a commercial change.</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <ol aria-label="Correction steps" className="flex flex-wrap gap-3 font-semibold text-[#0B2545]">
            <li aria-current={!data ? "step" : undefined}>1. Correct</li>
            <li aria-current={data && !reviewed ? "step" : undefined}>2. Preview</li>
            <li aria-current={data && reviewed ? "step" : undefined}>3. Confirm</li>
          </ol>
          <a href={pdfUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline text-[#0B2545]">
            Review original PDF{positiveInteger(page) ? ` · page ${Number(page)}` : ""} · open in new tab
            <ExternalLink aria-hidden="true" className="h-3 w-3" />
          </a>
        </div>
        <div role="tablist" aria-label="Correction workspace" className="flex gap-2 md:hidden"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "pdf" : event.key === "End" ? "form" : mobilePanel === "pdf" ? "form" : "pdf";
            setMobilePanel(next);
            document.getElementById(`${id}-tab-${next}`)?.focus();
          }}>
          {(["pdf", "form"] as const).map((panel) => <button key={panel} type="button" role="tab"
            id={`${id}-tab-${panel}`} aria-controls={`${id}-panel-${panel}`} aria-selected={mobilePanel === panel}
            tabIndex={mobilePanel === panel ? 0 : -1} onClick={() => setMobilePanel(panel)}
            className={`flex-1 rounded-md border px-3 py-2 text-sm font-semibold ${mobilePanel === panel ? "border-[#0B2545] bg-[#0B2545] text-[#faf8f5]" : "border-border bg-background text-foreground"}`}>
            {panel === "pdf" ? "Original PDF" : "Correction form"}
          </button>)}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2 gap-4">
          <section id={`${id}-panel-pdf`} aria-label="Original contractor PDF"
            className={`${mobilePanel === "pdf" ? "flex" : "hidden"} md:flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-muted/30`}>
            <div className="shrink-0 border-b border-border p-3 text-xs">
              <h3 className="font-semibold">Original contractor PDF · authoritative source</h3>
              <p className="mt-1 text-muted-foreground">Compare the printed row with the correction. If the PDF does not display, use “open in new tab” above.</p>
            </div>
            <iframe title="Original contractor PDF" src={pdfUrl} className="min-h-0 w-full flex-1 border-0" />
          </section>
        <div id={`${id}-panel-form`} aria-label="Correction form"
          className={`${mobilePanel === "form" ? "block" : "hidden"} md:block min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain pr-2 pb-2 text-xs`}>
          <h3 className="font-semibold text-sm">1. Correct · transcribe the original</h3>
          <fieldset disabled={submitting || disabled} className="space-y-4">
            <div className="space-y-1">
              <label htmlFor={`${id}-kind`} className="font-semibold">Correction type</label>
              <select id={`${id}-kind`} className="w-full rounded-md border border-input bg-background p-2" value={kind}
                onChange={(event) => { invalidate(); setKind(event.target.value as ExtractionRowRequest["kind"]); setLineId(null); setRow(blankRow); setReviewedEntirePdf(false); }}>
                <option value="missing">Missing row</option>
                <option value="misread">Misread row</option>
                <option value="unsupported">Remove item not present in original PDF</option>
              </select>
            </div>
            {kind !== "missing" && <div className="space-y-1">
              <label htmlFor={`${id}-line`} className="font-semibold">Extracted row to correct (same quotation)</label>
              <select id={`${id}-line`} className="w-full rounded-md border border-input bg-background p-2" value={lineId ?? ""}
                onChange={(event) => {
                  invalidate();
                  const line = quotationLines.find((item) => item.id === Number(event.target.value));
                  setLineId(line?.id ?? null);
                  setReviewedEntirePdf(false);
                  setRow(line ? { lineNumber: String(line.lineNumber), description: line.description, quantity: line.quantity ?? "",
                    unit: line.unit ?? "", unitPriceHt: line.unitPriceHt ?? "", totalHt: line.totalHt } : blankRow);
                }}>
                <option value="">Choose the extracted row…</option>
                {quotationLines.map((line) => <option key={line.id} value={line.id}>#{line.lineNumber} · {line.description}</option>)}
              </select>
              {!quotationLines.length && <p>No extracted rows are available. Choose “Missing row” to restore a row from the PDF.</p>}
            </div>}
            {kind === "unsupported" ? <div className="space-y-3 rounded-md border p-3">
              <p>Only remove an extraction error—not work genuinely quoted by the contractor. The original PDF and source totals will not change. Linked review, context or financial evidence may prevent removal.</p>
              {lineId !== null && <RowEvidence title="Selected item to remove" row={{
                lineNumber: Number(row.lineNumber), description: row.description, quantity: row.quantity || null,
                unit: row.unit || null, unitPriceHt: row.unitPriceHt || null, totalHt: row.totalHt,
              }} />}
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={reviewedEntirePdf} onChange={e => { invalidate(); setReviewedEntirePdf(e.target.checked); }} />
                I reviewed the entire original PDF and confirm this standalone item is not present.
              </label>
            </div> : <><div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {fields.map(([key, label]) => <div key={key} className={`space-y-1 ${key === "description" ? "sm:col-span-2" : ""}`}>
                <label htmlFor={`${id}-${key}`} className="font-semibold">{label}{["lineNumber", "description", "totalHt"].includes(key) ? " (required)" : " (optional)"}</label>
                {key === "description" ? <Textarea id={`${id}-${key}`} rows={3} value={row[key]} onChange={(event) => { invalidate(); setRow({ ...row, [key]: event.target.value }); }} /> :
                  <Input id={`${id}-${key}`} value={row[key]} inputMode={key === "unit" ? "text" : key === "lineNumber" ? "numeric" : "decimal"}
                    onChange={(event) => { invalidate(); setRow({ ...row, [key]: event.target.value }); }} />}
              </div>)}
            </div>
            <p className="text-muted-foreground">Copy values as stated in the PDF. Use a decimal point for numbers; leave unstated optional fields blank. No price or total is inferred.</p>
            </>}
            <div className="space-y-2 border-t border-border pt-3">
              {kind !== "unsupported" && <>
              <label htmlFor={`${id}-page`} className="font-semibold block">Original PDF page (required)</label>
              <Input id={`${id}-page`} inputMode="numeric" value={page} aria-invalid={!!pageError}
                aria-describedby={`${id}-page-help`} onChange={(event) => { invalidate(); setPage(event.target.value); }} />
              <p id={`${id}-page-help`} className={pageError ? "text-destructive" : "text-muted-foreground"}>
                {pageError || "The original is available above without a page number. Enter a positive whole page number to locate your evidence."}
              </p>
              <label htmlFor={`${id}-excerpt`} className="font-semibold block">Verbatim excerpt from the original PDF (required)</label>
              <Textarea id={`${id}-excerpt`} value={excerpt} rows={3} onChange={(event) => { invalidate(); setExcerpt(event.target.value); }} />
              </>}
              <label htmlFor={`${id}-reason`} className="font-semibold block">Typed reason for correcting this extraction (required)</label>
              <Textarea id={`${id}-reason`} value={reason} rows={3} onChange={(event) => { invalidate(); setReason(event.target.value); }} />
            </div>
          </fieldset>
          <h3 className="font-semibold text-sm">2. Preview · check financial impact</h3>
          <Button type="button" variant="outline" size="sm" disabled={!valid || disabled || previewing || submitting}
            aria-describedby={previewDisabledReason ? `${id}-preview-help` : undefined} onClick={() => void getPreview()}>
            {previewing ? "Calculating financial preview…" : "Preview extraction correction"}
          </Button>
          {previewDisabledReason && <p id={`${id}-preview-help`} className="text-muted-foreground">Preview unavailable: {previewDisabledReason}</p>}
          {previewing && <div aria-label="Loading financial preview" className="space-y-2"><Skeleton className="h-5 w-full" /><Skeleton className="h-16 w-full" /></div>}
          {error && <p role="alert" className="text-destructive whitespace-pre-wrap break-words">{error}</p>}
          {data && <section aria-label="Server financial preview" className="rounded-lg border border-border p-3 space-y-3">
            <h3 className="font-semibold">Financial impact · server calculation</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <RowEvidence title="Before correction" row={data.before} />
              <RowEvidence title="After correction" row={data.after} />
            </div>
            <dl className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-x-3 gap-y-2">
              {([
                ["Source total HT · immutable", data.sourceTotalHt], ["Source total TTC · immutable", data.sourceTotalTtc],
                ["Active line sum HT · before", data.beforeSumHt], ["Active line sum HT · after", data.afterSumHt],
                ["Discrepancy HT · before", data.discrepancyBeforeHt], ["Discrepancy HT · after", data.discrepancyAfterHt],
              ] as const).map(([label, value]) => <div key={label} className="contents"><dt>{label}</dt><dd className="font-mono break-words">{value} EUR</dd></div>)}
            </dl>
            <p className="text-muted-foreground">Source totals are never adjusted to match the working sum. Options, discounts and tax conventions are handled by the server.</p>
            {data.blockedReason !== null && <p role="alert" className="text-destructive font-semibold">Correction refused: {data.blockedReason}</p>}
            <label className="flex gap-2 items-start">
              <input type="checkbox" checked={reviewed} disabled={submitting || disabled || data.blockedReason !== null}
                onChange={(event) => setReviewed(event.target.checked)} className="mt-0.5" />
              <span>{kind === "unsupported"
                ? "I have reviewed the removal and financial impact. This item is absent from the original PDF, not a change to the contractor's scope. I confirm its removal from the active quotation."
                : "I have reviewed the original contractor PDF, checked the page, verbatim excerpt and all before/after fields. This only corrects the extraction and is not a commercial amendment."}</span>
            </label>
          </section>}
          <h3 className="font-semibold text-sm">3. Confirm · record the correction</h3>
          {confirmDisabledReason && <p id={`${id}-confirm-help`} className="text-muted-foreground">{confirmDisabledReason}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end border-t border-border pt-3">
            <Button type="button" variant="outline" disabled={submitting} onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="button" disabled={!canSubmit} aria-describedby={confirmDisabledReason ? `${id}-confirm-help` : undefined}
              onClick={() => void submit()}>{submitting ? "Recording correction…" : "Confirm extraction correction"}</Button>
          </div>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}