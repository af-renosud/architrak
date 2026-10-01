import { Link } from "wouter";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type { EmailDocumentWithFiling } from "@shared/email-document-filing";

const filingColors: Record<EmailDocumentWithFiling["filing"]["state"], string> = {
  processing: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  needs_review: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  filed: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  duplicate: "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  failed: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  removed: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  not_filed: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  mismatch: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
};

export function EmailExtractionStatus({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span>Extraction:</span>
      <StatusBadge status={status === "completed" ? "extracted" : status} size="sm" />
    </span>
  );
}

/** Both surfaces use the authoritative destination; never infer one from email.devisId. */
export function EmailDocumentFilingStatus({
  document,
  surface,
}: {
  document: EmailDocumentWithFiling;
  surface: "row" | "detail";
}) {
  const { filing } = document;
  return (
    <div className="mt-2 space-y-1" data-testid={`filing-${surface}-${document.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Project filing:</span>
        <span
          className={`rounded-md px-2 py-1 text-xs font-semibold ${filingColors[filing.state]}`}
          data-testid={`filing-status-${surface}-${document.id}`}
        >
          {filing.label}
        </span>
        {filing.destination && (
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" asChild>
            <Link
              href={filing.destination.href}
              data-testid={`filing-destination-${surface}-${document.id}`}
            >
              <ExternalLink size={12} aria-hidden="true" />
              {filing.destination.label}
            </Link>
          </Button>
        )}
      </div>
      {filing.reason && (
        <p className="text-xs text-muted-foreground break-words" data-testid={`filing-reason-${surface}-${document.id}`}>
          {filing.reason}
        </p>
      )}
    </div>
  );
}