import { Fragment, useEffect, useMemo, useState } from "react";
import { Copy, Download, MessageSquare, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Amount } from "@/components/ui/amount";
import { useToast } from "@/hooks/use-toast";
import {
  MEETING_SECTION_LABEL, WORKSHEET_TAGS, groupWorksheetLines,
  type WorksheetLineData, type WorksheetLineResult, type WorksheetStatus, type WorksheetTag,
} from "@shared/quotation-worksheet";
import { useWorksheet, type WorksheetDetail } from "./use-client-worksheet";
import { QuotationChecksPanel } from "./QuotationChecksPanel";

const euros = (c: number) => c / 100;
const STATUS_STYLE: Record<WorksheetStatus, string> = {
  Unchanged: "bg-slate-100 text-slate-600 border-slate-200",
  Modified: "bg-amber-50 text-amber-800 border-amber-200",
  Removed: "bg-rose-50 text-rose-700 border-rose-200",
  Added: "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Not priced": "bg-violet-50 text-violet-700 border-violet-200",
};
const ACTION_LABELS: Record<string, string> = {
  create: "Worksheet created from the quotation", duplicate: "Worksheet duplicated", update_line: "Line changed",
  add_line: "Line added", remove_line: "Line removed", restore_line: "Line restored", delete_line: "Added line deleted",
  update_settings: "Worksheet details changed",
};
const fmtDate = (v: string) => new Date(v).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" });
const trimNum = (v: string | null) => (v == null ? "" : String(Number(v)));

/** Commits on blur/Enter; reverts to the saved value on Escape. */
function CellInput({ value, onCommit, disabled, testId, placeholder, className, inputMode = "decimal" }: {
  value: string; onCommit: (v: string) => void; disabled?: boolean; testId: string; placeholder?: string; className?: string;
  inputMode?: "decimal" | "text";
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input value={draft} disabled={disabled} placeholder={placeholder} inputMode={inputMode}
      className={`h-7 px-1.5 text-right text-xs ${className ?? ""}`} data-testid={testId}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { if (draft.trim() !== value) onCommit(draft.trim().replace(",", ".")); }}
      onKeyDown={e => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { setDraft(value); (e.target as HTMLInputElement).blur(); }
      }} />
  );
}

function Money({ cents, testId, notPriced }: { cents: number | null; testId?: string; notPriced?: boolean }) {
  if (cents == null) return <span className="text-[11px] italic text-violet-700" data-testid={testId}>{notPriced === false ? "—" : "Not priced"}</span>;
  return <span data-testid={testId}><Amount value={euros(cents)} denomination="none" /></span>;
}

