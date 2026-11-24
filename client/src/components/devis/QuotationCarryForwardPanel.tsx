import type { CarryForwardPreview, CarryForwardSelection, CarryLine } from "@shared/quotation-carry-forward";
import { CarryForwardContextPreview } from "./CarryForwardContextPreview";
import { automaticCarryTarget, hasCarryWork, hasLineContext, hasLineTranslation, hasLineWork } from "./use-quotation-carry-forward";

function LineText({ line }: { line: CarryLine }) {
  return <div className="space-y-1">
    <p className="whitespace-pre-wrap break-words"><span className="font-semibold">Line {line.lineNumber} · </span>{line.description}</p>
    <p className="text-xs tabular-nums text-muted-foreground">Quantity {line.quantity} {line.unit ?? ""} · Unit price {line.unitPriceHt} · Total HT {line.totalHt}</p>
  </div>;
}

export function QuotationCarryForwardPanel({ preview, selection, onChange, readOnly = false, automaticRetention = true }: {
  preview: CarryForwardPreview;
  selection: CarryForwardSelection;
  onChange: (selection: CarryForwardSelection) => void;
  readOnly?: boolean;
  automaticRetention?: boolean;
}) {
  const disabled = readOnly || !!preview.blockedReason;
  const allSourceLines = preview.sourceLines.filter(hasLineWork);
  const automaticLines = automaticRetention ? allSourceLines.filter(source => automaticCarryTarget(preview, source)) : [];
  const sourceLines = allSourceLines.filter(source => !automaticLines.includes(source));
  const automaticTargetIds = new Set(automaticLines.map(source => source.suggestedTargetId));
  const awaiting = sourceLines.filter(source => {
    const chosen = selection.lines.find(line => line.sourceLineId === source.id);
    return (hasLineContext(source) && !chosen?.context) || (hasLineTranslation(source) && !chosen?.translation) || (!!source.wordingChanged && !chosen?.wording);
  });

  function mapLine(source: CarryLine, targetId: number | null) {
    const others = selection.lines.filter(line => line.sourceLineId !== source.id);
    const target = preview.targetLines.find(line => line.id === targetId);
    const previous = selection.lines.find(line => line.sourceLineId === source.id);
    // A manual mapping is not consent to copy. Changed rows need explicit checkboxes.
    onChange({ ...selection, lines: target ? [...others, {
      sourceLineId: source.id, targetLineId: target.id,
      context: previous?.targetLineId === target.id && !!previous.context && !hasLineContext(target),
      translation: previous?.targetLineId === target.id && !!previous.translation && !hasLineTranslation(target),
       wording: previous?.targetLineId === target.id && !!previous.wording && target.id === source.suggestedTargetId && !target.wordingChanged,
    }] : others });
  }

  return <div className="space-y-5 text-sm" data-testid="quotation-carry-forward-panel">
    <div className="rounded-md border bg-muted/30 p-3">
      <p className="font-semibold">Retain previous work · quotation {preview.sourceId} → {preview.targetId}</p>
      <p className="mt-1 text-muted-foreground">{automaticRetention ? "Uniquely unchanged source items retain their working wording, context and translations automatically where the replacement has no existing work." : "Select previous work to copy to the recorded replacement. Suggested unchanged matches are preselected for review."} Existing replacement content is protected; originals remain accessible.</p>
      <p className="mt-2 font-medium">No signatures, approvals or financial history are copied. The target remains subject to draft review before approval or signature.</p>
    </div>
    {preview.blockedReason && <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">Previous work cannot be reviewed: {preview.blockedReason} Refresh the preview before continuing.</p>}
    {automaticRetention && <section className="space-y-3" aria-label="Automatic retention">
      <div>
        <h3 className="font-semibold">Retained automatically · {automaticLines.length} line(s)</h3>
        <p className="mt-1 text-xs text-muted-foreground">Matched against the original contractor source, not the edited working text. No selection is needed. Protected replacement content is never overwritten.</p>
      </div>
      {!automaticLines.length && <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">No unchanged items with previous work were identified. Review manual assignments below.</p>}
      {automaticLines.map(source => {
        const target = automaticCarryTarget(preview, source)!;
        return <article key={source.id} className="space-y-3 rounded-md border bg-muted/20 p-3" data-testid={`carry-automatic-line-${source.id}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-semibold">Original line {source.lineNumber} → Replacement line {target.lineNumber}</h4>
            <span className="text-xs font-medium text-muted-foreground">Unchanged source item</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">Previous work</p>
              <LineText line={source} />
              {hasLineTranslation(source) && <p className="whitespace-pre-wrap break-words"><span className="text-xs font-semibold">Translation · </span>{source.translation}</p>}
              {hasLineContext(source) && <div><p className="mb-1 text-xs font-semibold">Context · {source.imageCount} image(s)</p>{source.context && <CarryForwardContextPreview document={source.context} sourceId={preview.sourceId} />}</div>}
            </div>
            <div className="min-w-0 space-y-2 rounded-md border bg-background p-3">
              <p className="text-xs font-semibold text-muted-foreground">Replacement · retention summary</p>
              <LineText line={target} />
              <ul className="space-y-1 text-xs">
                {source.wordingChanged && <li>{target.wordingChanged ? "Working wording: existing replacement wording protected." : "Working wording: retained automatically."}</li>}
                {hasLineContext(source) && <li>{hasLineContext(target) ? "Context: existing replacement context protected." : "Context: retained automatically."}</li>}
                {hasLineTranslation(source) && <li>{hasLineTranslation(target) ? "Translation: existing replacement translation protected." : "Translation: retained automatically."}</li>}
              </ul>
              {hasLineTranslation(target) && <p className="whitespace-pre-wrap break-words text-xs"><span className="font-semibold">Protected translation · </span>{target.translation}</p>}
              {hasLineContext(target) && <div><p className="mb-1 text-xs font-semibold">Protected replacement context</p>{target.context && <CarryForwardContextPreview document={target.context} sourceId={preview.targetId} />}</div>}
            </div>
          </div>
        </article>;
      })}
    </section>}
    <section className="space-y-2">
      <h3 className="font-semibold">Quotation setup · optional</h3>
      <p className="text-xs text-muted-foreground">Exact proposed values are shown below, including the next available code where applicable.</p>
      {preview.setup.map(field => <label key={field.key} className="flex items-start gap-2 rounded-md border p-3">
        <input type="checkbox" className="mt-1" disabled={disabled || !field.available} checked={selection.setup.includes(field.key)}
          onChange={event => onChange({ ...selection, setup: event.target.checked ? [...selection.setup, field.key] : selection.setup.filter(key => key !== field.key) })} />
        <span className="min-w-0 flex-1"><span className="font-medium">{field.label}</span>
          <span className="mt-1 grid gap-2 break-words text-xs sm:grid-cols-2"><span><span className="text-muted-foreground">Proposed from previous quotation: </span>{field.from || "Empty"}</span><span><span className="text-muted-foreground">Current replacement value: </span>{field.to || "Empty"}</span></span>
          {!field.available && <span className="mt-1 block text-xs text-muted-foreground">Unavailable — target value is protected or this field cannot be copied.</span>}
        </span>
      </label>)}
      {!preview.setup.length && <p className="text-muted-foreground">No setup fields available.</p>}
    </section>
    <section className="space-y-2">
      <h3 className="font-semibold">Quotation header · optional</h3>
      <label className="flex items-center gap-2"><input type="checkbox" checked={selection.header} disabled={disabled || !preview.header.available} onChange={event => onChange({ ...selection, header: event.target.checked })} />Copy source header{!preview.header.available ? " — unavailable / target protected" : ""}</label>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border p-3"><p className="mb-1 text-xs font-semibold text-muted-foreground">Source header</p><p className="whitespace-pre-wrap break-words">{preview.header.source || "Empty"}</p></div>
        <div className="rounded-md border p-3"><p className="mb-1 text-xs font-semibold text-muted-foreground">Current target header</p><p className="whitespace-pre-wrap break-words">{preview.header.target || "Empty"}</p></div>
      </div>
    </section>
    <section className="space-y-3">
      <h3 className="font-semibold">{automaticRetention ? "Needs review · changed or ambiguous items" : "Line work · explicit recovery"}</h3>
      <p className="text-xs text-muted-foreground">For revised or unmatched lines, assign a target, compare the wording and amounts, then select available context or translation. Each target can be assigned once{automaticRetention ? "; automatically matched targets are reserved" : ""}. Existing content cannot be replaced.</p>
      {!sourceLines.length && <div className="rounded-md border border-dashed p-4 text-muted-foreground">No manual line assignments needed. Setup, header and PDFs remain optional.</div>}
      {sourceLines.map(source => {
        const chosen = selection.lines.find(line => line.sourceLineId === source.id);
        const target = preview.targetLines.find(line => line.id === chosen?.targetLineId);
        const exact = !!target && target.id === source.suggestedTargetId;
        const contextProtected = !!target && hasLineContext(target);
        const translationProtected = !!target && hasLineTranslation(target);
        return <article key={source.id} className="space-y-3 rounded-md border p-3" data-testid={`carry-source-line-${source.id}`}>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="min-w-0 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground">Original quotation</p><LineText line={source} />
              {source.wordingChanged && !exact && <p className="rounded-md border p-2 text-xs text-muted-foreground">Edited working wording stays on the original. It cannot be copied to a changed or ambiguous source item.</p>}
              <div><p className="mb-1 text-xs font-semibold">Previous translation</p><p className="whitespace-pre-wrap break-words">{source.translation || "No translation"}</p></div>
              <div><p className="mb-1 text-xs font-semibold">Full previous context · {source.imageCount} image(s)</p>{source.context ? <CarryForwardContextPreview document={source.context} sourceId={preview.sourceId} /> : <p className="text-muted-foreground">No context document</p>}</div>
            </div>
            <div className="min-w-0 space-y-3 rounded-md bg-muted/30 p-3">
              <label className="block space-y-1"><span className="text-xs font-semibold">Assign to replacement line</span>
                <select aria-label={`Target for source line ${source.lineNumber}`} className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                  value={target?.id ?? ""} disabled={disabled} onChange={event => mapLine(source, event.target.value ? Number(event.target.value) : null)}>
                  <option value="">Unassigned — retain on original</option>
                  {preview.targetLines.map(line => <option key={line.id} value={line.id} disabled={automaticTargetIds.has(line.id) || selection.lines.some(other => other.sourceLineId !== source.id && other.targetLineId === line.id)}>
                    Line {line.lineNumber} · {line.description} · {line.quantity} {line.unit ?? ""} × {line.unitPriceHt} = {line.totalHt}
                  </option>)}
                </select>
              </label>
              {target ? <>
                <p className="text-xs font-semibold text-amber-800">{exact ? "Unchanged source match — review selected work" : "Manual assignment — compare and explicitly select below"}</p>
                <LineText line={target} />
                <div><p className="text-xs font-semibold">Existing target translation</p><p className="whitespace-pre-wrap break-words">{target.translation || "Empty — available for copying"}</p></div>
                {contextProtected && <div><p className="mb-1 text-xs font-semibold">Existing target context — protected</p>{target.context && <CarryForwardContextPreview document={target.context} sourceId={preview.targetId} />}</div>}
              </> : <p className="text-xs text-muted-foreground">Previous context awaiting assignment. This work stays on the original quotation.</p>}
            </div>
          </div>
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:gap-6">
            {(["context", "translation", ...(!automaticRetention && source.wordingChanged ? ["wording" as const] : [])] as const).map(part => {
              const exists = part === "context" ? hasLineContext(source) : part === "translation" ? hasLineTranslation(source) : !!source.wordingChanged;
              const protectedPart = part === "context" ? contextProtected : part === "translation" ? translationProtected : !!target?.wordingChanged || !exact;
              return <label key={part} className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={!!chosen?.[part]} disabled={disabled || !target || !exists || protectedPart}
                  onChange={event => onChange({ ...selection, lines: selection.lines.map(line => line.sourceLineId === source.id ? { ...line, [part]: event.target.checked } : line) })} />
                <span>Copy {part}{protectedPart ? " — existing target work protected" : !exists ? " — none on source" : !target ? " — assign a target first" : " — I reviewed this revised mapping"}</span>
              </label>;
            })}
          </div>
        </article>;
      })}
    </section>
    <section className="space-y-2">
      <h3 className="font-semibold">Supporting PDFs · explicit selection</h3>
      {!preview.supportingPdfs.length && <p className="text-xs text-muted-foreground">No supporting PDFs to copy.</p>}
      {preview.supportingPdfs.map(pdf => <label key={pdf.id} className="flex items-start gap-2 rounded-md border p-3">
        <input type="checkbox" className="mt-1" disabled={disabled || pdf.alreadyPresent} checked={selection.supportingPdfIds.includes(pdf.id)}
          onChange={event => onChange({ ...selection, supportingPdfIds: event.target.checked ? [...selection.supportingPdfIds, pdf.id] : selection.supportingPdfIds.filter(id => id !== pdf.id) })} />
        <span className="break-words">{pdf.label} <span className="text-xs text-muted-foreground">· {pdf.fileName}{pdf.alreadyPresent ? " · Already on target" : ""}</span></span>
      </label>)}
    </section>
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900" role="status">
      <p className="font-semibold">Manual work remaining on the original · {awaiting.length} line(s)</p>
      <p className="mt-1 text-xs">Unselected manual work stays on the original, with no deletion. Use “Review previous work” in replacement history to review it later.{automaticRetention ? " Automatic retention is separate and does not require selection." : ""}</p>
      {!!awaiting.length && <p className="mt-1 text-xs">Original lines: {awaiting.map(line => line.lineNumber).join(", ")}</p>}
    </div>
    <p className="text-xs font-medium">{hasCarryWork(selection) ? `${selection.lines.filter(line => line.context).length} contexts · ${selection.lines.filter(line => line.translation).length} translations · ${selection.lines.filter(line => line.wording).length} wording edits · ${selection.setup.length} setup fields · ${selection.supportingPdfIds.length} PDFs${selection.header ? " · header" : ""} selected${automaticRetention ? " additionally" : ""}` : automaticRetention ? "No additional copying selected. Unchanged items retain previous work automatically." : "No work selected for recovery."}</p>
  </div>;
}
