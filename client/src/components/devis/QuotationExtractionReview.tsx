import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, ClipboardCheck, ExternalLink, Pencil, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QuotationExceptions } from "./QuotationExceptions";
import { quotationFieldLabel } from "./quotation-review-labels";
import "./review-source.css";
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
    <div key={key}><dt className="text-muted-foreground">{quotationFieldLabel(key)}</dt>
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
function NativeSourcePassage({ entry, sourceUrl }: { entry: Record<string, unknown>; sourceUrl?: string }) {
  const pages = entries(entry.pages).filter((page): page is number =>
    typeof page === "number" && Number.isSafeInteger(page) && page > 0);
  return <div className="space-y-2">
    <div><h5 className="font-semibold">Original PDF text</h5><EvidenceValue value={entry.sourceText} /></div>
    {entry.priceText != null && <div><h5 className="font-semibold">Original PDF price</h5><EvidenceValue value={entry.priceText} /></div>}
    {!pages.length && <p className="text-muted-foreground">Original page not supplied. Compare with the full original PDF.</p>}
    {pages.map(page => <span key={page} className="inline-block mr-3">
      {sourceUrl ? <a className="underline" href={`${sourceUrl.split("#")[0]}#page=${page}`} target="_blank" rel="noopener noreferrer">Original page {page}</a> : `Original page ${page}`}
    </span>)}
  </div>;
}