export function ClientWorksheetEditor({ worksheetId, devisId, onClose, onOpenWorksheet }: {
  worksheetId: number; devisId: number; onClose: () => void; onOpenWorksheet: (id: number) => void;
}) {
  const { toast } = useToast();
  const { data, isLoading, error, send, duplicate: duplicateWorksheet, flush, saving } = useWorksheet(worksheetId, devisId);
  const [downloading, setDownloading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const run = (p: Promise<unknown>, done?: string) => p.then(() => { if (done) toast({ title: done }); })
    .catch((e: Error) => toast({ title: "Not saved", description: e.message, variant: "destructive" }));

  const groups = useMemo(() => (data ? groupWorksheetLines(data.lines) : []), [data]);
  const results = useMemo(() => new Map((data?.computed.lines ?? []).map(r => [r.id, r])), [data]);

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading worksheet…</p>;
  if (error || !data) return <p className="p-6 text-sm text-rose-700">{(error as Error)?.message ?? "Worksheet unavailable."}</p>;
  const readOnly = !!data.readOnlyReason;
  const w = data.worksheet, c = data.computed;
  const lotLabels = groups.filter(g => g.section === "lot").map(g => g.label);

  const patchLine = (line: WorksheetLineData, body: Record<string, unknown>) => run(send("PATCH", `/lines/${line.id}`, body));
  const duplicate = () => {
    const title = window.prompt("Name for the copy", `${w.title} (copy)`);
    if (!title?.trim()) return;
    run(duplicateWorksheet(title.trim()).then(d => onOpenWorksheet(d.worksheet.id)), "Worksheet duplicated");
  };
  // Wait for every queued edit to save so the file has the figures on screen.
  const download = async () => {
    setDownloading(true);
    try {
      await flush();
      window.location.assign(`/api/worksheets/${w.id}/export.xlsx`);
    } catch (e) {
      toast({ title: "Not downloaded", description: `Your last change was not saved (${(e as Error).message}). The worksheet has been reloaded; check the figures and download again.`, variant: "destructive" });
    } finally { setDownloading(false); }
  };

  return (
    <div className="flex h-full flex-col" data-testid={`client-worksheet-${w.id}`}>
      <div className="flex flex-wrap items-start gap-3 border-b px-5 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Client worksheet · {data.quotation.contractorName} · {data.quotation.number ?? data.quotation.code}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <CellInput inputMode="text" className="h-8 w-72 text-left text-sm font-semibold" value={w.title} disabled={readOnly}
              testId="input-worksheet-title" onCommit={v => v && run(send("PATCH", "", { title: v }))} />
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">Meeting
              <Input type="date" className="h-8 w-36 text-xs" value={w.meetingDate ?? ""} disabled={readOnly} data-testid="input-worksheet-meeting-date"
                onChange={e => run(send("PATCH", "", { meetingDate: e.target.value || null }))} />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">Deposit %
              <CellInput className="h-8 w-16" value={trimNum(w.depositPercent)} disabled={readOnly} placeholder="none" testId="input-worksheet-deposit"
                onCommit={v => run(send("PATCH", "", { depositPercent: v || null }))} />
            </label>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Working copy for discussion. The contractor's quotation, its PDF and any signed figures are never changed. Every edit is recorded.
            {saving && <span className="ml-2 text-amber-700" data-testid="text-worksheet-saving">Saving…</span>}
          </p>
          {readOnly && <p className="mt-1 text-[11px] font-medium text-rose-700" data-testid="text-worksheet-readonly">{data.readOnlyReason}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={download} disabled={downloading} data-testid="button-worksheet-download">
            <Download className="mr-1.5 h-3.5 w-3.5" />{downloading ? (saving ? "Saving changes…" : "Preparing…") : "Download Excel"}
          </Button>
          <Button size="sm" variant="outline" onClick={duplicate} disabled={readOnly} data-testid="button-worksheet-duplicate">
            <Copy className="mr-1.5 h-3.5 w-3.5" />Duplicate
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} data-testid="button-worksheet-close"><X className="h-4 w-4" /></Button>
        </div>
      </div>

      <WorksheetSummaryBar data={data} />

      <div className="flex-1 overflow-auto px-5 pb-6">
        <div className="py-3">
          <QuotationChecksPanel devisId={devisId} isArchived={readOnly} hasLines worksheetId={w.id} beforeWorksheetChange={flush} />
        </div>
        <table className="w-full border-collapse text-xs" data-testid="table-worksheet">
          <thead className="sticky top-0 z-10 bg-slate-800 text-[10px] uppercase tracking-wide text-white">
            <tr>
              <th className="px-1.5 py-2 text-left">Item</th>
              <th className="px-1.5 py-2 text-left">Description</th>
              <th className="px-1.5 py-2 text-left">Unit</th>
              <th className="px-1.5 py-2 text-right">Orig. qty</th>
              <th className="px-1.5 py-2 text-right">Orig. unit HT</th>
              <th className="px-1.5 py-2 text-right">Orig. total HT</th>
              <th className="w-20 px-1.5 py-2 text-right">Client qty</th>
              <th className="w-24 px-1.5 py-2 text-right">Client unit HT</th>
              <th className="px-1.5 py-2 text-right">Revised HT</th>
              <th className="px-1.5 py-2 text-right">Difference</th>
              <th className="px-1.5 py-2 text-left">Status</th>
              <th className="w-14 px-1.5 py-2 text-right">VAT %</th>
              <th className="px-1.5 py-2" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g, gi) => {
              const lot = c.lots[gi];
              const key = g.section === "meeting" ? "meeting" : `lot:${g.label}`;
              return (
                <Fragment key={key}>
                  <tr className="bg-slate-200 font-semibold">
                    <td className="px-1.5 py-1.5">{g.section === "meeting" ? "M" : gi + 1}</td>
                    <td className="px-1.5 py-1.5" colSpan={12}>{g.label}</td>
                  </tr>
                  {g.lines.map(line => (
                    <WorksheetRow key={line.id} line={line} result={results.get(line.id)!} readOnly={readOnly}
                      expanded={expanded === line.id} onToggle={() => setExpanded(expanded === line.id ? null : line.id)}
                      lotLabels={lotLabels} onPatch={body => patchLine(line, body)}
                      onDelete={() => run(send("DELETE", `/lines/${line.id}`), "Added line deleted")} />
                  ))}
                  <tr className="bg-slate-50 font-semibold" data-testid={`row-worksheet-subtotal-${gi}`}>
                    <td />
                    <td className="px-1.5 py-1.5">
                      Sous-total — {g.label}
                      {lot.notPricedCount > 0 && <span className="ml-2 text-[10px] font-normal text-violet-700">{lot.notPricedCount} not priced</span>}
                    </td>
                    <td colSpan={3} />
                    <td className="px-1.5 text-right"><Money cents={lot.originalHtCents} /></td>
                    <td colSpan={2} />
                    <td className="px-1.5 text-right"><Money cents={lot.revisedHtCents} /></td>
                    <td className="px-1.5 text-right"><Money cents={lot.revisedHtCents - lot.originalHtCents} /></td>
                    <td colSpan={2} />
                    <td className="px-1.5 text-right">
                      {!readOnly && g.section === "lot" && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setAdding(key)} data-testid={`button-worksheet-add-to-lot-${gi}`}>
                          <Plus className="mr-1 h-3 w-3" />Line
                        </Button>
                      )}
                    </td>
                  </tr>
                  {adding === key && (
                    <AddLineRow section={g.section} lotLabel={g.label} onCancel={() => setAdding(null)}
                      onAdd={body => run(send("POST", "/lines", body).then(() => setAdding(null)), "Line added")} />
                  )}
                </Fragment>
              );
            })}
            {!groups.some(g => g.section === "meeting") && (
              <tr><td colSpan={13} className="pt-4">
                {!readOnly && adding !== "meeting" && (
                  <Button size="sm" variant="outline" onClick={() => setAdding("meeting")} data-testid="button-worksheet-add-meeting">
                    <Plus className="mr-1.5 h-3.5 w-3.5" />Add a meeting addition
                  </Button>
                )}
              </td></tr>
            )}
            {groups.some(g => g.section === "meeting") && !readOnly && adding !== "meeting" && (
              <tr><td colSpan={13} className="pt-2">
                <Button size="sm" variant="ghost" onClick={() => setAdding("meeting")} data-testid="button-worksheet-add-meeting">
                  <Plus className="mr-1.5 h-3.5 w-3.5" />Add another meeting addition
                </Button>
              </td></tr>
            )}
            {adding === "meeting" && !groups.some(g => g.section === "meeting") && (
              <AddLineRow section="meeting" lotLabel={MEETING_SECTION_LABEL} onCancel={() => setAdding(null)}
                onAdd={body => run(send("POST", "/lines", body).then(() => setAdding(null)), "Line added")} />
            )}
          </tbody>
        </table>

        <div className="mt-6">
          <Button size="sm" variant="ghost" onClick={() => setShowHistory(v => !v)} data-testid="button-worksheet-history">
            {showHistory ? "Hide" : "Show"} change history ({data.history.length})
          </Button>
          {showHistory && (
            <ul className="mt-2 space-y-1 text-[11px]" data-testid="list-worksheet-history">
              {data.history.map(h => {
                const line = h.lineId ? data.lines.find(l => l.id === h.lineId) : null;
                const item = line ? results.get(line.id)?.item : null;
                return (
                  <li key={h.id} className="rounded border bg-white px-2 py-1">
                    <span className="font-medium">{ACTION_LABELS[h.action] ?? h.action}</span>
                    {item && <span className="text-muted-foreground"> · item {item}</span>}
                    <span className="text-muted-foreground"> · {h.actor} · {fmtDate(h.at)}</span>
                    {h.after && h.action !== "create" && <span className="block text-muted-foreground">{describeChange(h.before, h.after)}</span>}
                    {h.reason && <span className="block italic">Why: {h.reason}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function describeChange(before: Record<string, unknown> | null, after: Record<string, unknown>) {
  const labels: Record<string, string> = { clientQuantity: "client qty", clientUnitPrice: "client unit price", vatRate: "VAT %",
    note: "note", tag: "tag", lotLabel: "lot", description: "description", unit: "unit", title: "name", meetingDate: "meeting date", depositPercent: "deposit %" };
  return Object.keys(after).filter(k => labels[k]).map(k => {
    const fmt = (v: unknown) => (v == null || v === "" ? "—" : k === "tag" ? WORKSHEET_TAGS[v as WorksheetTag] ?? String(v) : String(v));
    return before ? `${labels[k]}: ${fmt(before[k])} → ${fmt(after[k])}` : `${labels[k]}: ${fmt(after[k])}`;
  }).join(" · ");
}

function WorksheetSummaryBar({ data }: { data: WorksheetDetail }) {
  const c = data.computed;
  const cell = (label: string, o: number | null, r: number | null, id: string) => (
    <div className="rounded border bg-white px-3 py-2" data-testid={`summary-worksheet-${id}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-[11px] text-muted-foreground">Original {o == null ? "—" : <Amount value={euros(o)} denomination="none" />}</p>
      <p className="text-sm font-semibold">{r == null ? "—" : <Amount value={euros(r)} denomination="none" />}</p>
      {o != null && r != null && <p className={`text-[11px] ${r - o < 0 ? "text-emerald-700" : r - o > 0 ? "text-rose-700" : "text-muted-foreground"}`}>
        {r - o > 0 ? "+" : ""}<Amount value={euros(r - o)} denomination="none" /></p>}
    </div>
  );
  return (
    <div className="border-b bg-slate-50 px-5 py-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {cell("Total HT", c.original.htCents, c.revised.htCents, "ht")}
        {cell(c.vat.length ? `VAT (${c.vat.map(v => `${v.rate.replace(".", ",")} %`).join(" + ")})` : "VAT", c.original.vatCents, c.revised.vatCents, "vat")}
        {cell("Total TTC", c.original.ttcCents, c.revised.ttcCents, "ttc")}
        {cell(data.worksheet.depositPercent == null ? "Deposit (no % set)" : `Deposit ${Number(data.worksheet.depositPercent)} % of TTC`, c.original.depositCents, c.revised.depositCents, "deposit")}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-worksheet-counts">
        {c.counts.Unchanged} unchanged · {c.counts.Modified} modified · {c.counts.Removed} removed · {c.counts.Added} added
        {c.notPricedCount > 0 && <span className="text-violet-700"> · {c.notPricedCount} not priced (not counted until priced)</span>}
        {c.unknownVatLineCount > 0 && <span className="text-amber-700"> · VAT rate unknown on {c.unknownVatLineCount} line(s), so their VAT is not included — enter the rate shown on the quotation</span>}
      </p>
    </div>
  );
}

function WorksheetRow({ line, result, readOnly, expanded, onToggle, onPatch, onDelete, lotLabels }: {
  line: WorksheetLineData; result: WorksheetLineResult; readOnly: boolean; expanded: boolean; onToggle: () => void;
  onPatch: (body: Record<string, unknown>) => void; onDelete: () => void; lotLabels: string[];
}) {
  const removed = result.status === "Removed";
  const original = result.kind !== "added";
  return (
    <>
      <tr className={`border-b align-top ${removed ? "bg-rose-50/40 text-muted-foreground" : ""}`} data-testid={`row-worksheet-line-${line.id}`}>
        <td className="px-1.5 py-1 font-mono text-[11px]">{result.item}</td>
        <td className={`max-w-[28rem] px-1.5 py-1 ${removed ? "line-through" : ""}`}>
          {result.kind === "added" && !readOnly
            ? <CellInput inputMode="text" className="text-left" value={line.description} testId={`input-worksheet-description-${line.id}`} onCommit={v => v && onPatch({ description: v })} />
            : <span className="whitespace-pre-line">{line.description}</span>}
          {(line.note || line.tag) && (
            <span className="mt-0.5 block text-[10px] text-sky-800">
              {line.tag && <span className="mr-1 rounded bg-sky-100 px-1">{WORKSHEET_TAGS[line.tag]}</span>}{line.note}
            </span>
          )}
        </td>
        <td className="px-1.5 py-1">{line.unit}</td>
        <td className="px-1.5 py-1 text-right">{original ? trimNum(line.originalQuantity) : ""}</td>
        <td className="px-1.5 py-1 text-right">{result.kind === "priced" ? <Money cents={Math.round(Number(line.originalUnitPrice) * 100)} /> : original ? <Money cents={null} /> : ""}</td>
        <td className="px-1.5 py-1 text-right">{original ? <Money cents={result.originalCents} testId={`text-worksheet-original-${line.id}`} /> : ""}</td>
        <td className="px-1 py-0.5"><CellInput value={trimNum(line.clientQuantity)} disabled={readOnly} testId={`input-worksheet-qty-${line.id}`}
          onCommit={v => onPatch({ clientQuantity: v === "" ? null : v })} /></td>
        <td className="px-1 py-0.5"><CellInput value={line.clientUnitPrice ?? ""} disabled={readOnly} testId={`input-worksheet-price-${line.id}`}
          placeholder={result.kind === "priced" ? "" : "price"} onCommit={v => onPatch({ clientUnitPrice: v === "" ? null : v })} /></td>
        <td className="px-1.5 py-1 text-right font-medium"><Money cents={result.revisedCents} testId={`text-worksheet-revised-${line.id}`} /></td>
        <td className={`px-1.5 py-1 text-right ${(result.differenceCents ?? 0) < 0 ? "text-emerald-700" : (result.differenceCents ?? 0) > 0 ? "text-rose-700" : ""}`}>
          {result.differenceCents == null ? "" : <Money cents={result.differenceCents} />}
        </td>
        <td className="px-1.5 py-1"><span className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[result.status]}`} data-testid={`status-worksheet-${line.id}`}>{result.status}</span></td>
        <td className="px-1 py-0.5"><CellInput value={trimNum(line.vatRate)} disabled={readOnly} placeholder="?" testId={`input-worksheet-vat-${line.id}`}
          onCommit={v => onPatch({ vatRate: v === "" ? null : v })} /></td>
        <td className="whitespace-nowrap px-1 py-0.5 text-right">
          <Button size="icon" variant="ghost" className="h-6 w-6" title="Note, tag and lot" onClick={onToggle} data-testid={`button-worksheet-note-${line.id}`}>
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
          {!readOnly && original && !removed && (
            <Button size="icon" variant="ghost" className="h-6 w-6 text-rose-700" title="Remove (quantity 0)" data-testid={`button-worksheet-remove-${line.id}`}
              onClick={() => onPatch({ clientQuantity: "0" })}><Trash2 className="h-3.5 w-3.5" /></Button>
          )}
          {!readOnly && original && removed && line.originalQuantity != null && (
            <Button size="icon" variant="ghost" className="h-6 w-6" title="Restore the original quantity and price" data-testid={`button-worksheet-restore-${line.id}`}
              onClick={() => onPatch({ clientQuantity: line.originalQuantity, ...(line.originalUnitPrice != null ? { clientUnitPrice: line.originalUnitPrice } : {}) })}>
              <RotateCcw className="h-3.5 w-3.5" /></Button>
          )}
          {!readOnly && !original && (
            <Button size="icon" variant="ghost" className="h-6 w-6 text-rose-700" title="Delete this added line" data-testid={`button-worksheet-delete-${line.id}`}
              onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></Button>
          )}
        </td>
      </tr>
      {expanded && <LineDetailsRow line={line} readOnly={readOnly} lotLabels={lotLabels} onPatch={onPatch} />}
    </>
  );
}

function LineDetailsRow({ line, readOnly, lotLabels, onPatch }: {
  line: WorksheetLineData; readOnly: boolean; lotLabels: string[]; onPatch: (body: Record<string, unknown>) => void;
}) {
  const [note, setNote] = useState(line.note ?? "");
  useEffect(() => setNote(line.note ?? ""), [line.note]);
  return (
    <tr className="border-b bg-sky-50/50">
      <td />
      <td colSpan={12} className="px-1.5 py-2">
        <div className="flex flex-wrap items-start gap-3">
          <label className="flex-1 text-[11px]">Why / note (shown in “Points to check”)
            <Textarea value={note} disabled={readOnly} rows={2} className="mt-1 text-xs" data-testid={`input-worksheet-note-${line.id}`}
              onChange={e => setNote(e.target.value)} onBlur={() => { if (note.trim() !== (line.note ?? "")) onPatch({ note: note }); }} />
          </label>
          <label className="text-[11px]">Tag
            <select className="mt-1 block h-8 rounded border bg-white px-2 text-xs" disabled={readOnly} value={line.tag ?? ""}
              data-testid={`select-worksheet-tag-${line.id}`} onChange={e => onPatch({ tag: e.target.value || null })}>
              <option value="">No tag</option>
              {Object.entries(WORKSHEET_TAGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          {line.section === "lot" && (
            <label className="text-[11px]">Lot
              <CellInput inputMode="text" className="mt-1 h-8 w-48 text-left" value={line.lotLabel} disabled={readOnly}
                testId={`input-worksheet-lot-${line.id}`} onCommit={v => v && onPatch({ lotLabel: v })} />
              <span className="block text-[10px] text-muted-foreground">Type an existing lot ({lotLabels.slice(0, 3).join(", ")}{lotLabels.length > 3 ? "…" : ""}) or a new name.</span>
            </label>
          )}
        </div>
      </td>
    </tr>
  );
}

function AddLineRow({ section, lotLabel, onAdd, onCancel }: {
  section: "lot" | "meeting"; lotLabel: string; onAdd: (body: Record<string, unknown>) => void; onCancel: () => void;
}) {
  const [f, setF] = useState({ description: "", unit: "", qty: "1", price: "", vat: "", note: "", tag: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(s => ({ ...s, [k]: e.target.value }));
  const n = (v: string) => (v.trim() === "" ? null : v.trim().replace(",", "."));
  return (
    <tr className="bg-emerald-50/60" data-testid={`row-worksheet-add-${section}`}>
      <td className="px-1.5 py-2 text-[10px] font-semibold text-emerald-800">New</td>
      <td className="px-1.5 py-2" colSpan={12}>
        <p className="mb-1 text-[11px] font-medium">{section === "meeting" ? "Add a line agreed or proposed in the meeting" : `Add a line to ${lotLabel}`}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Input className="h-8 w-80 text-xs" placeholder="Description" value={f.description} onChange={set("description")} data-testid="input-worksheet-new-description" />
          <Input className="h-8 w-16 text-xs" placeholder="Unit" value={f.unit} onChange={set("unit")} data-testid="input-worksheet-new-unit" />
          <Input className="h-8 w-20 text-xs" placeholder="Qty" value={f.qty} onChange={set("qty")} data-testid="input-worksheet-new-qty" />
          <Input className="h-8 w-28 text-xs" placeholder="Unit price HT" value={f.price} onChange={set("price")} data-testid="input-worksheet-new-price" />
          <Input className="h-8 w-20 text-xs" placeholder="VAT %" value={f.vat} onChange={set("vat")} data-testid="input-worksheet-new-vat" />
          <select className="h-8 rounded border bg-white px-2 text-xs" value={f.tag} onChange={set("tag")} data-testid="select-worksheet-new-tag">
            <option value="">No tag</option>
            {Object.entries(WORKSHEET_TAGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Input className="h-8 w-72 text-xs" placeholder="Why (note)" value={f.note} onChange={set("note")} data-testid="input-worksheet-new-note" />
          <Button size="sm" disabled={!f.description.trim()} data-testid="button-worksheet-new-save"
            onClick={() => onAdd({ section, ...(section === "lot" ? { lotLabel } : {}), description: f.description.trim(), unit: f.unit.trim() || null,
              clientQuantity: n(f.qty), clientUnitPrice: n(f.price), vatRate: n(f.vat), note: f.note.trim() || null, tag: f.tag || null })}>Add</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">Leave the price empty if it still has to be quoted — the line will show as “Not priced”. Enter the VAT rate the contractor will apply.</p>
      </td>
    </tr>
  );
}
