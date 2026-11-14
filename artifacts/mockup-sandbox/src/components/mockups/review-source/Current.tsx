// Source extraction, not a redesign.
// Provenance: client/src/components/devis/DevisTab.tsx:6346–6440, 6450–6490.
// Review JSX: client/src/components/devis/QuotationExtractionReview.tsx.
// Related entry controls: DuplicateExtractionHistory.tsx, ArchitectQuotationEditor.tsx,
// ExtractionRowCorrection.tsx. API, router and editing actions are sandbox-only stubs.
import "./_group.css";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ClipboardCheck, ExternalLink, FileText, History, Pencil, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  reviewCategories, reviewOutcomes, useQuotationExtractionReview, fixture,
  type ExtractionReviewRequest, type ExtractionCandidateApplyRequest,
} from "./fixtures";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function label(value: string | null, names: Record<string, string>) {
  return value ? names[value] ?? value.replace(/_/g, " ") : "Not stated";
}
// Unknown evidence is displayed as text, never interpreted as HTML or a verdict.
function EvidenceValue({ value }: { value: unknown }) {
  if (value == null) return <span className="text-muted-foreground">Not stated</span>;
  if (Array.isArray(value)) return <ul className="space-y-2">{value.map((item, index) =>
    <li key={index} className="border-l border-border pl-2"><EvidenceValue value={item} /></li>)}</ul>;
  if (typeof value === "object") return <dl className="space-y-1">{Object.entries(object(value)).map(([key, item]) =>
    <div key={key}><dt className="text-muted-foreground">{key.replace(/_/g, " ")}</dt>
      <dd className="whitespace-pre-wrap break-words"><EvidenceValue value={item} /></dd></div>)}</dl>;
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}
function Loading({ title }: { title: string }) {
  return <div aria-label={title} role="status" className="space-y-2">
    <span className="sr-only">{title}</span><Skeleton className="h-5 w-2/3" /><Skeleton className="h-16 w-full" />
  </div>;
}
function Retry({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return <div role="alert" className="space-y-2">
    <p className="text-destructive break-words">{error.message}</p>
    <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button>
  </div>;
}

function CandidateApproval({ attemptId, disabled, archived, pending, error, onApply }: {
  attemptId: number;
  disabled: boolean;
  archived: boolean;
  pending: boolean;
  error: Error | null;
  onApply: (request: ExtractionCandidateApplyRequest) => Promise<void>;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [reviewedOriginal, setReviewedOriginal] = useState(false);
  const [ocrErrors, setOcrErrors] = useState(false);
  const lock = useRef(false);
  const valid = reason.trim().length >= 12 && reviewedOriginal && ocrErrors;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || pending || !valid || lock.current) return;
    lock.current = true;
    try {
      await onApply({ attemptId, reason: reason.trim(), reviewedOriginal: true, initialDifferencesAreOcrErrors: true });
    } catch { /* Preserve entries and declarations after server rejection. */ }
    finally { lock.current = false; }
  };
  return <form onSubmit={submit} className="space-y-3 border-t border-border pt-3">
    <fieldset disabled={disabled || pending} className="space-y-3">
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={reviewedOriginal} className="mt-0.5"
          onChange={(event) => setReviewedOriginal(event.target.checked)} />
        <span>I have reviewed the original source PDF and compared the source segments, initial OCR passages and proposed rows.</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={ocrErrors} className="mt-0.5"
          onChange={(event) => setOcrErrors(event.target.checked)} />
        <span>The differing initial OCR passages are extraction errors, not changes to the contractor’s original quotation.</span>
      </label>
      <div className="space-y-1">
        <label htmlFor={`${id}-apply-reason`} className="font-semibold">Candidate approval reason (at least 12 characters)</label>
        <Textarea id={`${id}-apply-reason`} required minLength={12} value={reason} rows={3}
          onChange={(event) => setReason(event.target.value)} placeholder="Explain why the differing initial passages are OCR errors, citing the source PDF." />
        <p className="text-muted-foreground">Both declarations and a reason of at least 12 non-padding characters are required.</p>
      </div>
      <Button type="submit" size="sm" disabled={disabled || pending || !valid}>
        {pending ? "Applying prepared candidate…" : "Approve and apply prepared candidate"}
      </Button>
    </fieldset>
    {archived && <p className="text-muted-foreground">Archived project: candidate review is read-only. Existing permissions still apply.</p>}
    {disabled && !archived && <p className="text-muted-foreground">Candidate approval is unavailable while another review is being recorded or the proposed rows / source link are unavailable.</p>}
    {error && <p role="alert" className="text-destructive whitespace-pre-wrap break-words">
      {error.message} The application was rejected; original PDF and current rows are unchanged.
      Your reason and declarations are preserved. Review the source findings before retrying.
    </p>}
  </form>;
}

