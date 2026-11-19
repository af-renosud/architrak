import type { DevisLineContext } from "@shared/schema";
import { isContextDocEmpty, type ContextDoc } from "@shared/context-doc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuotationWork } from "./quotation-review-state";
import { useContextGeneration, useGenerateLineContext } from "./useContextGeneration";

export function LineContextGenerationAction({ devisId, lineItemId, context, disabled = false }: {
  devisId: number; lineItemId: number; context: DevisLineContext | null; disabled?: boolean;
}) {
  const work = useQuotationWork(devisId);
  const empty = !context || isContextDocEmpty(context.document as ContextDoc);
  const generate = useGenerateLineContext(devisId, lineItemId, disabled || !empty);
  return <div className="space-y-1">
    {empty && <Button type="button" size="sm" variant="outline"
      disabled={disabled || work.blocked || generate.isPending}
      onClick={() => generate.mutate()}>
      {generate.isPending ? "Generating explanation…" : generate.isError ? "Retry explanation" : "Generate explanation"}
    </Button>}
    {generate.isPending && <div role="status" className="space-y-1"><p className="text-xs text-muted-foreground">Preparing an AI draft with sources…</p><Skeleton className="h-8 w-full" /></div>}
    {generate.isError && <p role="alert" className="text-xs text-destructive">{generate.error.message}</p>}
    {generate.data?.warning && <p role="status" className="text-xs text-amber-800 dark:text-amber-300">{generate.data.warning}</p>}
  </div>;
}

export function ContextGenerationActions({ devisId, disabled, translationStatus, hasLines }: {
  devisId: number; disabled: boolean; translationStatus: string; hasLines: boolean;
}) {
  const work = useQuotationWork(devisId);
  const { state, start } = useContextGeneration(devisId, disabled, translationStatus);
  const progress = state.data;
  return <div className="space-y-2 rounded border border-emerald-200 bg-emerald-50/40 p-3 dark:border-emerald-900 dark:bg-emerald-950/20">
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline"
        disabled={disabled || !hasLines || work.blocked || start.isPending || !progress || state.isError || progress.running}
        onClick={() => start.mutate()}>
        {start.isPending ? "Starting context drafts…" : progress?.running ? "Filling empty contexts…" : progress?.failed || start.isError || progress?.error ? "Retry empty contexts" : "Fill empty contexts"}
      </Button>
      <p className="text-xs text-muted-foreground">AI draft · review before sharing. Included in ordinary translation approval.</p>
    </div>
    <p className="text-xs text-muted-foreground">Only empty saved contexts are filled. Existing text and images stay untouched. Sources are linked in the context.</p>
    {state.isLoading && <Skeleton aria-label="Checking context generation" className="h-5 w-full" />}
    {progress && (progress.running || progress.completed > 0 || progress.skipped > 0 || progress.failed > 0) &&
      <p role="status" className="text-xs">
        {progress.running ? "Preparing contexts" : "Context generation finished"} · {progress.completed} filled · {progress.skipped} skipped · {progress.failed} failed
      </p>}
    {(state.isError || start.isError || progress?.error || (!!progress?.failed && !progress.running)) &&
      <div role="alert" className="space-y-1 text-xs text-destructive">
        {state.isError && <p>Could not check context generation: {state.error.message} <Button type="button" size="sm" variant="outline" onClick={() => void state.refetch()}>Retry status</Button></p>}
        {start.isError && <p>{start.error.message}</p>}
        {progress?.error && <p>{progress.error}</p>}
        {!!progress?.failed && !progress.running && <p>Some contexts could not be generated. Retry empty contexts; saved content will not be replaced.</p>}
      </div>}
  </div>;
}
