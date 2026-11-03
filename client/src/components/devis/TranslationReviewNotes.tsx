import { useState } from "react";
import { ChevronDown, Lock, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DevisCheck } from "@shared/schema";

export type TranslationReviewCheck = Pick<DevisCheck, "id" | "devisId" | "lineItemId" | "origin" | "query" | "status">;

/** Operator-only reference. Never part of translation state, context, or export data. */
export function TranslationReviewNotes({ lineItemId, note, checks }: {
  lineItemId: number; note: string | null; checks: TranslationReviewCheck[];
}) {
  const [open, setOpen] = useState(false);
  const count = (note?.trim() ? 1 : 0) + checks.length;
  if (!count) return null;
  const panelId = `translation-review-notes-${lineItemId}`;
  const statuses: Record<string, string> = {
    open: "Open", awaiting_contractor: "Awaiting contractor", awaiting_architect: "Awaiting architect",
    resolved: "Resolved", withdrawn: "Withdrawn",
  };
  return <section className="rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20 print:hidden"
    data-testid={`translation-review-${lineItemId}`}>
    <Button type="button" variant="ghost" size="sm"
      className="h-auto w-full justify-start gap-2 whitespace-normal py-2 text-left text-xs"
      aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
      <MessageSquare className="h-3.5 w-3.5 shrink-0" />
      <span>Notes / questions ({count}) <span className="font-normal text-muted-foreground">· Internal / contractor only</span></span>
      <ChevronDown className={`ml-auto h-3.5 w-3.5 shrink-0 ${open ? "rotate-180" : ""}`} />
    </Button>
    {open && <div id={panelId} className="space-y-3 border-t border-amber-200/70 p-3 text-xs dark:border-amber-900">
      <p className="flex items-start gap-1.5 font-medium text-amber-900 dark:text-amber-200">
        <Lock className="mt-0.5 h-3 w-3 shrink-0" />
        Internal / contractor notes — not included in translations or client documents.
      </p>
      {note?.trim() && <div>
        <p className="mb-1 font-semibold">Internal line note</p>
        <p className="whitespace-pre-wrap break-words">{note}</p>
      </div>}
      {checks.map(check => <div key={check.id}>
        <p className="mb-1 font-semibold">Contractor question · {statuses[check.status] ?? check.status.replace(/_/g, " ")}</p>
        <p className="whitespace-pre-wrap break-words">{check.query}</p>
      </div>)}
      <p className="text-muted-foreground">Read-only reference. Manage these notes and questions in Line Items.</p>
    </div>}
  </section>;
}
