import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUpRight, ChevronDown, MailWarning, X } from "lucide-react";
import BurnUpChart from "./BurnUpChart";
import { dashboardSample, designActionsSample, outstandingSample, stuckMessagesSample, unsentSample } from "./fixtures";
import { useQuery } from "./stubs";
import "./Proposed.css";

type Demo = { title: string; context: string; reference?: boolean };
const money = (value: string | number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Number(value));
const project = (id: number) => dashboardSample.projectSummaries.find((item) => item.id === id)!;
const context = (id: number) => `${project(id).code} · ${project(id).name}`;

function Disclosure({ title, summary, count, children, open = false, priority = false }: { title: string; summary: string; count?: number; children: ReactNode; open?: boolean; priority?: boolean }) {
  return <details className={`ap-disclosure${priority ? " ap-priority" : ""}`} open={open}>
    <summary>{count !== undefined && <span className="ap-count">{count}</span>}<span className="ap-summary-copy"><strong>{title}</strong><small>{summary}</small></span><ChevronDown className="ap-chevron" size={16} /></summary>
    {children}
  </details>;
}

function Row({ title, meta, note, amount, denomination = "TTC", action, onAction, primary = false }: { title: string; meta: string; note?: string; amount?: string | number; denomination?: string; action: string; onAction: () => void; primary?: boolean }) {
  return <div className="ap-row">
    <div className="ap-row-copy"><p className="ap-row-title">{title}</p><p className="ap-row-meta">{meta}</p>{note && <p className="ap-row-note">{note}</p>}</div>
    {amount !== undefined && <div className="ap-row-amount">{money(amount)}<small>{denomination}</small></div>}
    <button type="button" className={`ap-action${primary ? " ap-primary" : ""}`} onClick={onAction}>{action}<ArrowUpRight size={13} aria-hidden="true" /></button>
  </div>;
}

