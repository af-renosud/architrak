import type { QuotationExceptionReview } from "@shared/quotation-exceptions";
import { Button } from "@/components/ui/button";
import { quotationFieldLabel } from "./quotation-review-labels";

export interface QuotationReviewTarget { devisId: number; rowId?: number; field?: string; page?: number }

export function QuotationExceptions({ review, devisId, sourceUrl, disabled, historicalIssues }: {
  review: QuotationExceptionReview;
  devisId: number;
  sourceUrl?: string;
  disabled: boolean;
  historicalIssues: Array<Record<string, unknown>>;
}) {
  const count = review.groups.reduce((total, group) => total + group.issues.length, 0);
  return <section className="review-exceptions" aria-label="Structured extraction exceptions">
    <header className="review-exceptions-heading">
      <h3>{review.resolvedByHumanReview ? "Resolved by human review" : "Current extraction findings"}</h3>
      <p>{review.resolvedByHumanReview
        ? "Audited human corrections have resolved the extraction review. This is not quotation approval; source, financial and approval checks still apply."
        : count > 0 ? `${count} current findings to review against the original PDF. No changes are applied automatically.`
          : "No current findings supplied. This does not establish extraction accuracy or quotation approval."}</p>
    </header>
    {review.groups.filter(group => group.issues.length > 0).map(group =>
      <section key={group.id} className="review-exceptions-group" aria-label={group.label}>
        <h4>{group.label} · {group.issues.length}</h4>
        <ul>{group.issues.map(issue => {
          const editableTarget = issue.resolution === "edit_figures" || issue.resolution === "review_translation"
            || issue.resolution === "review_source";
          const page = issue.target.page;
          return <li key={`${issue.code}:${issue.key}:${issue.target.rowId ?? ""}:${issue.target.field ?? ""}`} className="review-exceptions-item">
            <div className="review-exceptions-meta">
              <span className="review-exceptions-severity" data-severity={issue.severity}>{issue.severity}</span>
              {issue.target.field && <span>{quotationFieldLabel(issue.target.field)}</span>}
            </div>
            <p>{issue.message}</p>
            <details className="mt-2 text-[10px] text-muted-foreground">
              <summary className="cursor-pointer">Technical details</summary>
              <dl className="mt-2 space-y-1">
                <div><dt className="inline">Issue code: </dt><dd className="inline"><code>{issue.code}</code></dd></div>
                {issue.target.rowId != null && <div><dt className="inline">Stable row ID: </dt><dd className="inline">{issue.target.rowId}</dd></div>}
                {issue.target.field && <div><dt className="inline">Field key: </dt><dd className="inline"><code>{issue.target.field}</code></dd></div>}
              </dl>
            </details>
            {!review.resolvedByHumanReview && <div className="review-exceptions-actions">
              {sourceUrl && <a href={`${sourceUrl.split("#")[0]}${Number.isSafeInteger(page) && page! > 0 ? `#page=${page}` : ""}`}
                target="_blank" rel="noopener noreferrer">
                {Number.isSafeInteger(page) && page! > 0 ? `Original PDF · page ${page}` : "Original PDF"}
              </a>}
              {editableTarget && <Button type="button" size="sm" variant="outline" disabled={disabled}
                onClick={() => window.dispatchEvent(new CustomEvent<QuotationReviewTarget>("quotation-review-open", {
                  detail: { devisId, rowId: issue.target.rowId, field: issue.target.field },
                }))}>{issue.target.rowId != null ? "Review/edit working row" : "Review/edit working quotation"}</Button>}
            </div>}
          </li>;
        })}</ul>
      </section>)}
    <details className="review-exceptions-history">
      <summary>Historical extraction warnings · {review.historicalWarningCount}</summary>
      <p>Historical machine warnings are not current unresolved findings. They do not override audited human corrections. Full source evidence remains available below.</p>
      {historicalIssues.length > 0 && <ul>{historicalIssues.map((issue, index) =>
        <li key={index}>Item {String(issue.line ?? "not stated")} — {String(issue.reason ?? "Source evidence is unavailable.")}</li>)}</ul>}
    </details>
  </section>;
}
