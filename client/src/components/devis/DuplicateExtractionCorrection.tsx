import { useEffect, useId, useRef, useState } from "react";
import { Mic, ShieldCheck } from "lucide-react";
import type { DevisLineItem } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useDuplicateCorrection } from "./use-duplicate-correction";

// Browser speech recognition is optional and not part of TypeScript's DOM types.
interface SpeechSession {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechConstructor = new () => SpeechSession;
function speechConstructor(): SpeechConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const browser = window as Window & { SpeechRecognition?: SpeechConstructor; webkitSpeechRecognition?: SpeechConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

type CorrectionLine = Pick<DevisLineItem, "id" | "devisId" | "lineNumber" | "description" | "totalHt">;
interface Props {
  devisId: number;
  projectId: string;
  line: CorrectionLine;
  lines: CorrectionLine[];
  disabled?: boolean;
}

export function DuplicateExtractionCorrection({ devisId, projectId, line, lines, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [retainId, setRetainId] = useState<number | null>(null);
  const [lineSearch, setLineSearch] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [needsPreview, setNeedsPreview] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [speechError, setSpeechError] = useState("");
  const speech = useRef<SpeechSession | null>(null);
  const reasonRef = useRef(reason);
  reasonRef.current = reason;
  const submitLock = useRef(false);
  const mounted = useRef(true);
  const id = useId();
  const { toast } = useToast();
  // No inference from equal amounts or description similarity; selection is human.
  const counterparts = lines.filter((other) => other.devisId === devisId && other.id !== line.id);
  const visibleCounterparts = counterparts.filter(other =>
    `${other.lineNumber} ${other.description} ${other.totalHt}`.toLocaleLowerCase().includes(lineSearch.trim().toLocaleLowerCase()));
  const { preview, correction } = useDuplicateCorrection(devisId, projectId, line.id, retainId, open && !disabled);
  const data = preview.data;
  const validPreview = !needsPreview && !preview.isError && !preview.isFetching && !!data && data.blockedReason === null;
  const evidenceLine = data && !needsPreview && !preview.isError && !preview.isFetching ? data.removeLine : line;
  const canSubmit = !disabled && validPreview && !!reason.trim() && !listening && !correction.isPending;

  const abortSpeech = () => {
    const session = speech.current;
    speech.current = null;
    if (session) {
      session.onresult = null;
      session.onerror = null;
      session.onend = null;
      session.abort();
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; abortSpeech(); };
  }, []);
  useEffect(() => {
    if (disabled) {
      abortSpeech();
      setListening(false);
      setOpen(false);
    }
  }, [disabled]);

  const changeOpen = (next: boolean) => {
    if (submitLock.current) return;
    if (!next) {
      abortSpeech();
      setListening(false);
      setInterim("");
    }
    setOpen(next);
  };
  const startSpeech = () => {
    const Constructor = speechConstructor();
    if (!Constructor || speech.current || disabled) return;
    setSpeechError("");
    const session = new Constructor();
    speech.current = session;
    const base = reasonRef.current.trim();
    session.lang = navigator.language || "en-GB";
    session.continuous = true;
    session.interimResults = true;
    session.onresult = (event) => {
      if (speech.current !== session) return;
      const final: string[] = [];
      const partial: string[] = [];
      Array.from(event.results).forEach((result) => {
        (result.isFinal ? final : partial).push(result[0].transcript);
      });
      setReason([base, ...final].filter(Boolean).join(" "));
      setInterim(partial.join(" "));
    };
    session.onerror = (event) => {
      if (speech.current !== session) return;
      abortSpeech();
      setListening(false);
      setInterim("");
      setSpeechError(`Dictation failed (${event.error}). Your text is preserved; type or edit the reason below.`);
    };
    session.onend = () => {
      if (speech.current !== session) return;
      speech.current = null;
      setListening(false);
      setInterim("");
      // Never submit on speech completion. The transcript remains editable.
    };
    try {
      session.start();
      setListening(true);
    } catch {
      abortSpeech();
      setListening(false);
      setSpeechError("Dictation could not start. Please type your reason.");
    }
  };
  const submit = async () => {
    if (submitLock.current || !canSubmit || !data || retainId === null ||
        !counterparts.some((other) => other.id === retainId)) return;
    submitLock.current = true; // Synchronous: protects rapid clicks before React rerenders.
    setError("");
    try {
      await correction.mutateAsync({ removeLineId: line.id, retainLineId: retainId, reason: reason.trim(), fingerprint: data.fingerprint });
      if (mounted.current) {
        abortSpeech();
        setOpen(false);
        setReason("");
        setRetainId(null);
        toast({ title: "Duplicate extraction removed", description: "The contractor PDF and source quotation totals are unchanged." });
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Correction failed. Your reason has been preserved.");
        setNeedsPreview(true);
      }
    } finally {
      submitLock.current = false;
    }
  };

  return <>
    <Button type="button" variant="ghost" size="sm" className="h-auto px-1 py-1 text-[10px] text-muted-foreground"
      disabled={disabled} onClick={() => changeOpen(true)} data-testid={`remove-duplicate-extraction-${line.id}`}>
      Remove duplicate extraction
    </Button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base font-black uppercase tracking-tight">Remove duplicate extraction</DialogTitle>
          <DialogDescription>This repairs the extracted working rows, not the contractor quotation. Check the original PDF before confirming.</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-[#c1a27b]/40 bg-[#c1a27b]/10 p-3 text-xs flex gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-[#0B2545]" />
          <p>Source quantities, prices, totals and original PDF remain immutable. The reason, actor, timestamp and original row evidence are retained in the audit record.</p>
        </div>
        <div className="space-y-4 text-xs">
          <div className="border-l-2 border-[#c1a27b] pl-3">
            <p className="font-semibold">Remove extracted line #{evidenceLine.lineNumber}</p>
            <p className="whitespace-pre-wrap break-words">{evidenceLine.description}</p>
            <p className="font-mono mt-1">{evidenceLine.totalHt} EUR HT</p>
          </div>
          <div className="space-y-1">
            <p id={`${id}-retain`} className="font-semibold">Retained counterpart (same quotation)</p>
            <label className="sr-only" htmlFor={`${id}-search`}>Search quotation lines</label>
            <input id={`${id}-search`} type="search" value={lineSearch}
              onChange={event => setLineSearch(event.target.value)}
              disabled={correction.isPending || disabled}
              placeholder="Search by line number or description…"
              className="w-full min-w-0 rounded-md border border-input bg-background p-2 text-xs" />
            <p className="text-muted-foreground" role="status">
              {visibleCounterparts.length} of {counterparts.length} available lines · scroll to see more
            </p>
            <div role="radiogroup" aria-labelledby={`${id}-retain`}
              className="max-h-60 overflow-y-auto overscroll-contain rounded-md border border-input">
              {visibleCounterparts.map(other => <label key={other.id}
                className={`flex min-w-0 cursor-pointer items-start gap-2 border-b border-border p-3 last:border-b-0 ${retainId === other.id ? "bg-accent" : "hover:bg-muted/50"}`}>
                <input type="radio" name={`${id}-retained-line`} value={other.id}
                  checked={retainId === other.id} disabled={correction.isPending || disabled}
                  className="mt-0.5 shrink-0"
                  onChange={() => { setRetainId(other.id); setNeedsPreview(false); setError(""); }} />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">Line #{other.lineNumber} · {other.totalHt} EUR HT</span>
                  <span className="block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{other.description}</span>
                </span>
              </label>)}
              {!visibleCounterparts.length && counterparts.length > 0 && <p className="p-3">No matching lines. Clear the search to see all lines.</p>}
            </div>
            {retainId !== null && <p className="font-semibold">Selected: line #{counterparts.find(other => other.id === retainId)?.lineNumber}</p>}
            {!counterparts.length && <p>No other line in this quotation can be retained. Nothing can be removed.</p>}
          </div>
          {retainId !== null && preview.isFetching && <div aria-label="Loading financial preview" className="space-y-2"><Skeleton className="h-5 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {(preview.isError || needsPreview) && <div role="alert" className="rounded-md border border-destructive/30 p-3 space-y-2">
            <p>{preview.isError ? `Financial preview failed: ${preview.error.message}` : "Refresh the financial preview before retrying. No further correction will be submitted without a fresh preview."}</p>
            <Button type="button" variant="outline" size="sm" disabled={preview.isFetching} onClick={async () => {
              const result = await preview.refetch();
              if (!result.isError) setNeedsPreview(false);
            }}>Retry financial preview</Button>
          </div>}
          {data && !preview.isError && !preview.isFetching && !needsPreview && <section aria-label="Server financial preview" className="rounded-lg border border-border p-3">
            <p className="font-semibold mb-2">Financial impact · server calculation</p>
            <p className="mb-2 break-words">Retain #{data.retainLine.lineNumber}: {data.retainLine.description} · {data.retainLine.totalHt} EUR HT</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2">
              <dt>Source total HT · immutable</dt><dd className="font-mono">{data.sourceTotalHt} EUR</dd>
              <dt>Active line sum HT · before</dt><dd className="font-mono">{data.beforeSumHt} EUR</dd>
              <dt>Active line sum HT · after</dt><dd className="font-mono">{data.afterSumHt} EUR</dd>
              <dt>Discrepancy HT · before</dt><dd className="font-mono">{data.discrepancyBeforeHt} EUR</dd>
              <dt>Discrepancy HT · after</dt><dd className="font-mono">{data.discrepancyAfterHt} EUR</dd>
            </dl>
            <p className="mt-3 text-muted-foreground">Source totals are never adjusted to match the working sum. Options, discounts and tax conventions are handled by the server.</p>
            {data.blockedReason !== null && <p role="alert" className="mt-3 text-destructive font-semibold">Correction refused: {data.blockedReason}</p>}
          </section>}
          <div className="space-y-2">
            <label className="font-semibold" htmlFor={`${id}-reason`}>Reason for correcting this extraction (required)</label>
            <Textarea id={`${id}-reason`} value={reason} onChange={(event) => {
              if (listening) { abortSpeech(); setListening(false); setInterim(""); }
              setReason(event.target.value);
            }} disabled={correction.isPending || disabled} rows={4} placeholder="Explain why this extracted row duplicates the retained line." />
            {speechConstructor() ? <Button type="button" size="sm" variant="outline" disabled={correction.isPending || disabled}
              onClick={() => listening ? speech.current?.stop() : startSpeech()}>
              <Mic className="h-3 w-3 mr-2" />{listening ? "Stop dictation" : "Dictate reason"}
            </Button> : <p className="text-muted-foreground">Dictation is not supported in this browser. Type your reason above.</p>}
            {interim && <p role="status" className="text-muted-foreground">Listening: {interim}</p>}
            {speechError && <p role="alert">{speechError}</p>}
            <p className="text-muted-foreground">Review and edit your text before confirming. Dictation never submits a correction. Browser dictation may use your browser provider's speech service.</p>
          </div>
          {error && <p role="alert" className="text-destructive">{error} Your reason has been preserved.</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end border-t border-border pt-3">
            <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={correction.isPending}>Cancel</Button>
            <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>{correction.isPending ? "Recording correction…" : "Confirm duplicate extraction removal"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}