export function Proposed() {
  const [demo, setDemo] = useState<Demo | null>(null);
  const [reference, setReference] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedProject, setSelectedProject] = useState(1);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { data: gmail } = useQuery<{ pollHealth: { level: string; message: string | null }; needsAttentionCount: number; persistentFailureCount: number }>({ queryKey: ["/api/gmail/status"] });
  const { data: detected } = useQuery<{ id: number }[]>({ queryKey: ["/api/architect-fee-invoices", { status: "pending_review" }] });
  useEffect(() => {
    if (demo && !dialogRef.current?.open) dialogRef.current?.showModal();
    if (!demo && dialogRef.current?.open) dialogRef.current.close();
  }, [demo]);
  const preview = (title: string, detail: string, editReference = false) => {
    setReference("");
    setDemo({ title, context: detail, reference: editReference });
  };
  const close = () => setDemo(null);
  const acknowledge = () => {
    setNotice(`${demo?.reference ? "Reference entry demonstrated" : demo?.title} — demonstration only. No data saved, email sent, payment authorised or service contacted.`);
    close();
  };
  const d = dashboardSample;
  const syncFailure = !d.gmailConfigured || !d.gmailPolling || !["success", "idle"].includes(d.gmailLastPollStatus) || !["healthy"].includes(gmail.pollHealth.level);
  return <div className="architrak-proposed">
    <div className="ap-wrap">
      <div className="ap-sample" role="note"><strong>DEMONSTRATION</strong><span>Illustrative sample data only. All interactions are local; no services are contacted.</span></div>
      <div className="ap-heading">
        <div><h1>Dashboard</h1><p>Priority actions and project overview</p></div>
        <a className="ap-jump" href="#ap-projects">Your projects <ArrowDown size={15} /></a>
      </div>
      <section className="ap-intake" aria-label="Gmail intake issues">
        <MailWarning size={19} aria-hidden="true" />
        <div className="ap-intake-copy"><strong>{syncFailure ? "Gmail monitoring needs attention" : "Inbox intake needs a review"}</strong>
          <p>{syncFailure ? gmail.pollHealth.message || `Monitoring unavailable or paused · ${d.gmailLastPollStatus}. Reconnect or inspect settings.` : "Last scan successful · monitoring enabled."}{" "}{gmail.needsAttentionCount} documents need review · {gmail.persistentFailureCount} message stuck after repeated scan failures.</p>
        </div>
        <button type="button" onClick={() => preview("Check Gmail now", "This demonstrates the existing manual Gmail check. No inbox scan is performed, no email is accessed, and the displayed scan status remains illustrative.")}>Check now</button>
        <button type="button" onClick={() => preview("Review Gmail intake", `${gmail.needsAttentionCount} emailed documents need review. Project assignments are not supplied by this fixture. ${stuckMessagesSample[0].messageId} has failed ${stuckMessagesSample[0].failCount} scans. Inspect the original email before deciding whether to retry or skip. A scan failure does not mean the message was deleted.`)}>Review intake</button>
      </section>
      <div className="ap-grid">
        <main>
          <div className="ap-section-label"><h2>Decisions & next steps</h2><span>Counts are per source, not additive</span></div>
          <Disclosure title="Urgent items" count={d.urgentItems.length} summary="1 overdue invoice · 2 certificates · 1 quotation query group" open priority>
            {d.urgentItems.map((item) => <Row key={`${item.type}-${item.id}`}
              title={item.type === "overdue_invoice" ? "F-2026-031 · overdue invoice" : item.type === "cert_draft" ? "CP-TIL-004 · certificate draft" : item.type === "cert_review" ? "CP-VOL-004 · certificate awaiting review" : "2 quotation queries need attention"}
              meta={context(item.projectId)}
              note={item.type === "overdue_invoice" ? "Waiting on payment · review the record before following up" : item.type === "cert_draft" ? "Your action · complete the certificate" : item.type === "cert_review" ? "Your action · review the certificate" : "Your action · resolve the quotation queries"}
              amount={Number(item.amount) > 0 ? item.amount : undefined}
              action={item.type === "overdue_invoice" ? "Review invoice" : item.type === "cert_draft" ? "Continue draft" : item.type === "cert_review" ? "Review certificate" : "Review queries"}
              primary={item.type === "overdue_invoice"}
              onAction={() => preview("Review urgent item", `${item.label}. ${context(item.projectId)}. This demonstration does not approve certificates, send payment demands or authorise payments.`)}
            />)}
          </Disclosure>
          <Disclosure title="Certificates awaiting dispatch" count={unsentSample.length} summary="No successful client email recorded · review before sending" open>
            {unsentSample.map((cert) => <Row key={cert.certificatId} title={cert.certificateRef + (cert.isSolde ? " · final certificate" : " · ready certificate")} meta={`${context(cert.projectId)} · ${cert.contractorName}`} note={cert.certificateStatus === "sent" ? "Marked sent, but no successful email on record" : "Ready · architect invoice attached"} action="Review dispatch" onAction={() => preview("Review certificate dispatch", `${cert.certificateRef} · ${cert.projectName} · ${cert.contractorName}. Certificate value: ${money(cert.netToPayTtc)} TTC. No successful client email is recorded. This is a dispatch task, not a payment demand. No email will be sent in this demonstration.`)} />)}
          </Disclosure>
          <Disclosure title="Design milestones awaiting invoice" count={designActionsSample.length} summary={`${money(designActionsSample[0].amountTtc)} TTC · milestone reached, invoice to prepare`}>
            {designActionsSample.map((item) => <Row key={item.milestoneId} title={item.labelFr} meta={`${context(item.projectId)} · reached 10 June 2026`} amount={item.amountTtc} action="Prepare invoice" onAction={() => preview("Prepare design fee invoice", `${item.labelFr} · ${context(item.projectId)} · ${money(item.amountTtc)} TTC. Review the contract and milestone before invoicing. No invoice will be created.`)} />)}
          </Disclosure>
          <Disclosure title="Detected fee invoices to verify" count={detected.length} summary="Detected documents · matching and project assignment not verified">
            {detected.map((item) => <Row key={item.id} title={`Detected fee invoice · record ${item.id}`} meta="Project not supplied by the source · identify during review" note="Do not assume these match the accounting-reference entries below." action="Verify document" onAction={() => preview("Verify detected fee invoice", `Detected record ${item.id}. The fixture provides no project, invoice reference or amount. Verify the document and project before matching. No accounting entry is changed.`)} />)}
          </Disclosure>
          <div className="ap-support-label ap-eyebrow">Supporting context</div>
          <Disclosure title="Accounting references to reconcile" count={outstandingSample.totalCount} summary={`${money(outstandingSample.totalFeeHt)} HT in fee entries · oldest entry 96 days`}>
            <p className="ap-footnote">Approved invoices missing a Pennylane commission reference. This does not establish an unpaid invoice. Entry age is not payment lateness; detected-document matches are unverified.</p>
            {outstandingSample.entries.map((entry) => <Row key={entry.entryId} title={`${entry.invoiceNumber} · ${entry.contractorName}`} meta={`${context(entry.projectId)} · ${entry.devisCode} · entry age ${entry.ageDays} days`} note="Architect fee amount · accounting reference missing" amount={entry.feeAmountHt} denomination="HT" action="Reconcile reference" onAction={() => preview("Reconcile accounting reference", `${context(entry.projectId)} · ${entry.invoiceNumber} · ${entry.contractorName}. Source invoice: ${money(entry.amountHt)} HT / ${money(entry.amountTtc)} TTC. Fee: ${entry.feePercentage}% · ${money(entry.feeAmountHt)} HT. Check Pennylane before linking an existing reference. An absent reference is not evidence of nonpayment.`, true)} />)}
          </Disclosure>
          <Disclosure title="Project financial health" summary="Contract value versus certified value · choose among 3 projects">
            <div className="ap-chart"><label htmlFor="ap-chart-project">Project</label><select id="ap-chart-project" value={selectedProject} onChange={(event) => setSelectedProject(Number(event.target.value))}>{d.projectSummaries.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select><BurnUpChart projectId={selectedProject} /></div>
          </Disclosure>
          <Disclosure title="Recent activity" count={d.recentActivity.length} summary="Latest recorded updates · 5–12 June 2026 · history, not a task list">
            {d.recentActivity.map((item, i) => <Row key={i} title={item.label} meta={`${context(item.projectId)} · ${item.contractor} · ${item.date}`} amount={item.amount} action="View record" onAction={() => preview("View activity record", `${item.label} · ${context(item.projectId)} · ${item.contractor} · ${item.date}. Historical activity does not establish the current workflow or payment status.`)} />)}
          </Disclosure>
        </main>
        <aside id="ap-projects" className="ap-projects" aria-label="Your projects">
          <div className="ap-section-label"><h2>Your projects</h2><span>{d.overview.activeProjects} active / {d.overview.totalProjects} total</span></div>
          <Disclosure title="Project directory" summary="2 active projects · 1 completed" open>
            {d.projectSummaries.map((p) => <article className={`ap-project-card${p.status === "completed" ? " ap-completed" : ""}`} key={p.id}>
              <div className="ap-project-code"><span>{p.code}</span><span>{p.status === "active" ? "ACTIVE" : "COMPLETED"}</span></div>
              <h3>{p.name}</h3><p>{p.clientName}</p>
              <div className="ap-project-stats">
                <span>Quotations: {p.devisApprovedCount} approved · {p.devisUnapprovedCount} pending</span>
                <span>Invoices: {p.invoiceApprovedCount} approved · {p.invoiceUnapprovedCount} pending</span>
                <span>{p.allDevisSigned ? "All quotations signed" : "Quotation signatures outstanding"}</span>
                <span>{p.agentStatus === "ok" ? "Agent: no queries flagged" : `Agent: ${p.agentIssueCount} queries flagged`}</span>
              </div>
              <button type="button" className="ap-action" onClick={() => preview(`Open ${p.name}`, `${p.code} · ${p.clientName}. Project navigation is a demonstration only. Quotations, invoices, certificates, contractors and fee administration would be available in this project.`)}>Open project<ArrowUpRight size={13} /></button>
            </article>)}
          </Disclosure>
          <p className="ap-side-note">Start with the exception, then open the project for the full picture. Section counts may refer to the same records.</p>
        </aside>
      </div>
    </div>
    <dialog className="ap-dialog" ref={dialogRef} aria-labelledby="ap-dialog-title" aria-describedby="ap-dialog-description" onCancel={close} onClose={close}>
      <span className="ap-eyebrow">Local demonstration only</span><h2 id="ap-dialog-title">{demo?.title}</h2><p id="ap-dialog-description">{demo?.context}</p>
      <form onSubmit={(event) => { event.preventDefault(); acknowledge(); }}>
        {demo?.reference && <label>Try an accounting reference (not saved)<input autoComplete="off" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Enter a reference to demonstrate" /></label>}
        <p>No data changes. No network requests. No payment authorisation.</p>
        <div className="ap-dialog-actions"><button type="button" className="ap-action" onClick={close}>Close</button><button type="submit" className="ap-action">{demo?.reference ? "Demonstrate reference entry" : "Acknowledge demonstration"}</button></div>
      </form>
    </dialog>
    {notice && <div className="ap-notice" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss demonstration message" onClick={() => setNotice("")}><X size={16} /></button></div>}
  </div>;
}

export default Proposed;
