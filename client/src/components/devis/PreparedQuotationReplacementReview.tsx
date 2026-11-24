import { Textarea } from "@/components/ui/textarea";
import { EvidenceValue } from "./QuotationExtractionReview";
import type { ExtractionReviewResponse } from "./use-quotation-extraction-review";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export interface PreparedApproval {
  attemptId: number;
  reason: string;
  reviewedOriginal: boolean;
  initialDifferencesAreOcrErrors: boolean;
}

export function preparedApprovalValid(approval: PreparedApproval | null, attemptId: number | null | undefined) {
  return !!approval && approval.attemptId === attemptId && approval.reason.trim().length >= 12
    && approval.reviewedOriginal && approval.initialDifferencesAreOcrErrors;
}

export function preparedEvidence(data: ExtractionReviewResponse | undefined) {
  if (!data) return { evidence: {}, verification: {}, rows: [], sourceUrl: undefined };
  const evidence = object(data.evidence);
  const verification = object(evidence.quotationVerification);
  const proposed = verification.proposedLineItems ?? evidence.lineItems;
  const rows = Array.isArray(proposed) ? proposed : [];
  let sourceUrl: string | undefined;
  try {
    const url = new URL(data.sourcePdfUrl, window.location.origin);
    if (data.sourcePdfUrl?.trim() && url.origin === window.location.origin && ["http:", "https:"].includes(url.protocol)) {
      url.searchParams.set("variant", "original");
      sourceUrl = `${url.pathname}${url.search}${url.hash}`;
    }
  } catch { /* Never render untrusted or malformed PDF links. */ }
  return { evidence, verification, rows, sourceUrl };
}

export function PreparedQuotationReplacementReview({ data, approval, onChange, readOnly = false }: {
  data: ExtractionReviewResponse;
  approval: PreparedApproval;
  onChange: (value: PreparedApproval) => void;
  readOnly?: boolean;
}) {
  const { evidence, verification, rows, sourceUrl } = preparedEvidence(data);
  return <section aria-label="Prepared extraction review" className="space-y-4 text-sm">
    <div className="rounded-md border border-[#c1a27b]/40 bg-[#c1a27b]/[0.04] p-3 space-y-2">
      <h3 className="font-semibold">Prepared extraction · attempt {data.candidateAttemptId}</h3>
      <p>{rows.length} proposed rows. Compare every row and the candidate totals with the original contractor PDF before approving.</p>
      <div><p className="font-semibold">Candidate totals</p><EvidenceValue value={verification.totals ?? evidence.totals ?? {
        totalHt: evidence.totalHt ?? evidence.totalHT ?? evidence.amountHt,
        totalTtc: evidence.totalTtc ?? evidence.totalTTC ?? evidence.amountTtc,
      }} /></div>
      {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline font-medium">Open original contractor PDF</a>
        : <p role="alert" className="text-destructive">Source PDF link unavailable. Candidate approval is unavailable.</p>}
    </div>
    <p>Approval and replacement are saved together. If either fails, neither quotation changes. Exact unchanged source items retain authored work automatically where the replacement has no existing work. Ambiguous items remain in previous work for later review; nothing is copied by guesswork. Existing replacement content is protected. No additional carry-forward selections are submitted.</p>
    <details className="rounded-md border p-3" open>
      <summary className="cursor-pointer font-semibold">Source evidence and proposed rows</summary>
      <div className="mt-3 space-y-3">
        <div><h4 className="font-semibold">Source findings</h4><EvidenceValue value={verification.sourceFindings} /></div>
        {verification.failures != null && <div><h4 className="font-semibold">Source / extraction findings · cannot be waived</h4><EvidenceValue value={verification.failures} /></div>}
        {verification.coverage != null && <div><h4 className="font-semibold">Coverage findings</h4><EvidenceValue value={verification.coverage} /></div>}
        <div><h4 className="font-semibold">Initial OCR differences</h4><EvidenceValue value={verification.initialComparison} /></div>
        <div><h4 className="font-semibold">Proposed rows</h4><EvidenceValue value={rows} /></div>
      </div>
    </details>
    <fieldset disabled={readOnly || !sourceUrl || !rows.length} className="space-y-3">
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={approval.reviewedOriginal}
        onChange={event => onChange({ ...approval, reviewedOriginal: event.target.checked })} />
        <span>I have reviewed the original source PDF and compared the supplied source evidence and every proposed row.</span></label>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={approval.initialDifferencesAreOcrErrors}
        onChange={event => onChange({ ...approval, initialDifferencesAreOcrErrors: event.target.checked })} />
        <span>I confirm the proposed re-extraction faithfully transcribes the original PDF. Any differences from the initial extraction are extraction errors, not changes to the contractor’s original quotation.</span></label>
      <div className="space-y-1">
        <label htmlFor="prepared-replacement-reason" className="font-semibold">Candidate approval reason (at least 12 characters)</label>
        <Textarea id="prepared-replacement-reason" minLength={12} required rows={3} value={approval.reason}
          onChange={event => onChange({ ...approval, reason: event.target.value })}
          placeholder="Explain why the proposed rows match the original PDF, citing source pages." />
      </div>
    </fieldset>
    {!rows.length && <p role="alert" className="text-destructive">Proposed rows are unavailable. Reload the extraction evidence before approving.</p>}
  </section>;
}
