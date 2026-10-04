import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";
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
    </div>)}</dl> : <p className="text-muted-foreground">No extracted row (missing from extraction).</p>}
  </section>;
}

export function ExtractionRowCorrection({ devisId, projectId, lines, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ExtractionRowRequest["kind"]>("missing");
  const [lineId, setLineId] = useState<number | null>(null);
  const [row, setRow] = useState(blankRow);
  const [page, setPage] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [data, setData] = useState<ExtractionRowPreview | null>(null);
  const [error, setError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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
  const valid = positiveInteger(row.lineNumber) && !!row.description.trim() && decimal(row.totalHt) &&
    (!row.quantity.trim() || decimal(row.quantity)) && (!row.unitPriceHt.trim() || decimal(row.unitPriceHt)) &&
    positiveInteger(page) && !!excerpt.trim() && !!reason.trim() &&
    (kind === "missing" || quotationLines.some((line) => line.id === lineId));
  const request = (): ExtractionRowRequest => ({
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
        setRow(blankRow); setLineId(null); setKind("missing"); setPage(""); setExcerpt(""); setReason("");
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
      data-testid={`extraction-row-correction-${devisId}`}>Correct missing / misread extraction</Button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto"
        onEscapeKeyDown={(event) => { if (submitLock.current) event.preventDefault(); }}
        onInteractOutside={(event) => { if (submitLock.current) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle className="text-base font-black uppercase tracking-tight">Correct extracted quotation row</DialogTitle>
          <DialogDescription>Restore a missing row or repair a misread row using the original contractor PDF. This is not a commercial amendment.</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-[#c1a27b]/40 bg-[#c1a27b]/10 p-3 text-xs flex gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-[#0B2545]" />
          <p>The original PDF and source quotation totals remain immutable. Your evidence, reason, before/after rows, actor and timestamp are retained in the audit record. Use an avenant for a commercial change.</p>
        </div>
        <div className="space-y-4 text-xs">
          <fieldset disabled={submitting || disabled} className="space-y-4">
            <div className="space-y-1">
              <label htmlFor={`${id}-kind`} className="font-semibold">Correction type</label>
              <select id={`${id}-kind`} className="w-full rounded-md border border-input bg-background p-2" value={kind}
                onChange={(event) => { invalidate(); setKind(event.target.value as ExtractionRowRequest["kind"]); setLineId(null); setRow(blankRow); }}>
                <option value="missing">Missing row</option>
                <option value="misread">Misread row</option>
              </select>
            </div>
            {kind === "misread" && <div className="space-y-1">
              <label htmlFor={`${id}-line`} className="font-semibold">Extracted row to correct (same quotation)</label>
              <select id={`${id}-line`} className="w-full rounded-md border border-input bg-background p-2" value={lineId ?? ""}
                onChange={(event) => {
                  invalidate();
                  const line = quotationLines.find((item) => item.id === Number(event.target.value));
                  setLineId(line?.id ?? null);
                  setRow(line ? { lineNumber: String(line.lineNumber), description: line.description, quantity: line.quantity ?? "",
                    unit: line.unit ?? "", unitPriceHt: line.unitPriceHt ?? "", totalHt: line.totalHt } : blankRow);
                }}>
                <option value="">Choose the misread row…</option>
                {quotationLines.map((line) => <option key={line.id} value={line.id}>#{line.lineNumber} · {line.description}</option>)}
              </select>
              {!quotationLines.length && <p>No extracted rows are available. Choose “Missing row” to restore a row from the PDF.</p>}
            </div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {fields.map(([key, label]) => <div key={key} className={`space-y-1 ${key === "description" ? "sm:col-span-2" : ""}`}>
                <label htmlFor={`${id}-${key}`} className="font-semibold">{label}{["lineNumber", "description", "totalHt"].includes(key) ? " (required)" : " (optional)"}</label>
                {key === "description" ? <Textarea id={`${id}-${key}`} rows={3} value={row[key]} onChange={(event) => { invalidate(); setRow({ ...row, [key]: event.target.value }); }} /> :
                  <Input id={`${id}-${key}`} value={row[key]} inputMode={key === "unit" ? "text" : key === "lineNumber" ? "numeric" : "decimal"}
                    onChange={(event) => { invalidate(); setRow({ ...row, [key]: event.target.value }); }} />}
              </div>)}
            </div>
            <p className="text-muted-foreground">Copy values as stated in the PDF. Use a decimal point for numbers; leave unstated optional fields blank. No price or total is inferred.</p>
            <div className="space-y-2 border-t border-border pt-3">
              <label htmlFor={`${id}-page`} className="font-semibold block">Original PDF page (required)</label>
              <Input id={`${id}-page`} inputMode="numeric" value={page} onChange={(event) => { invalidate(); setPage(event.target.value); }} />
              {positiveInteger(page) ? <a href={`/api/devis/${devisId}/pdf?variant=original#page=${Number(page)}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline text-[#0B2545]">Review original PDF · page {Number(page)}<ExternalLink className="h-3 w-3" /></a> :
                <p className="text-muted-foreground">Enter a page number to open the original PDF at the evidence page.</p>}
              <label htmlFor={`${id}-excerpt`} className="font-semibold block">Verbatim excerpt from the original PDF (required)</label>
              <Textarea id={`${id}-excerpt`} value={excerpt} rows={3} onChange={(event) => { invalidate(); setExcerpt(event.target.value); }} />
              <label htmlFor={`${id}-reason`} className="font-semibold block">Typed reason for correcting this extraction (required)</label>
              <Textarea id={`${id}-reason`} value={reason} rows={3} onChange={(event) => { invalidate(); setReason(event.target.value); }} />
            </div>
          </fieldset>
          <Button type="button" variant="outline" size="sm" disabled={!valid || disabled || previewing || submitting} onClick={() => void getPreview()}>
            {previewing ? "Calculating financial preview…" : "Preview extraction correction"}
          </Button>
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
              <span>I have reviewed the original contractor PDF, checked the page, verbatim excerpt and all before/after fields. This only corrects the extraction and is not a commercial amendment.</span>
            </label>
          </section>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end border-t border-border pt-3">
            <Button type="button" variant="outline" disabled={submitting} onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>{submitting ? "Recording correction…" : "Confirm extraction correction"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}