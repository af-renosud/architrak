import { useMemo, useState } from "react";
import { quotationParagraph } from "@shared/quotation-paragraph";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDown, FileText, Languages, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import type { DevisTranslation, DevisLineItem, DevisTranslationLine, DevisTranslationHeader, DevisLineContext } from "@shared/schema";
import { DevisLineContextEditor } from "./DevisLineContextEditor";
import { DevisCostAnalysisCard } from "./DevisCostAnalysisCard";
import { TranslationReviewNotes, type TranslationReviewCheck } from "./TranslationReviewNotes";
import { quotationWorkBlocked, useQuotationWork } from "./quotation-review-state";

interface DevisTranslationSectionProps {
  devisId: number; devisCode: string; lineItems: DevisLineItem[];
  readOnly?: boolean;
  reviewChecks?: TranslationReviewCheck[]; reviewChecksLoading?: boolean; reviewChecksError?: boolean;
  onRetryReviewChecks?: () => void; workingLineNumber?: number | null; flashLineNumber?: number | null;
  onWorkingLineChange?: (lineNumber: number, lineItemId: number) => void;
}
/** Saved wording preview with inline context editing; financial/wording edits stay in the workspace. */
export function DevisTranslationSection({ devisId, devisCode, lineItems, reviewChecks = [],
  reviewChecksLoading, reviewChecksError, onRetryReviewChecks, workingLineNumber, flashLineNumber,
  onWorkingLineChange, readOnly = false }: DevisTranslationSectionProps) {
  const client = useQueryClient();
  const work = useQuotationWork(devisId);
  const [explanations, setExplanations] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const translation = useQuery<DevisTranslation>({
    queryKey: ["/api/devis", devisId, "translation"],
    refetchInterval: query => ["processing", "pending"].includes(query.state.data?.status ?? "") ? 3000 : false,
  });
  const contexts = useQuery<{ contexts: DevisLineContext[] }>({ queryKey: ["/api/devis", devisId, "line-contexts"] });
  const ordered = useMemo(() => [...lineItems].sort((a, b) => a.lineNumber - b.lineNumber), [lineItems]);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
    void client.invalidateQueries({ predicate: query => query.queryKey.includes("devis-readiness") });
  };
  const generate = useMutation({
    mutationFn: async () => {
      if (quotationWorkBlocked(devisId)) throw new Error("Save the working draft before generating a translation.");
      return (await apiRequest("POST", `/api/devis/${devisId}/translate`, { force: false })).json();
    }, onSuccess: refresh, onError: (cause: Error) => setError(cause.message),
  });
  const unlock = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/devis/${devisId}/translation/unlock`, {})).json(),
    onSuccess: refresh, onError: (cause: Error) => setError(cause.message),
  });
  const data = translation.data;
  const status = data?.status ?? "missing";
  const contextReadOnly = readOnly || status === "finalised" || ["processing", "pending"].includes(status);
  const header = data?.headerTranslated as DevisTranslationHeader | undefined;
  const lines = data?.lineTranslations as DevisTranslationLine[] | undefined;
  const open = () => window.dispatchEvent(new CustomEvent("quotation-review-open", { detail: devisId }));
  const pdf = (variant: string) => window.open(`/api/devis/${devisId}/pdf?variant=${variant}${explanations ? "&explanations=true" : ""}`, "_blank", "noopener,noreferrer");
  if (translation.isLoading) return <div aria-label="Loading saved translation" className="p-4 space-y-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (translation.isError) return <section role="alert" className="border rounded p-4 space-y-2"><p>Saved translation could not be loaded.</p><Button variant="outline" onClick={() => void translation.refetch()}>Retry translation</Button></section>;
  return <section className="space-y-4 rounded-md border bg-card p-4" data-testid={`section-translation-${devisId}`}>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h4 className="text-sm font-semibold inline-flex gap-2 items-center"><Languages size={16} />English client package · {devisCode}</h4>
        <p className="text-xs text-muted-foreground mt-1">{status === "finalised" ? "Approved saved version" : "Saved wording"} · use Review/edit quotation for wording and approval.</p>
        {!contextReadOnly && <p className="text-xs text-emerald-700 mt-1">Edit context text and images directly below each item. Changes save automatically; wait for Saved.</p>}</div>
      <Button size="sm" onClick={open}>Review/edit quotation</Button>
    </header>
    <div className="flex flex-wrap gap-2 items-center">
      <a className="inline-flex gap-2 items-center text-xs underline mr-2" href={`/api/devis/${devisId}/pdf?variant=original`} target="_blank" rel="noreferrer"><FileText size={13} />Original contractor PDF</a>
      <Button size="sm" variant="outline" onClick={() => pdf("combined")}><FileDown size={13} className="mr-2" />French + English PDF</Button>
      <Button size="sm" variant="outline" onClick={() => pdf("translation")}>English PDF</Button>
      <label className="text-xs flex items-center gap-2"><input type="checkbox" checked={explanations} onChange={event => setExplanations(event.target.checked)} />Show plain-English explanations</label>
    </div>
    {(status === "missing" || status === "failed") && <div className="border rounded p-4 space-y-3">
      <p className="text-xs">{status === "failed" ? data?.errorMessage || "Translation could not be generated." : "No English package yet. Generate a starting translation, then review it against the original."}</p>
      <Button size="sm" variant="outline" disabled={readOnly || generate.isPending || work.blocked} onClick={() => generate.mutate()}>{generate.isPending ? "Generating…" : "Generate initial English translation"}</Button>
    </div>}
    {["processing", "pending"].includes(status) && <div role="status" className="space-y-2"><p className="text-xs">Preparing English wording…</p><Skeleton className="h-24 w-full" /></div>}
    {status === "finalised" && <div className="flex flex-wrap items-center gap-3 text-xs"><Lock size={13} /><span>Approved {data?.approvedAt ? new Date(data.approvedAt).toLocaleString("en-GB") : ""}. The original PDF is unchanged.</span>
      <span>To change context here, reopen for review first. Approve the updated package again before sharing.</span>
      <Button size="sm" variant="outline" disabled={readOnly || unlock.isPending || work.blocked} onClick={() => unlock.mutate()}>Reopen for review</Button></div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {header && <div className="border-l-2 border-[#94734c] bg-[#f8f5ef] p-3 text-sm whitespace-pre-wrap space-y-2">
      <p>{header.description}</p><p>{header.summary}</p>{explanations && <p className="text-xs">{header.descriptionExplanation}</p>}
    </div>}
    {reviewChecksLoading && <Skeleton className="h-8 w-full" />}
    {reviewChecksError && <p role="alert" className="text-xs">Questions may be out of date. {onRetryReviewChecks && <Button size="sm" variant="outline" onClick={onRetryReviewChecks}>Retry notes</Button>}</p>}
    {contexts.isError && <p role="alert" className="text-xs">Context could not be loaded. <Button size="sm" variant="outline" onClick={() => void contexts.refetch()}>Retry context</Button></p>}
    {!ordered.length && <div className="rounded border border-dashed p-6"><p className="text-sm font-semibold">No working rows yet</p><p className="text-xs mt-2">Open Review/edit quotation to add a priced item or a context-only line.</p></div>}
    {ordered.map(line => {
      const english = lines?.find(item => item.lineNumber === line.lineNumber);
      return <article key={line.id} id={`line-anchor-translation-${devisId}-${line.lineNumber}`}
        data-testid={`row-translation-${devisId}-${line.lineNumber}`}
        className={`border rounded p-4 space-y-3 ${flashLineNumber === line.lineNumber || workingLineNumber === line.lineNumber ? "border-[#94734c] bg-[#f8f5ef]" : ""}`}
        onClickCapture={() => onWorkingLineChange?.(line.lineNumber, line.id)}>
        <h5 className="text-xs font-semibold">Item {line.lineNumber} · saved wording</h5>
        <div className="grid gap-4 md:grid-cols-2">
          <div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">French</p><p className="text-xs mt-1">{quotationParagraph(line.description)}</p></div>
          <div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">English</p><p className="text-xs mt-1">{quotationParagraph(english?.translation) || "English wording needs review."}</p></div>
        </div>
        {explanations && english?.explanation && <p className="text-xs whitespace-pre-wrap">{english.explanation}</p>}
        <TranslationReviewNotes lineItemId={line.id} note={line.checkNotes}
          checks={reviewChecks.filter(check => check.devisId === devisId && check.lineItemId === line.id && check.origin === "line_item" && check.query.trim())} />
        {contexts.data && <DevisLineContextEditor devisId={devisId} lineItemId={line.id} lineNumber={line.lineNumber}
          context={contexts.data.contexts.find(context => context.devisLineItemId === line.id) ?? null} readOnly={contextReadOnly} workScope="inline" />}
      </article>;
    })}
    <DevisCostAnalysisCard devisId={devisId} translationFinalised={status === "finalised"} />
  </section>;
}