export function QuotationExtractionReview({ devisId, projectId, disabled = false }: { devisId: number; projectId: string; disabled?: boolean }) {
  const id = useId();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [outcome, setOutcome] = useState<ExtractionReviewRequest["outcome"]>("unresolved");
  const [category, setCategory] = useState<ExtractionReviewRequest["category"]>("other");
  const [reason, setReason] = useState("");
  const [effort, setEffort] = useState("0");
  const [saved, setSaved] = useState(false);
  const submitLock = useRef(false);
  const [appliedAttemptId, setAppliedAttemptId] = useState<number | null>(null);
  const { review, summary, record, apply } = useQuotationExtractionReview(devisId, days, projectId);
  const verification = object(object(review.data?.evidence).quotationVerification);
  const manifest = object(verification.manifest);
  const segments = entries(manifest.segments);
  const sections = entries(manifest.sections);
  const failures = entries(verification.failures);
  const issues = entries(object(verification.coverage).issues);
  const sourceFindings = verification.sourceFindings;
  const comparisons = entries(verification.initialComparison);
  const proposedRows = entries(verification.proposedLineItems);
  const candidateAttemptId = review.data?.candidateAttemptId;
  const candidatePending = typeof candidateAttemptId === "number" && Number.isSafeInteger(candidateAttemptId)
    && candidateAttemptId > 0 && candidateAttemptId !== appliedAttemptId;
  const validEffort = /^\d+$/.test(effort) && Number.isSafeInteger(Number(effort));
  const valid = !!reason.trim() && validEffort;
  let sourceUrl: string | undefined;
  if (review.data?.sourcePdfUrl) {
    try {
      const url = new URL(review.data.sourcePdfUrl, window.location.origin);
      if (url.origin === window.location.origin && ["http:", "https:"].includes(url.protocol)) {
        url.searchParams.set("variant", "original");
        sourceUrl = `${url.pathname}${url.search}${url.hash}`;
      }
    } catch { /* Invalid URLs are not rendered as links. */ }
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || disabled || record.isPending || apply.isPending || submitLock.current || !review.data || review.isError) return;
    submitLock.current = true;
    setSaved(false);
    try {
      await record.mutateAsync({ outcome, category, reason: reason.trim(), effortMinutes: Number(effort) });
      setSaved(true);
      setReason("");
      setEffort("0");
    } catch { /* Mutation error is shown inline; all entries are preserved. */ }
    finally { submitLock.current = false; }
  };
  const editing = () => { setSaved(false); record.reset(); };

  return <section aria-label="Quotation extraction review" data-testid={`quotation-extraction-review-${devisId}`}
    className="border-b border-border/40 px-3 py-3 text-xs space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-[#0B2545]">
        <ClipboardCheck className="h-4 w-4" />Extraction review
      </h3>
      {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-1 underline text-[#0B2545]">Open original contractor PDF<ExternalLink className="h-3 w-3" /></a>}
    </div>
    <p className="rounded-lg border border-[#c1a27b]/40 bg-[#c1a27b]/10 p-3 text-muted-foreground">
      Matching TTC totals do not establish that descriptions, quantities or their associations are correct.
      Compare with the original PDF. Recording a review does not change quotation rows, commercial terms or permissions.
      Use the existing extraction correction controls or approve a prepared candidate below to repair rows;
      “Corrected” in the review form records a review outcome only.
    </p>
    {review.isPending ? <Loading title="Loading extraction evidence" /> : review.isError ?
      <Retry error={review.error} onRetry={() => void review.refetch()} /> : review.data && <>
        {!sourceUrl && <p className="text-muted-foreground">Source PDF link unavailable.</p>}
        {review.data?.running && <p role="status">Checking source sections. The original quotation remains unchanged until the candidate passes review.</p>}
        <details className="rounded-lg border border-[#c1a27b]/40 bg-[#c1a27b]/[0.04] p-3" open={candidatePending}>
          <summary className="cursor-pointer font-semibold">
            Prepared candidate · {candidatePending ? `Pending approval (attempt ${candidateAttemptId})` :
              appliedAttemptId !== null ? `Applied (attempt ${appliedAttemptId})` : "No pending candidate"}
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-muted-foreground">
              Approval is not freehand editing and only waives differences from the initial OCR extraction.
              It does not permit you to waive source failures. The server revalidates the independent source inventory
              and refuses uncertain source evidence or locked evidence. On rejection, the original PDF and current rows remain unchanged.
            </p>
            {!!comparisons.length && <section aria-label="Initial OCR differences" className="space-y-2">
              <h4 className="font-semibold">Initial OCR compared with the original source</h4>
              {comparisons.map((comparison, index) => {
                const item = object(comparison);
                return <article key={index} className="rounded-md border border-border p-3 space-y-2">
                  <p className="font-mono text-[10px]">Page {String(item.page ?? "not supplied")} · Section {String(item.section ?? "not supplied")} · Status {String(item.status ?? "not supplied")}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div><h5 className="font-semibold mb-1">Initial OCR row / passage</h5>
                      <EvidenceValue value={item.initialRow} /><EvidenceValue value={item.initialText ?? item.sourceText} /></div>
                    <div><h5 className="font-semibold mb-1">Independently collected source passage</h5>
                      <EvidenceValue value={item.initialText != null ? item.sourceText : null} />
                      <EvidenceValue value={item.sourceRegions} /></div>
                  </div>
                </article>;
              })}
            </section>}
            {candidatePending && !comparisons.length && <p className="text-muted-foreground">No initial OCR comparisons supplied. Compare every proposed row against the original PDF.</p>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <section aria-label="Candidate original source segments" className="rounded-md border border-border p-3 space-y-2 min-w-0">
                <h4 className="font-semibold">Original source segments</h4>
                {!segments.length && <p className="text-muted-foreground">No independent source segments supplied.</p>}
                {segments.map((segment, index) => <article key={index} className="border-b border-border pb-2"><EvidenceValue value={segment} /></article>)}
              </section>
              <section aria-label="Prepared candidate rows" className="rounded-md border border-border p-3 space-y-2 min-w-0">
                <h4 className="font-semibold">Proposed rows · full descriptions & amounts</h4>
                {!proposedRows.length && <p className="text-muted-foreground">No proposed rows supplied. Candidate application is unavailable.</p>}
                {proposedRows.map((row, index) => {
                  const item = object(row);
                  const section = sections.map(object).find((entry) => typeof item.section === "string" && entry.id === item.section);
                  const page = item.page ?? item.sourcePage ?? object(section?.priceRegion).page;
                  return <article key={index} className="border-b border-border pb-2 space-y-1">
                    <h5 className="font-semibold">Proposed row {index + 1} · Page {String(page ?? "not supplied")}</h5>
                    <EvidenceValue value={row} />
                  </article>;
                })}
              </section>
            </div>
            {!!failures.length && <div><h4 className="font-semibold">Source / extraction findings · cannot be waived by this approval</h4><EvidenceValue value={failures} /></div>}
            {!!issues.length && <div><h4 className="font-semibold">Coverage findings</h4><EvidenceValue value={issues} /></div>}
            {sourceFindings != null && <div><h4 className="font-semibold">Independent source findings</h4><EvidenceValue value={sourceFindings} /></div>}
            {candidatePending && <CandidateApproval key={candidateAttemptId} attemptId={candidateAttemptId}
              archived={disabled}
              disabled={disabled || !proposedRows.length || !sourceUrl || review.isError || record.isPending}
              pending={apply.isPending} error={apply.error} onApply={async (request) => {
                if (disabled || review.isError || record.isPending) return;
                await apply.mutateAsync(request);
                setAppliedAttemptId(request.attemptId);
              }} />}
            {appliedAttemptId !== null && <p role="status">Prepared candidate attempt {appliedAttemptId} applied. The original source PDF is unchanged.</p>}
          </div>
        </details>
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer font-semibold">Source inventory & discrepancy evidence · {segments.length} segments</summary>
          <div className="mt-3 space-y-4">
            <p className="text-muted-foreground">Automated evidence is not a human verification of the extraction.</p>
            <section aria-label="Source inventory" className="space-y-2">
              <h4 className="font-semibold">Source inventory</h4>
              {!segments.length && <p className="text-muted-foreground">No source segments supplied. Review the original PDF directly.</p>}
              {segments.map((segment, index) => {
                const item = object(segment);
                return <article key={index} className="rounded-md border border-border p-2 space-y-1">
                  <p className="font-mono text-[10px]">Segment {String(item.id ?? index + 1)} · Page {String(item.page ?? "not stated")} · Section {String(item.section ?? "not stated")}</p>
                  <p className="text-muted-foreground">Classification: {String(item.disposition ?? "not stated")}</p>
                  <EvidenceValue value={item.text ?? segment} />
                  {item.classificationReason != null && <p className="text-muted-foreground">Classification reason: <EvidenceValue value={item.classificationReason} /></p>}
                </article>;
              })}
              {!!sections.length && <details><summary className="cursor-pointer">Source sections & price regions</summary><EvidenceValue value={sections} /></details>}
              {manifest.inventoriedPages != null && <div>Inventoried pages: <EvidenceValue value={manifest.inventoriedPages} /></div>}
            </section>
            <section aria-label="Discrepancy details" className="space-y-2">
              <h4 className="font-semibold">Discrepancy details</h4>
              {!failures.length && !issues.length && <p className="text-muted-foreground">No discrepancies supplied. This does not establish that the extraction is accurate.</p>}
              {!!failures.length && <div><p className="font-semibold mb-1">Failures</p><EvidenceValue value={failures} /></div>}
              {!!issues.length && <div><p className="font-semibold mb-1">Coverage issues</p><EvidenceValue value={issues} /></div>}
            </section>
          </div>
        </details>
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer font-semibold">Record a review outcome</summary>
          <form onSubmit={submit} className="mt-3 space-y-3">
            <fieldset disabled={disabled || record.isPending || apply.isPending} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1"><label htmlFor={`${id}-outcome`} className="font-semibold">Review outcome</label>
                  <select id={`${id}-outcome`} value={outcome} className="w-full rounded-md border border-input bg-background p-2"
                    onChange={(event) => { editing(); setOutcome(event.target.value as ExtractionReviewRequest["outcome"]); }}>
                    {Object.entries(reviewOutcomes).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                  </select>
                </div>
                <div className="space-y-1"><label htmlFor={`${id}-category`} className="font-semibold">Review category</label>
                  <select id={`${id}-category`} value={category} className="w-full rounded-md border border-input bg-background p-2"
                    onChange={(event) => { editing(); setCategory(event.target.value as ExtractionReviewRequest["category"]); }}>
                    {Object.entries(reviewCategories).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                  </select>
                </div>
              </div>
              <div className="space-y-1"><label htmlFor={`${id}-reason`} className="font-semibold">Review reason (required)</label>
                <Textarea id={`${id}-reason`} required rows={3} value={reason}
                  onChange={(event) => { editing(); setReason(event.target.value); }}
                  placeholder="Describe what you compared with the PDF and what remains incorrect or uncertain." /></div>
              <div className="space-y-1"><label htmlFor={`${id}-effort`} className="font-semibold">Review effort (minutes)</label>
                <Input id={`${id}-effort`} type="number" min={0} step={1} required value={effort}
                  onChange={(event) => { editing(); setEffort(event.target.value); }} className="md:max-w-48" />
                {!validEffort && <p className="text-destructive">Enter a nonnegative whole number of minutes.</p>}
              </div>
              <Button type="submit" size="sm" disabled={!valid || disabled || record.isPending}>{record.isPending ? "Recording review…" : "Record review"}</Button>
            </fieldset>
            {disabled && <p className="text-muted-foreground">Review recording is unavailable while this project is archived. Existing permissions still apply.</p>}
            {record.isError && <p role="alert" className="text-destructive">{record.error.message} Your entries are preserved. Retry recording the review.</p>}
            {saved && <p role="status">Review recorded. Quotation rows and source totals are unchanged.</p>}
          </form>
        </details>
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer font-semibold">Review history · {review.data.events.length} events</summary>
          <div className="mt-3 space-y-2">
            {!review.data.events.length && <p className="text-muted-foreground">No review events recorded. This extraction has not been marked as reviewed.</p>}
            {review.data.events.map((event) => <article key={event.id} className="border-l-2 border-[#c1a27b]/60 pl-3 space-y-1">
              <p className="font-semibold">{label(event.outcome, reviewOutcomes)} · {label(event.category, reviewCategories)}</p>
              <p className="text-muted-foreground">{event.kind} · {Number.isNaN(Date.parse(event.created_at)) ? event.created_at : new Date(event.created_at).toLocaleString()} · {event.effort_minutes ?? 0} min</p>
              <p className="whitespace-pre-wrap break-words">{event.reason || "No reason supplied."}</p>
            </article>)}
          </div>
        </details>
      </>}
    <section aria-label="Extraction monitoring" className="rounded-lg border border-[#0B2545]/15 bg-[#0B2545]/[0.03] p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Extraction monitoring · accessible quotations</h4>
        <div className="flex items-center gap-2"><label htmlFor={`${id}-days`}>Period</label>
          <select id={`${id}-days`} value={days} className="rounded-md border border-input bg-background p-1.5"
            onChange={(event) => setDays(Number(event.target.value) as 7 | 30 | 90)}>
            {[7, 30, 90].map((value) => <option key={value} value={value}>Last {value} days</option>)}
          </select>
        </div>
      </div>
      {summary.isPending ? <Loading title="Loading extraction monitoring" /> : summary.isError ?
        <Retry error={summary.error} onRetry={() => void summary.refetch()} /> : summary.data && <>
          {summary.data.processed === 0 && <p className="text-muted-foreground">No processed quotations in this period.</p>}
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {([
              ["Processed", summary.data.processed], ["Reviewed", summary.data.reviewed],
              ["Confirmed inaccurate", summary.data.inaccurate], ["Repeat failures", summary.data.repeatFailures],
              ["Review effort (minutes)", summary.data.effortMinutes],
            ] as const).map(([text, count]) => <div key={text} className="flex justify-between gap-2 border-b border-border/50 py-1"><dt>{text}</dt><dd className="font-mono font-semibold">{count}</dd></div>)}
          </dl>
          <div className="space-y-1"><h5 className="font-semibold">Categories</h5>
            {!summary.data.categories.length ? <p className="text-muted-foreground">No category counts recorded for this period.</p> :
              <ul className="space-y-1">{summary.data.categories.map((item) => <li key={item.category} className="flex justify-between gap-2">
                <span>{label(item.category, reviewCategories)}</span><span className="font-mono">{item.count}</span>
              </li>)}</ul>}
          </div>
          <p className="text-muted-foreground">Unreviewed extractions are not verified. Counts reflect recorded reviews, not proof of accuracy; permissions are unchanged.</p>
        </>}
    </section>
  </section>;
}

/** Source: DuplicateExtractionHistory.tsx:57–109. Empty-history fixture; no API requests. */
export function DuplicateExtractionHistory({ devisId }: { devisId: number }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <section className="rounded-lg border border-border/60" aria-label="Duplicate extraction correction history">
      <button type="button"
        className="flex w-full items-center gap-2 p-3 text-left text-[11px] font-bold uppercase tracking-widest hover:bg-muted/20 rounded-lg"
        aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}
        data-testid={`toggle-duplicate-extraction-history-${devisId}`}>
        <History className="h-4 w-4 shrink-0 text-[#c1a27b]" aria-hidden="true" />
        <span className="flex-1">Duplicate extraction correction history</span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      <div id={panelId} hidden={!open}>
        {open && <div className="space-y-3 border-t border-border/60 p-3 text-xs">
          <p className="text-muted-foreground">Read-only correction record. The contractor PDF and source quotation totals remain unchanged.</p>
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-4">
            <p className="font-semibold">No duplicate extraction corrections recorded.</p>
            <p className="mt-1 text-muted-foreground">Any confirmed correction will appear here with its reason and financial reconciliation.</p>
          </div>
        </div>}
      </div>
    </section>
  );
}

/** Source: ArchitectQuotationEditor.tsx entry banner. Editor action intentionally stubbed. */
export function ArchitectQuotationEditor({ devisId, disabled = false }: { devisId: number; projectId?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="architect-correction px-3 py-3" data-testid={`architect-correction-entry-${devisId}`}>
      <div className="correction-banner rounded-lg flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-start gap-3">
          <Pencil size={15} className="mt-0.5 shrink-0" />
          <div><p className="text-xs font-semibold">Architects working version</p>
            <p className="text-[11px] text-muted-foreground mt-1">Correct descriptions, translations and figures. The contractor’s original PDF remains the legal reference.</p>
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} disabled={disabled}
          className="border-[#94734c]/40 bg-[#f8f5ef] text-[#0b2545] text-[11px] gap-2 shrink-0">
          <Pencil size={13} /> Edit working quotation
        </Button>
      </div>
    </div>
    <StubActionDialog open={open} onOpenChange={setOpen} title="Review the interpretation. Keep the original."
      description="Sandbox extraction: the working quotation editor is not connected. No quotation rows or source totals will be changed." />
  </>;
}

/** Source: ExtractionRowCorrection.tsx entry Button. Correction action intentionally stubbed. */
export function ExtractionRowCorrection({ devisId, disabled = false }: { devisId: number; projectId?: string; lines?: typeof fixture.lines; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}
      data-testid={`extraction-row-correction-${devisId}`}>Correct missing / misread extraction</Button>
    <StubActionDialog open={open} onOpenChange={setOpen} title="Correct extracted quotation row"
      description="Sandbox extraction: row correction is not connected. Restore a missing row or repair a misread row using the original contractor PDF in the application." />
  </>;
}

function StubActionDialog({ open, onOpenChange, title, description }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
  </DialogContent></Dialog>;
}

/** Exact review-section composition, with route/API entry points replaced by local dialogs. */
export function ReviewSourceSection({ children }: { children: ReactNode }) {
  // Source: DevisWorkflow.tsx:227–240. Workflow context replaced with local state.
  const [open, setOpen] = useState(true);
  const id = useId();
  return <section className="devis-workflow__group" data-group="review" aria-labelledby={`${id}-heading`}>
    <button id={`${id}-heading`} type="button" className="devis-workflow__heading" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <span className="devis-workflow__number">01</span>
      <strong>Review source</strong><small>Source &amp; extraction · {fixture.lines.length} lines</small>
    </button>
    <div id={`${id}-body`} hidden={!open} className="devis-workflow__body">{children}</div>
  </section>;
}

export function Current() {
  const devis = fixture.devis;
  const [rescrapeConfirmOpen, setRescrapeConfirmOpen] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  return <div className="review-source min-h-screen bg-background text-foreground" onClick={(event) => {
    const link = (event.target as HTMLElement).closest("a");
    if (link?.hash === "#original-contractor-pdf") {
      event.preventDefault();
      setAction("Open original contractor PDF");
    }
  }}>
    <ReviewSourceSection>
    <div className="flex items-center justify-between gap-2 pt-1" data-testid={`header-devis-detail-${devis.id}`}>
      <span className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground">Devis Document</span>
      <TooltipProvider delayDuration={200}>
        <div className="flex items-center gap-2">
          <Tooltip><TooltipTrigger asChild><span className="inline-flex">
            <Button type="button" size="sm" variant="outline"
              className="h-8 gap-1.5 text-[11px] font-bold uppercase tracking-widest"
              onClick={() => setRescrapeConfirmOpen(true)} data-testid={`button-rescrape-pdf-${devis.id}`}>
              <RefreshCw size={13} />Re-scrape
            </Button>
          </span></TooltipTrigger><TooltipContent side="top" className="text-[10px] max-w-[240px]">
            Re-run AI extraction on the stored PDF. Replaces line items and amounts; keeps your manual edits to the devis code, contractor, lot and status.
          </TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><span className="inline-flex">
            <Button type="button" size="sm" variant="default"
              className="h-8 gap-1.5 bg-[#0B2545] hover:bg-[#0B2545]/90 text-white text-[11px] font-bold uppercase tracking-widest"
              onClick={() => setAction("View PDF")} data-testid={`button-view-pdf-prominent-${devis.id}`}>
              <FileText size={13} />View PDF
            </Button>
          </span></TooltipTrigger></Tooltip>
          <Tooltip><TooltipTrigger asChild>
            <a href="#document-chain" onClick={(event) => { event.preventDefault(); setAction("Document Chain"); }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-[11px] font-bold uppercase tracking-widest hover:bg-accent hover:text-accent-foreground"
              data-testid={`link-document-chain-${devis.id}`}><FileText size={13} />Chain</a>
          </TooltipTrigger><TooltipContent side="top" className="text-[10px]">Document Chain — devis → situations → factures → certificats</TooltipContent></Tooltip>
          {devis.driveWebViewLink && <Tooltip><TooltipTrigger asChild>
            <a href="#drive" onClick={(event) => { event.preventDefault(); setAction("Open in Renosud shared Drive"); }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-[11px] font-bold uppercase tracking-widest hover:bg-accent hover:text-accent-foreground"
              data-testid={`link-view-on-drive-${devis.id}`}><FileText size={13} />Drive</a>
          </TooltipTrigger><TooltipContent side="top" className="text-[10px]">Open in Renosud shared Drive</TooltipContent></Tooltip>}
        </div>
      </TooltipProvider>
    </div>
    <DuplicateExtractionHistory key={devis.id} devisId={devis.id} />
    <ArchitectQuotationEditor key={`architect-editor-${devis.id}`} devisId={devis.id} projectId={fixture.projectId} disabled={false} />
    <div className="flex justify-end px-3 py-2 border-b border-border/40">
      <ExtractionRowCorrection key={devis.id} devisId={devis.id} projectId={fixture.projectId} lines={fixture.lines} disabled={false} />
    </div>
    <QuotationExtractionReview key={`review-${devis.id}`} devisId={devis.id} projectId={fixture.projectId} disabled={false} />
    </ReviewSourceSection>
    <AlertDialog open={rescrapeConfirmOpen} onOpenChange={setRescrapeConfirmOpen}>
      <AlertDialogContent data-testid={`dialog-confirm-rescrape-${devis.id}`}>
        <AlertDialogHeader><AlertDialogTitle>Re-scrape this devis?</AlertDialogTitle>
          <AlertDialogDescription>
            The AI will read <span className="font-semibold">{devis.devisCode}</span> again and
            replace its current line items and totals with whatever it
            extracts. Your manual edits to the devis code, contractor, lot
            and status will be kept. This usually takes a few seconds.
            {" "}Previous duplicate-extraction corrections will not be automatically reapplied.
            Review the new extraction against the original PDF before confirming it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid={`button-confirm-rescrape-${devis.id}`}
            onClick={() => setAction("Re-scrape")}>Re-scrape</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <StubActionDialog open={action !== null} onOpenChange={(open) => { if (!open) setAction(null); }}
      title={action ?? ""} description="Sandbox extraction: this action is not connected to application APIs or external documents. No data has been changed." />
  </div>;
}
