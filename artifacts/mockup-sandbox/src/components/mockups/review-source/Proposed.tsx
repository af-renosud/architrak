// Recommended reorganization of Current.tsx. All actions are local sandbox demonstrations.
// Source provenance and response contracts are retained from Current.tsx and fixtures.ts.
import "./_group.css";
import "./proposed.css";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, ChevronDown, ChevronRight, ClipboardCheck, ExternalLink, FileText, History, Layers, Pencil, RefreshCw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { fixture, reviewCategories, reviewOutcomes, useQuotationExtractionReview, type ExtractionReviewRequest } from "./fixtures";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const entries = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const label = (value: string | null, names: Record<string, string>) => value ? names[value] ?? value.replace(/_/g, " ") : "Not stated";
function Evidence({ value }: { value: unknown }) {
  if (value == null) return <span>Not stated</span>;
  if (Array.isArray(value)) return <div className="rs-evidence">{value.map((item, i) => <article key={i}><Evidence value={item} /></article>)}</div>;
  if (typeof value === "object") return <dl className="rs-evidence">{Object.entries(object(value)).map(([key, item]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd><Evidence value={item} /></dd></div>)}</dl>;
  return <span className="whitespace-pre-wrap">{String(value)}</span>;
}
function Disclosure({ title, meta, icon, children }: { title: string; meta?: string; icon: ReactNode; children: ReactNode }) {
  return <details className="rs-disclosure"><summary>{icon}<strong>{title}</strong>{meta && <span>{meta}</span>}<ChevronDown size={14} /></summary><div className="rs-disclosure-content">{children}</div></details>;
}

export function Proposed() {
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [outcome, setOutcome] = useState<ExtractionReviewRequest["outcome"]>("unresolved");
  const [category, setCategory] = useState<ExtractionReviewRequest["category"]>("other");
  const [reason, setReason] = useState("");
  const [effort, setEffort] = useState("0");
  const [demoRecorded, setDemoRecorded] = useState(false);
  const [reviewedOriginal, setReviewedOriginal] = useState(false);
  const [ocrErrors, setOcrErrors] = useState(false);
  const [approvalReason, setApprovalReason] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const submitLock = useRef(false);
  const { review, summary, record, apply } = useQuotationExtractionReview(fixture.devis.id, days, fixture.projectId);
  const verification = object(object(review.data?.evidence).quotationVerification);
  const manifest = object(verification.manifest);
  const segments = entries(manifest.segments);
  const sections = entries(manifest.sections);
  const failures = entries(verification.failures);
  const issues = entries(object(verification.coverage).issues);
  const comparisons = entries(verification.initialComparison);
  const rows = entries(verification.proposedLineItems);
  const attemptId = review.data?.candidateAttemptId;
  const candidate = typeof attemptId === "number" && Number.isSafeInteger(attemptId) && attemptId > 0;
  const validEffort = /^\d+$/.test(effort) && Number.isSafeInteger(Number(effort));
  let sourceAvailable = false;
  try {
    const source = review.data?.sourcePdfUrl && new URL(review.data.sourcePdfUrl, window.location.origin);
    sourceAvailable = !!source && source.origin === window.location.origin && ["http:", "https:"].includes(source.protocol);
  } catch { /* Unsafe or invalid links are not exposed. */ }
  const hasHumanReview = review.data?.events.some(event => event.kind === "human_review");
  const busy = record.isPending || apply.isPending;
  const openAction = (name: string) => { setAction(name); setDemoRecorded(false); record.reset(); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim() || !validEffort || busy || submitLock.current || review.isError || !review.data) return;
    submitLock.current = true;
    try {
      await record.mutateAsync({ outcome, category, reason: reason.trim(), effortMinutes: Number(effort) });
      setDemoRecorded(true);
      setReason("");
      setEffort("0");
    } catch { /* Keep the user's entries on failure. */ }
    finally { submitLock.current = false; }
  }
  async function approve(event: FormEvent) {
    event.preventDefault();
    if (!candidate || !sourceAvailable || !rows.length || busy || !reviewedOriginal || !ocrErrors || approvalReason.trim().length < 12 || submitLock.current) return;
    submitLock.current = true;
    try {
      await apply.mutateAsync({ attemptId, reason: approvalReason.trim(), reviewedOriginal: true, initialDifferencesAreOcrErrors: true });
      setApprovalError("Local demonstration only. No quotation rows have been changed.");
    } catch (error) {
      setApprovalError(`${error instanceof Error ? error.message : "Candidate application rejected."} Original PDF and current rows are unchanged. Your declarations and reason are preserved.`);
    } finally { submitLock.current = false; }
  }
  return <div className="rs-proposed">
    <section className="rs-shell" aria-label="Review source">
      <header className="rs-heading">
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={`${id}-body`}>
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span className="rs-number">01</span><strong>Review source</strong>
        </button><small>Source &amp; extraction · {fixture.lines.length} lines</small>
      </header>
      <div className="rs-body" id={`${id}-body`} hidden={!expanded}>
        <div className="rs-top">
          <div><p className="rs-eyebrow">Devis document · {fixture.devis.devisCode}</p><h2>Check the source. Then decide.</h2><p className="rs-subtitle">The contractor’s original PDF remains the legal reference.</p></div>
          <span className="rs-badge"><AlertCircle size={12} />{hasHumanReview ? "Review in local demo" : "Not yet reviewed"}</span>
        </div>
        <nav className="rs-actions" aria-label="Source document actions">
          <button className="rs-button rs-primary" onClick={() => openAction("View PDF")}><FileText size={15} />View PDF</button>
          <button className="rs-button" disabled={!sourceAvailable} onClick={() => openAction("Open original contractor PDF")}>Original contractor PDF<ExternalLink size={12} /></button>
          <span className="rs-action-divider" />
          <button className="rs-button rs-quiet" onClick={() => openAction("Document Chain")}><Layers size={13} />Chain</button>
          {fixture.devis.driveWebViewLink && <button className="rs-button rs-quiet" onClick={() => openAction("Open in Renosud shared Drive")}>Drive<ExternalLink size={12} /></button>}
          <button className="rs-button rs-quiet rs-rescrape" onClick={() => openAction("Re-scrape this devis?")}><RefreshCw size={13} />Re-scrape</button>
        </nav>
        <aside className="rs-notice"><ShieldCheck size={17} /><div><strong>Matching totals are not a verified extraction.</strong><p>Compare descriptions, quantities and their associations with the original PDF. Recording a review does not repair rows or change commercial terms or permissions.</p></div></aside>
        {review.isPending ? <div role="status" aria-label="Loading extraction evidence"><Skeleton className="h-6 w-2/3" /><Skeleton className="my-4 h-20 w-full" /></div> : review.isError ? <div role="alert"><p>{review.error.message}</p><button className="rs-button" onClick={() => void review.refetch()}>Retry evidence</button></div> : <>
          {review.data?.running && <p role="status" className="rs-demo-note">Checking source sections. The original quotation remains unchanged until the candidate passes review.</p>}
          <div className="rs-work">
            <div><h3>Review &amp; corrections</h3>
              <div className="rs-description"><Pencil size={15} /><div><h4>Architect’s working version</h4><p>Correct descriptions, translations and figures without changing the contractor’s original PDF.</p></div></div>
              <div className="rs-description"><ClipboardCheck size={15} /><div><h4>Extraction accuracy</h4><p>Restore a missing row or repair a misread row using the source. “Corrected” is a review outcome only, not a row correction.</p></div></div>
              <div className="rs-statusline">
                <span><span className="rs-number">—</span>{candidate ? `Candidate pending · attempt ${attemptId}` : "No prepared candidate"}</span>
                <span><AlertCircle size={11} />{segments.length ? `${segments.length} source segments` : "No independent source segments supplied"}</span>
              </div>
              {!sourceAvailable && <p role="alert" className="rs-demo-note">Source PDF link unavailable. Candidate approval is unavailable.</p>}
              {(failures.length > 0 || issues.length > 0) && <p role="alert" className="rs-demo-note">{failures.length} source / extraction findings · {issues.length} coverage findings. Source failures cannot be waived by candidate approval. Open evidence below.</p>}
            </div>
            <aside className="rs-action-rail" aria-label="Review and correction actions"><p className="rs-eyebrow">Choose an action</p>
              <button className="rs-button rs-primary" disabled={busy || review.isError} onClick={() => openAction("Record a review outcome")}><ClipboardCheck size={14} />Record review</button>
              <button className="rs-button" onClick={() => openAction("Edit working quotation")}><Pencil size={13} />Edit working quotation</button>
              <button className="rs-button" onClick={() => openAction("Correct missing / misread extraction")}><SlidersHorizontal size={13} />Correct missing / misread extraction</button>
              {candidate && <button className="rs-button" onClick={() => openAction("Review prepared candidate")}>Review prepared candidate</button>}
              <small>Review records document your decision.<br />Correction actions repair the working rows.</small>
            </aside>
          </div>
        </>}
        <div className="rs-records">
          <Disclosure icon={<History size={14} />} title="Amendments & history" meta={`${review.data?.events.length ?? 0} review event · 0 duplicate corrections`}>
            <h4>Review history</h4>
            {!review.data?.events.length && <p>No review events recorded. This extraction has not been marked as reviewed.</p>}
            {review.data?.events.map(event => <article key={event.id}><h4>{label(event.outcome, reviewOutcomes)} · {label(event.category, reviewCategories)}</h4><p>{event.kind.startsWith("human") ? "Local demo · " : ""}{event.kind} · {Number.isNaN(Date.parse(event.created_at)) ? event.created_at : new Date(event.created_at).toLocaleString()} · {event.effort_minutes ?? 0} min</p><p className="whitespace-pre-wrap">{event.reason || "No reason supplied."}</p></article>)}
            <h4>Duplicate extraction correction history</h4><p>No duplicate extraction corrections recorded. Any confirmed correction will appear here with its reason and financial reconciliation.</p><p>Read-only correction record. Contractor PDF and source quotation totals remain unchanged.</p>
          </Disclosure>
          <Disclosure icon={<FileText size={14} />} title="Source inventory & discrepancy evidence" meta={`${segments.length} segments`}>
            <p>Automated evidence is not a human verification of the extraction.</p>
            {!segments.length ? <p>No source segments supplied. Review the original PDF directly.</p> : segments.map((segment, i) => <article key={i}><h4>Segment {String(object(segment).id ?? i + 1)} · Page {String(object(segment).page ?? "not stated")} · Section {String(object(segment).section ?? "not stated")}</h4><Evidence value={segment} /></article>)}
            {!!sections.length && <details><summary>Source sections &amp; price regions</summary><Evidence value={sections} /></details>}
            {manifest.inventoriedPages != null && <div>Inventoried pages: <Evidence value={manifest.inventoriedPages} /></div>}
            <h4>Discrepancy details</h4>{!failures.length && !issues.length && <p>No discrepancies supplied. This does not establish that the extraction is accurate.</p>}
            {!!failures.length && <><h4>Source / extraction findings · cannot be waived</h4><Evidence value={failures} /></>}
            {!!issues.length && <><h4>Coverage findings</h4><Evidence value={issues} /></>}
            {verification.sourceFindings != null && <><h4>Independent source findings</h4><Evidence value={verification.sourceFindings} /></>}
            {!candidate && <p>No pending candidate. No proposed rows supplied; candidate application is unavailable.</p>}
          </Disclosure>
          <Disclosure icon={<SlidersHorizontal size={14} />} title="Extraction monitoring" meta="Accessible quotations">
            <label htmlFor={`${id}-days`}>Period </label><select id={`${id}-days`} value={days} onChange={e => setDays(Number(e.target.value) as 7 | 30 | 90)}>{[7, 30, 90].map(value => <option key={value} value={value}>Last {value} days</option>)}</select>
            {summary.isPending ? <Skeleton className="h-20 w-full" /> : summary.isError ? <div role="alert">{summary.error.message}<button onClick={() => void summary.refetch()}>Retry monitoring</button></div> : summary.data && <>
              {summary.data.processed === 0 && <p>No processed quotations in this period.</p>}
              <dl className="rs-monitor">{[["Processed", summary.data.processed], ["Reviewed", summary.data.reviewed], ["Confirmed inaccurate", summary.data.inaccurate], ["Repeat failures", summary.data.repeatFailures], ["Review effort (minutes)", summary.data.effortMinutes]].map(([text, count]) => <div key={text}><dt>{text}</dt><dd>{count}</dd></div>)}</dl>
              <h4>Categories</h4>{!summary.data.categories.length ? <p>No category counts recorded for this period.</p> : summary.data.categories.map(item => <p key={item.category}>{label(item.category, reviewCategories)} · {item.count}</p>)}
              <p>Unreviewed extractions are not verified. Counts reflect recorded reviews, not proof of accuracy; permissions are unchanged.</p>
            </>}
          </Disclosure>
          <div className="rs-foot"><span>Original PDF preserved · Existing permissions apply</span><span>Interactive preview only · No live changes</span></div>
        </div>
      </div>
    </section>
    <Dialog open={action !== null} onOpenChange={open => { if (!open && !busy) setAction(null); }}><DialogContent className="rs-dialog">
      <DialogHeader><DialogTitle>{action}</DialogTitle><DialogDescription>Local sandbox demonstration. No real saves, application API calls or external documents.</DialogDescription></DialogHeader>
      {action === "Record a review outcome" ? demoRecorded ? <div role="status" className="rs-demo-note">Review added to this preview’s local history only. No review has been saved to ArchiTrak. Quotation rows and source totals are unchanged.</div> : <form onSubmit={submit} className="rs-form">
        <div className="rs-demo-note">“Corrected” records a review outcome only. Use the correction actions to repair rows. Commercial terms and permissions are unchanged.</div>
        <fieldset disabled={busy} className="rs-form">
          <div className="rs-form-grid"><div><label htmlFor={`${id}-outcome`}>Review outcome</label><select id={`${id}-outcome`} value={outcome} onChange={e => setOutcome(e.target.value as ExtractionReviewRequest["outcome"])}>{Object.entries(reviewOutcomes).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></div>
            <div><label htmlFor={`${id}-category`}>Review category</label><select id={`${id}-category`} value={category} onChange={e => setCategory(e.target.value as ExtractionReviewRequest["category"])}>{Object.entries(reviewCategories).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></div></div>
          <div><label htmlFor={`${id}-reason`}>Review reason (required)</label><textarea id={`${id}-reason`} rows={4} required value={reason} onChange={e => { record.reset(); setReason(e.target.value); }} placeholder="Describe what you compared with the PDF and what remains incorrect or uncertain." /></div>
          <div><label htmlFor={`${id}-effort`}>Review effort (minutes)</label><input id={`${id}-effort`} type="number" min={0} step={1} required value={effort} onChange={e => setEffort(e.target.value)} />{!validEffort && <p role="alert">Enter a nonnegative whole number of minutes.</p>}</div>
          {record.isError && <p role="alert">{record.error.message} Your entries are preserved. Retry recording the review.</p>}
          <footer><Button type="button" variant="outline" onClick={() => setAction(null)}>Cancel</Button><Button className="rs-dialog-primary" type="submit" disabled={!reason.trim() || !validEffort || busy || review.isError}>{busy ? "Adding to preview…" : "Add review to local demo"}</Button></footer>
        </fieldset>
      </form> : action === "Re-scrape this devis?" ? <>
        <p className="text-sm leading-relaxed">In the application, AI reads <strong>{fixture.devis.devisCode}</strong> again and replaces its current line items and totals. Manual edits to the devis code, contractor, lot and status are kept. This usually takes a few seconds.</p>
        <div className="rs-demo-note">Previous duplicate-extraction corrections will not be automatically reapplied. Review the new extraction against the original PDF before confirming it.</div>
        <footer><Button variant="outline" onClick={() => setAction(null)}>Cancel</Button><Button className="rs-dialog-primary" onClick={() => openAction("Re-scrape · demo only")}>Continue in demo</Button></footer>
      </> : action === "Review prepared candidate" ? <form onSubmit={approve} className="rs-form">
        <p className="rs-demo-note">Approval only waives differences from initial OCR, not source failures. The server revalidates the independent source inventory and refuses uncertain or locked evidence. On rejection, the original PDF and current rows remain unchanged.</p>
        <h4>Initial OCR compared with the original source</h4>{comparisons.length ? <Evidence value={comparisons} /> : <p>No initial OCR comparisons supplied. Compare every proposed row against the original PDF.</p>}
        <details><summary>Original source segments · {segments.length}</summary><Evidence value={segments} /></details>
        <details><summary>Proposed rows · full descriptions &amp; amounts</summary>{rows.map((row, i) => { const item = object(row); const section = sections.map(object).find(entry => typeof item.section === "string" && entry.id === item.section); return <article key={i}><h4>Proposed row {i + 1} · Page {String(item.page ?? item.sourcePage ?? object(section?.priceRegion).page ?? "not supplied")}</h4><Evidence value={row} /></article>; })}</details>
        {!!failures.length && <><h4>Source / extraction findings · cannot be waived</h4><Evidence value={failures} /></>}
        {!!issues.length && <Evidence value={issues} />}
        {verification.sourceFindings != null && <Evidence value={verification.sourceFindings} />}
        <fieldset disabled={!rows.length || !sourceAvailable || busy || review.isError} className="rs-form">
          <label className="rs-check"><input type="checkbox" checked={reviewedOriginal} onChange={e => setReviewedOriginal(e.target.checked)} />I have reviewed the original source PDF and compared the source segments, initial OCR passages and proposed rows.</label>
          <label className="rs-check"><input type="checkbox" checked={ocrErrors} onChange={e => setOcrErrors(e.target.checked)} />The differing initial OCR passages are extraction errors, not changes to the contractor’s original quotation.</label>
          <div><label htmlFor={`${id}-approval`}>Candidate approval reason (at least 12 non-padding characters)</label><textarea id={`${id}-approval`} required minLength={12} rows={3} value={approvalReason} onChange={e => setApprovalReason(e.target.value)} placeholder="Cite the original source PDF." /></div>
          <Button type="submit" disabled={!reviewedOriginal || !ocrErrors || approvalReason.trim().length < 12}>Demo: approve and apply prepared candidate</Button>
        </fieldset>
        {(!rows.length || !sourceAvailable) && <p>Candidate approval is unavailable: proposed rows or source link are unavailable.</p>}
        {approvalError && <p role="alert">{approvalError}</p>}
      </form> : <>
        <p className="text-sm leading-relaxed">{action === "Edit working quotation" ? "Correct descriptions, translations and figures in the architect’s working version. The contractor’s original PDF remains the legal reference." : action === "Correct missing / misread extraction" ? "Restore a missing row or repair a misread row using the original contractor PDF in the application." : action === "Document Chain" ? "Document Chain — devis → situations → factures → certificats." : "This action is not connected to application APIs or external documents."}</p>
        <p className="rs-demo-note">Demonstration only. No quotation rows, source totals or other data have been changed.</p>
      </>}
      {(action !== "Record a review outcome" || demoRecorded) && action !== "Re-scrape this devis?" && <Button type="button" variant="outline" onClick={() => setAction(null)}>Close preview</Button>}
    </DialogContent></Dialog>
  </div>;
}

export default Proposed;