function CandidateApproval({ attemptId, disabled, archived, pending, error, onApply, hasInitialComparisons }: {
  attemptId: number;
  disabled: boolean;
  archived: boolean;
  pending: boolean;
  error: Error | null;
  onApply: (request: ExtractionCandidateApplyRequest) => Promise<void>;
  hasInitialComparisons: boolean;
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
        <span>I have reviewed the original source PDF and compared the supplied source evidence and every proposed row.</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={ocrErrors} className="mt-0.5"
          onChange={(event) => setOcrErrors(event.target.checked)} />
        <span>{hasInitialComparisons
          ? "The differing initial OCR passages are extraction errors, not changes to the contractor’s original quotation."
          : "I confirm the proposed re-extraction faithfully transcribes the original PDF. Any differences from the initial extraction are extraction errors, not changes to the contractor’s original quotation."}</span>
      </label>
      <div className="space-y-1">
        <label htmlFor={`${id}-apply-reason`} className="font-semibold">Candidate approval reason (at least 12 characters)</label>
        <Textarea id={`${id}-apply-reason`} required minLength={12} value={reason} rows={3}
          onChange={(event) => setReason(event.target.value)} placeholder="Explain why the proposed re-extraction matches the original PDF, citing the source pages." />
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

interface ReviewProps {
  devisId: number;
  projectId: string;
  disabled?: boolean;
  documentLabel?: string;
  hasPdf?: boolean;
  viewPdfAction?: ReactNode;
  documentActions?: ReactNode;
  rescrapeAction?: ReactNode;
  workingQuotationAction?: ReactNode;
  extractionCorrectionAction?: ReactNode;
  correctionHistory?: ReactNode;
}

export function QuotationExtractionReview({
  devisId, projectId, disabled = false, documentLabel, hasPdf = true, viewPdfAction, documentActions,
  rescrapeAction, workingQuotationAction, extractionCorrectionAction, correctionHistory,
}: ReviewProps) {
  const id = useId();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [outcome, setOutcome] = useState<ExtractionReviewRequest["outcome"]>("unresolved");
  const [category, setCategory] = useState<ExtractionReviewRequest["category"]>("other");
  const [reason, setReason] = useState("");
  const [effort, setEffort] = useState("0");
  const [saved, setSaved] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const submitLock = useRef(false);
  const [appliedAttemptId, setAppliedAttemptId] = useState<number | null>(null);
  const { review, summary, record, apply } = useQuotationExtractionReview(devisId, days, projectId);
  const verification = object(object(review.data?.evidence).quotationVerification);
  const pricedEvidence = object(object(review.data?.evidence).pricedItemVerification);
  const pricedIssues = entries(pricedEvidence.issues).map(object);
  const nativeEvidence = entries(object(object(review.data?.evidence).nativeTableRecovery).evidence).map(object);
  const manifest = object(verification.manifest);
  const segments = entries(manifest.segments);
  const sections = entries(manifest.sections);
  const failures = entries(verification.failures);
  const issues = entries(object(verification.coverage).issues);
  const sourceFindings = verification.sourceFindings;
  const comparisons = entries(verification.initialComparison);
  const proposedRows = entries(verification.proposedLineItems ?? object(review.data?.evidence).lineItems);
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
    className="review-source">
    <div className="review-source-top">
      <div><p className="review-source-eyebrow">Devis document{documentLabel ? ` · ${documentLabel}` : ""}</p>
        <h2>Check the source. Then decide.</h2>
        <p className="review-source-subtitle">The contractor’s original PDF remains the legal reference.</p>
      </div>
      {review.data && <span className="review-source-badge"><AlertCircle size={12} />
        {review.data.events.some(event => event.kind === "review") ? "Review recorded" : "Not yet reviewed"}
      </span>}
    </div>
    <nav className="review-source-toolbar" aria-label="Source document actions">
      {viewPdfAction}
      {hasPdf && sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer"
        className="review-source-original">Open original contractor PDF<ExternalLink className="h-3 w-3" /></a>}
      {documentActions && <div className="review-source-document-links">{documentActions}</div>}
      {rescrapeAction && <div className="review-source-rescrape">{rescrapeAction}</div>}
    </nav>
    {nativeEvidence.length > 0 && <details className="border rounded-md p-3 text-sm">
      <summary className="cursor-pointer font-semibold">Original PDF evidence · {nativeEvidence.length} source-backed items</summary>
      <p className="text-muted-foreground my-2">Descriptions and charges recovered from the original text table. This is not architect approval; review the original layout before signing.</p>
      <ol className="space-y-2">{nativeEvidence.map((entry, index) => <li key={index}>
        <details><summary className="cursor-pointer">Item {index + 1} · PDF pages {entries(entry.pages).join(", ")}</summary>
          <NativeSourcePassage entry={entry} sourceUrl={hasPdf ? sourceUrl : undefined} />
        </details>
      </li>)}</ol>
    </details>}
    {review.data?.exceptionReview && !review.isError && <QuotationExceptions
      review={review.data.exceptionReview} devisId={devisId} sourceUrl={hasPdf ? sourceUrl : undefined}
      disabled={disabled || record.isPending || apply.isPending} historicalIssues={pricedIssues} />}
    {!review.data?.exceptionReview && pricedIssues.length > 0 && <details className="review-source-notice" open={!review.data?.humanWorkingVersion}>
      <summary className="font-semibold cursor-pointer">{review.data?.humanWorkingVersion ? "Historical extraction findings" : "Original-source review required"} · {pricedIssues.length} items</summary>
      <p>{review.data?.humanWorkingVersion
        ? "An audited architect working version exists. These are historical machine findings, not a verdict on your corrections. The working version still needs to reconcile with the confirmed original total before approval."
        : "These charges are not yet source-verified. Compare the listed items with the original PDF, then use Edit working quotation to record your interpretation and confirm the source total. Saving a draft is still allowed."}</p>
      <ul className="space-y-2 mt-2">{pricedIssues.map((issue, index) => <li key={index}>
        <strong>Item {String(issue.line)}</strong> — {String(issue.reason ?? "Source evidence is unavailable.")}
        {sourceUrl && <a className="underline ml-2" href={`${sourceUrl}#page=${typeof issue.page === "number" && issue.page > 0 ? issue.page : 1}`}
          target="_blank" rel="noopener noreferrer">Open original PDF{typeof issue.page === "number" ? ` · page ${issue.page}` : ""}</a>}
      </li>)}</ul>
    </details>}
    <aside className="review-source-notice"><ShieldCheck size={17} /><div>
      <strong>Matching totals are not a verified extraction.</strong><p>
      Matching TTC totals do not establish that descriptions, quantities or their associations are correct.
      Compare with the original PDF. Recording a review does not change quotation rows, commercial terms or permissions.
      Use the existing extraction correction controls or approve a prepared candidate below to repair rows;
      “Corrected” in the review form records a review outcome only.
    </p></div></aside>
    <div className="review-source-work">
      <aside className="review-source-action-rail" aria-label="Review and correction actions">
        <p className="review-source-eyebrow">Choose an action</p>
        <Button type="button" size="sm" className="review-source-primary"
          disabled={review.isPending || review.isError || !review.data || record.isPending || apply.isPending}
          onClick={() => setRecordOpen(true)}><ClipboardCheck size={14} />Record review</Button>
        {workingQuotationAction}
        {extractionCorrectionAction}
        <small>Review records document your decision.<br />Correction actions repair the working rows.</small>
      </aside>
      <div className="review-source-descriptions">
        <h3>Review &amp; corrections</h3>
        <div className="review-source-description"><Pencil size={15} /><div><h4>Architect’s working version</h4>
          <p>Review/edit the working quotation to record audited human corrections to descriptions, translations and figures. The original PDF is unchanged.</p></div></div>
        <div className="review-source-description"><ClipboardCheck size={15} /><div><h4>Extraction accuracy</h4>
          <p>Use the existing source transcription control to restore missing or misread source text. “Corrected” records an outcome only. Prepare re-extraction creates a separate candidate for review; it does not apply changes automatically.</p></div></div>
        {review.data && <div className="review-source-statusline">
          <span>{candidatePending ? `Candidate pending · attempt ${candidateAttemptId}` :
            appliedAttemptId !== null ? `Candidate applied · attempt ${appliedAttemptId}` : "No prepared candidate"}</span>
          <span>{segments.length ? `${segments.length} source segments` : nativeEvidence.length ? `${nativeEvidence.length} native source passages` : "No independent source segments supplied"}</span>
        </div>}
        {(failures.length > 0 || issues.length > 0) && <p className="mt-3 text-[11px] text-[#7b6547]">
          {failures.length} source / extraction findings · {issues.length} coverage findings. Source failures cannot be waived by candidate approval. Open evidence below.
        </p>}
      </div>
    </div>
    {review.isPending ? <Loading title="Loading extraction evidence" /> : review.isError ?
      <Retry error={review.error} onRetry={() => void review.refetch()} /> : review.data && <>
        {(!hasPdf || !sourceUrl) && <p className="text-muted-foreground">Source PDF link unavailable.</p>}
        {review.data?.running && <p role="status">Extraction is queued or running in the background. You can close this panel and continue working. Your quotation remains unchanged until you review and apply the result.</p>}
        {!review.data?.running && review.data?.job?.message && <p role="status" className={review.data.job.state === "failed" ? "text-destructive" : ""}>{review.data.job.message}</p>}
        {(candidatePending || appliedAttemptId !== null) && <details className="review-source-candidate rounded-lg border border-[#c1a27b]/40 bg-[#c1a27b]/[0.04] p-3" open={candidatePending}>
          <summary className="cursor-pointer font-semibold">
            Prepared candidate · {candidatePending ? `Pending approval (attempt ${candidateAttemptId})` :
              appliedAttemptId !== null ? `Applied (attempt ${appliedAttemptId})` : "No pending candidate"}
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-muted-foreground">
              Apply only after comparing every proposed row with the original PDF. This accepts a re-extraction, not changes to the contractor’s quotation.
              It does not permit you to waive source failures. The server revalidates the source evidence
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
                {!segments.length && !nativeEvidence.length && <p className="text-muted-foreground">No independent source segments supplied.</p>}
                {segments.map((segment, index) => <article key={index} className="border-b border-border pb-2"><EvidenceValue value={segment} /></article>)}
                {nativeEvidence.length > 0 && <div className="space-y-3">
                  <h5 className="font-semibold">Native text recovered from the original PDF</h5>
                  <p className="text-muted-foreground">Compare these passages, their prices and page layout with every proposed row. Source text is evidence for review, not approval.</p>
                  {nativeEvidence.map((entry, index) => <article key={index} className="border-b border-border pb-2">
                    <NativeSourcePassage entry={entry} sourceUrl={hasPdf ? sourceUrl : undefined} />
                  </article>)}
                </div>}
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
              hasInitialComparisons={comparisons.length > 0}
              archived={disabled}
              disabled={disabled || !hasPdf || !proposedRows.length || !sourceUrl || review.isError || record.isPending}
              pending={apply.isPending} error={apply.error} onApply={async (request) => {
                if (disabled || review.isError || record.isPending) return;
                await apply.mutateAsync(request);
                setAppliedAttemptId(request.attemptId);
              }} />}
            {appliedAttemptId !== null && <p role="status">Prepared candidate attempt {appliedAttemptId} applied. The original source PDF is unchanged.</p>}
          </div>
        </details>}
        <Dialog open={recordOpen} onOpenChange={next => { if (!record.isPending && !apply.isPending) setRecordOpen(next); }}>
          <DialogContent className="max-h-[88dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>Record a review outcome</DialogTitle>
            <DialogDescription>Recording a review does not repair quotation rows or change commercial terms or permissions.</DialogDescription>
          </DialogHeader>
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
              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <Button type="button" size="sm" variant="outline" onClick={() => setRecordOpen(false)}>Cancel</Button>
                <Button type="submit" size="sm" disabled={!valid || disabled || record.isPending || apply.isPending}>{record.isPending ? "Recording review…" : "Record review"}</Button>
              </div>
            </fieldset>
            {disabled && <p className="text-muted-foreground">Review recording is unavailable while this project is archived. Existing permissions still apply.</p>}
            {record.isError && <p role="alert" className="text-destructive">{record.error.message} Your entries are preserved. Retry recording the review.</p>}
            {saved && <p role="status">Review recorded. Quotation rows and source totals are unchanged.</p>}
          </form>
          </DialogContent>
        </Dialog>
      </>}
    <details className="review-source-disclosure">
      <summary className="cursor-pointer font-semibold">Amendments &amp; history <span>· {review.data?.events.length ?? "—"} review events</span></summary>
      <div className="mt-3 space-y-2">
        <h4 className="font-semibold">Review history · {review.data?.events.length ?? "—"} events</h4>
        {review.isError && <p className="text-destructive">Review history is unavailable: {review.error.message}</p>}
        {review.data && !review.data.events.length && <p className="text-muted-foreground">No review events recorded. This extraction has not been marked as reviewed.</p>}
        {review.data?.events.map((event) => <article key={event.id} className="border-l-2 border-[#c1a27b]/60 pl-3 space-y-1">
          <p className="font-semibold">{label(event.outcome, reviewOutcomes)} · {label(event.category, reviewCategories)}</p>
          <p className="text-muted-foreground">{event.kind} · {Number.isNaN(Date.parse(event.created_at)) ? event.created_at : new Date(event.created_at).toLocaleString()} · {event.effort_minutes ?? 0} min</p>
          <p className="whitespace-pre-wrap break-words">{event.reason || "No reason supplied."}</p>
          {event.diagnostic && <p className="text-destructive">{event.diagnostic.message}{event.diagnostic.chunk ? ` Stopped at extraction batch ${event.diagnostic.chunk}.` : ""}</p>}
        </article>)}
        {correctionHistory}
      </div>
    </details>
    {review.data && !review.isError && <details className="review-source-disclosure">
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
          {sourceFindings != null && <div><h4 className="font-semibold">Independent source findings</h4><EvidenceValue value={sourceFindings} /></div>}
          {!candidatePending && <p className="text-muted-foreground">No pending candidate. Candidate application is unavailable.</p>}
        </section>
      </div>
    </details>}
    <details className="review-source-disclosure">
      <summary className="cursor-pointer font-semibold">Extraction monitoring <span>· Accessible quotations</span></summary>
    <section aria-label="Extraction monitoring" className="space-y-3 py-3">
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
    </details>
    <footer className="review-source-foot">Original PDF preserved · Existing permissions apply</footer>
  </section>;
}