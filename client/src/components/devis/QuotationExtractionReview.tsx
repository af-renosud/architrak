import { useId, useRef, useState, type FormEvent } from "react";
import { ClipboardCheck, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  reviewCategories, reviewOutcomes, useQuotationExtractionReview,
  type ExtractionReviewRequest, type ExtractionCandidateApplyRequest,
} from "./use-quotation-extraction-review";

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