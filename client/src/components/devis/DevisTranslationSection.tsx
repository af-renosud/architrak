import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Languages, Loader2, RefreshCw, FileDown, ChevronDown, AlertTriangle, Lock, Unlock, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type {
  DevisTranslation,
  DevisLineItem,
  DevisTranslationLine,
  DevisTranslationHeader,
  DevisLineContext,
} from "@shared/schema";
import { DevisLineContextEditor } from "./DevisLineContextEditor";
import { DevisCostAnalysisCard } from "./DevisCostAnalysisCard";

interface DevisTranslationSectionProps {
  devisId: number;
  devisCode: string;
  lineItems: DevisLineItem[];
  /** Line number of the current "working line" (shared with the Line Items tab). */
  workingLineNumber?: number | null;
  /** Line number to briefly flash-highlight after an anchored tab switch. */
  flashLineNumber?: number | null;
  /** Called when the user interacts with a line so the parent can track it. */
  onWorkingLineChange?: (lineNumber: number, lineItemId: number) => void;
}

export function DevisTranslationSection({
  devisId,
  devisCode,
  lineItems,
  workingLineNumber = null,
  flashLineNumber = null,
  onWorkingLineChange,
}: DevisTranslationSectionProps) {
  const { toast } = useToast();
  const [showExplanations, setShowExplanations] = useState(false);
  const [localLines, setLocalLines] = useState<Map<number, DevisTranslationLine>>(new Map());
  const [localHeader, setLocalHeader] = useState<DevisTranslationHeader | null>(null);
  const initialisedFor = useRef<string | null>(null);

  // --- Serialized translation saves (Task 364) -----------------------------
  // PATCHes carry the FULL lines array, so two overlapping requests are a
  // last-write-wins race: an older payload can land after (and wipe) a newer
  // one. Saves are therefore single-flight: at most one PATCH in flight,
  // newer payloads coalesce into `pendingPatchRef` (each is rebuilt from the
  // latest local buffers, so keeping only the newest is lossless).
  // `dirtyRef` tracks unsaved local edits so (a) a background refetch never
  // rebuilds the edit buffers over in-progress typing, and (b) unmount can
  // flush a still-unsaved edit when the user navigates away without blurring.
  const [isSavingTranslation, setIsSavingTranslation] = useState(false);
  const pendingPatchRef = useRef<{
    patch: { header?: DevisTranslationHeader; lines?: DevisTranslationLine[] };
    epoch: number;
  } | null>(null);
  const saveInFlightRef = useRef(false);
  const dirtyRef = useRef(false);
  // Monotonic counter bumped on EVERY local edit (each keystroke). A payload
  // records the epoch of the buffers it was built from; dirty only clears
  // when the payload that just saved is still current — i.e. no keystroke
  // happened after it was built. This closes the lost-edit window where an
  // unblurred edit B typed during in-flight save A would otherwise be wiped
  // by the post-A refetch (A's success must NOT clear B's dirtiness).
  const editEpochRef = useRef(0);
  const markDirty = () => {
    dirtyRef.current = true;
    editEpochRef.current++;
  };

  const pumpTranslationSaves = async () => {
    if (saveInFlightRef.current) return;
    const pending = pendingPatchRef.current;
    if (!pending) return;
    pendingPatchRef.current = null;
    saveInFlightRef.current = true;
    setIsSavingTranslation(true);
    try {
      await apiRequest("PATCH", `/api/devis/${devisId}/translation`, pending.patch);
      if (!pendingPatchRef.current && editEpochRef.current === pending.epoch) {
        // Everything the user has typed so far is in the payload that just
        // saved — safe to let the next refetch rebuild the local buffers.
        dirtyRef.current = false;
        initialisedFor.current = null;
      }
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      // Task #374 — the readiness strip on the devis list summarises the
      // translation status; this component doesn't know its projectId, so
      // match the batch readiness query by key suffix.
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes("devis-readiness") });
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      saveInFlightRef.current = false;
      setIsSavingTranslation(false);
      if (pendingPatchRef.current) void pumpTranslationSaves();
    }
  };
  const pumpRef = useRef(pumpTranslationSaves);
  pumpRef.current = pumpTranslationSaves;

  const enqueueTranslationPatch = (patch: { header?: DevisTranslationHeader; lines?: DevisTranslationLine[] }) => {
    pendingPatchRef.current = {
      patch: { ...(pendingPatchRef.current?.patch || {}), ...patch },
      epoch: editEpochRef.current,
    };
    void pumpTranslationSaves();
  };

  // Flush a pending (typed but not yet blurred) edit when the section
  // unmounts — e.g. switching tabs — mirroring the context editor's flush.
  const localLinesRef = useRef(localLines);
  localLinesRef.current = localLines;
  const localHeaderRef = useRef(localHeader);
  localHeaderRef.current = localHeader;
  useEffect(
    () => () => {
      if (!dirtyRef.current) return;
      pendingPatchRef.current = {
        patch: {
          ...(pendingPatchRef.current?.patch || {}),
          lines: Array.from(localLinesRef.current.values()),
          ...(localHeaderRef.current ? { header: localHeaderRef.current } : {}),
        },
        epoch: editEpochRef.current,
      };
      void pumpRef.current();
    },
    [],
  );

  const { data: translation, isLoading } = useQuery<DevisTranslation>({
    queryKey: ["/api/devis", devisId, "translation"],
    refetchInterval: (q) => {
      const status = (q.state.data as DevisTranslation | undefined)?.status;
      return status === "processing" || status === "pending" ? 3000 : false;
    },
  });

  useEffect(() => {
    if (!translation) return;
    const key = `${devisId}:${translation.status}:${translation.updatedAt ?? ""}`;
    if (initialisedFor.current === key) return;
    // Never rebuild the local edit buffers from server data while an edit is
    // unsaved or a save is in flight — a stale refetch response would wipe
    // in-progress edits. The buffers re-sync once the save settles
    // (`dirtyRef` clears and `initialisedFor` resets after a full flush).
    if (dirtyRef.current || saveInFlightRef.current || pendingPatchRef.current) return;
    if (translation.status === "draft" || translation.status === "edited" || translation.status === "finalised") {
      const m = new Map<number, DevisTranslationLine>();
      for (const l of (translation.lineTranslations as DevisTranslationLine[]) || []) m.set(l.lineNumber, l);
      setLocalLines(m);
      setLocalHeader((translation.headerTranslated as DevisTranslationHeader) || {});
      initialisedFor.current = key;
    }
  }, [translation, devisId]);

  const { data: lineContextsData, isLoading: lineContextsLoading } = useQuery<{ contexts: DevisLineContext[] }>({
    queryKey: ["/api/devis", devisId, "line-contexts"],
  });
  const contextsByLineItemId = useMemo(() => {
    const m = new Map<number, DevisLineContext>();
    for (const c of lineContextsData?.contexts ?? []) m.set(c.devisLineItemId, c);
    return m;
  }, [lineContextsData]);

  const status = translation?.status ?? "missing";
  const isProcessing = status === "processing" || status === "pending";
  const isFinalised = status === "finalised";
  const canEdit = status === "draft" || status === "edited";

  const translateMutation = useMutation({
    mutationFn: async (force: boolean) => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/translate`, { force });
      return res.json();
    },
    onSuccess: () => {
      dirtyRef.current = false;
      pendingPatchRef.current = null;
      initialisedFor.current = null;
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      // Task #374 — the readiness strip on the devis list summarises the
      // translation status; this component doesn't know its projectId, so
      // match the batch readiness query by key suffix.
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes("devis-readiness") });
      toast({ title: "Translation generated", description: `Devis ${devisCode} translated to English.` });
    },
    onError: (err: Error) => {
      toast({ title: "Translation failed", description: err.message, variant: "destructive" });
    },
  });

  const retranslateLineMutation = useMutation({
    mutationFn: async (lineNumber: number) => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/translation/lines/${lineNumber}/retranslate`, {});
      return res.json();
    },
    onSuccess: () => {
      dirtyRef.current = false;
      pendingPatchRef.current = null;
      initialisedFor.current = null;
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      // Task #374 — the readiness strip on the devis list summarises the
      // translation status; this component doesn't know its projectId, so
      // match the batch readiness query by key suffix.
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes("devis-readiness") });
    },
    onError: (err: Error) => {
      toast({ title: "Re-translate failed", description: err.message, variant: "destructive" });
    },
  });

  const finaliseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/translation/finalise`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      // Task #374 — the readiness strip on the devis list summarises the
      // translation status; this component doesn't know its projectId, so
      // match the batch readiness query by key suffix.
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes("devis-readiness") });
      toast({ title: "Translation approved", description: "Translation locked and ready to share with the client." });
    },
    onError: (err: Error) => {
      toast({ title: "Approve failed", description: err.message, variant: "destructive" });
    },
  });

  const unlockMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/translation/unlock`, {});
      return res.json();
    },
    onSuccess: () => {
      dirtyRef.current = false;
      pendingPatchRef.current = null;
      initialisedFor.current = null;
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      // Task #374 — the readiness strip on the devis list summarises the
      // translation status; this component doesn't know its projectId, so
      // match the batch readiness query by key suffix.
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes("devis-readiness") });
      toast({ title: "Translation unlocked", description: "Translation reopened for editing. All existing text is preserved." });
    },
    onError: (err: Error) => {
      toast({ title: "Unlock failed", description: err.message, variant: "destructive" });
    },
  });

  const orderedLines = useMemo(() => {
    return lineItems.slice().sort((a, b) => a.lineNumber - b.lineNumber);
  }, [lineItems]);

  // PERSISTENCE CONTRACT — DO NOT REINTRODUCE A LOCAL-STATE DEDUP CHECK HERE.
  //
  // History: an earlier dedup guard short-circuited persist when the incoming
  // patch matched `localLines` / `localHeader`. That sounds reasonable but
  // is fundamentally broken: the textarea's own `onChange` writes the new
  // value into `localLines` BEFORE `onBlur` fires `persistLine`, so by the
  // time we got here `current.translation === patch.translation` was always
  // true and we silently skipped the PATCH. Every typed edit was lost on
  // refetch / page reload. (See README of the devis-checks rework.)
  //
  // Persisting on every blur is safe and cheap:
  //   * Blur fires once per focus exit (not per keystroke), so the request
  //     volume is bounded by user pacing, not typing speed.
  //   * The server route is idempotent — when the value is unchanged from
  //     server state it leaves `edited` untouched (see
  //     server/routes/__tests__/devis-translation-routes.test.ts:199).
  //
  // If you ever need to re-add a "skip no-op blur" optimisation, compare
  // against the SERVER snapshot (`translation.lineTranslations` /
  // `translation.headerTranslated`), never against the local edit buffer.
  const persistLine = (lineNumber: number, originalDescription: string, patch: Partial<DevisTranslationLine>) => {
    const current = localLines.get(lineNumber);
    const next: DevisTranslationLine = {
      lineNumber,
      originalDescription,
      translation: current?.translation ?? "",
      explanation: current?.explanation ?? null,
      ...patch,
      edited: true,
    };
    const newMap = new Map(localLines);
    newMap.set(lineNumber, next);
    setLocalLines(newMap);
    markDirty();
    enqueueTranslationPatch({ lines: Array.from(newMap.values()) });
  };

  const persistHeader = (patch: Partial<DevisTranslationHeader>) => {
    const next: DevisTranslationHeader = { ...(localHeader || {}), ...patch };
    setLocalHeader(next);
    markDirty();
    enqueueTranslationPatch({ header: next });
  };

  const downloadPdf = (variant?: "original" | "translation" | "combined") => {
    const params = new URLSearchParams();
    if (variant) params.set("variant", variant);
    if (showExplanations) params.set("explanations", "true");
    const qs = params.toString();
    window.open(`/api/devis/${devisId}/pdf${qs ? `?${qs}` : ""}`, "_blank");
  };

  if (isLoading) {
    return (
      <div className="space-y-3 p-4" data-testid={`section-translation-loading-${devisId}`}>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const statusBadge = (() => {
    if (status === "finalised") return <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600 text-white" data-testid={`badge-translation-status-${devisId}`}><Lock className="h-3 w-3" /> Approved</Badge>;
    if (status === "edited") return <Badge variant="secondary" data-testid={`badge-translation-status-${devisId}`}>Edited</Badge>;
    if (status === "draft") return <Badge variant="secondary" data-testid={`badge-translation-status-${devisId}`}>Draft</Badge>;
    if (isProcessing) return <Badge variant="outline" className="gap-1" data-testid={`badge-translation-status-${devisId}`}><Loader2 className="h-3 w-3 animate-spin" /> Translating</Badge>;
    if (status === "failed") return <Badge variant="destructive" className="gap-1" data-testid={`badge-translation-status-${devisId}`}><AlertTriangle className="h-3 w-3" /> Failed</Badge>;
    return <Badge variant="outline" data-testid={`badge-translation-status-${devisId}`}>Not generated</Badge>;
  })();

  return (
    <div className="space-y-4 rounded-md border border-border bg-card p-4" data-testid={`section-translation-${devisId}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Languages className="h-4 w-4 text-primary" />
          <h4 className="text-sm font-semibold uppercase tracking-wide text-foreground">English translation</h4>
          {statusBadge}
          {isSavingTranslation && (
            <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving…
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <Switch
              id={`expl-toggle-${devisId}`}
              checked={showExplanations}
              onCheckedChange={setShowExplanations}
              data-testid={`switch-explanations-${devisId}`}
            />
            <Label htmlFor={`expl-toggle-${devisId}`} className="text-xs">
              Show plain-English explanations
            </Label>
          </div>

          {(status === "missing" || status === "failed") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => translateMutation.mutate(false)}
              disabled={translateMutation.isPending || isProcessing}
              data-testid={`button-translate-${devisId}`}
            >
              {translateMutation.isPending || isProcessing ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Translate
            </Button>
          )}

          {(status === "draft" || status === "edited") && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => translateMutation.mutate(false)}
                disabled={translateMutation.isPending || isProcessing}
                data-testid={`button-regenerate-${devisId}`}
                title="Re-run AI translation while keeping any lines you've edited."
              >
                {translateMutation.isPending || isProcessing ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                Regenerate (keep edits)
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => translateMutation.mutate(true)}
                disabled={translateMutation.isPending || isProcessing}
                data-testid={`button-retranslate-all-${devisId}`}
                title="Re-run AI translation and overwrite all lines — including any manual edits."
              >
                {translateMutation.isPending || isProcessing ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                Re-translate all
              </Button>
            </>
          )}

          {(status === "draft" || status === "edited") && (
            <Button
              size="sm"
              onClick={() => finaliseMutation.mutate()}
              disabled={finaliseMutation.isPending}
              data-testid={`button-finalise-${devisId}`}
              title="Lock this translation as reviewed and approved before sharing with the client."
            >
              {finaliseMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <CheckCircle2 className="h-3 w-3 mr-1" />
              )}
              Approve translation
            </Button>
          )}

          {isFinalised && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => unlockMutation.mutate()}
              disabled={unlockMutation.isPending}
              data-testid={`button-unlock-${devisId}`}
              title="Reopen the approved translation for editing. All translated text is preserved — no AI retranslation happens."
            >
              {unlockMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Unlock className="h-3 w-3 mr-1" />
              )}
              Unlock
            </Button>
          )}

          {isFinalised && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => translateMutation.mutate(true)}
              disabled={translateMutation.isPending || isProcessing}
              data-testid={`button-retranslate-all-${devisId}`}
              title="Re-run AI translation and unlock the approved translation. All manual edits and the approval will be cleared."
            >
              {translateMutation.isPending || isProcessing ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Re-translate (unlock)
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" data-testid={`button-download-pdf-${devisId}`}>
                <FileDown className="h-3 w-3 mr-1" /> PDF <ChevronDown className="h-3 w-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => downloadPdf()}
                data-testid={`menu-pdf-default-${devisId}`}
              >
                Default (combined when ready)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => downloadPdf("original")} data-testid={`menu-pdf-original-${devisId}`}>
                Original (French)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => downloadPdf("translation")}
                disabled={!canEdit && !isFinalised}
                data-testid={`menu-pdf-translation-${devisId}`}
              >
                Translation only (English)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => downloadPdf("combined")}
                disabled={!canEdit && !isFinalised}
                data-testid={`menu-pdf-combined-${devisId}`}
              >
                French + English (combined)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {status === "failed" && translation?.errorMessage && (
        <p className="text-xs text-destructive" data-testid={`text-translation-error-${devisId}`}>
          {translation.errorMessage}
        </p>
      )}

      {isFinalised && translation?.approvedAt && (
        <p
          className="text-xs text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1"
          data-testid={`text-translation-approved-${devisId}`}
        >
          <Lock className="h-3 w-3" />
          Approved {translation.approvedByEmail ? `by ${translation.approvedByEmail} ` : ""}
          on {new Date(translation.approvedAt).toLocaleString("en-GB")}. Edits stay editable — approval is preserved.
        </p>
      )}

      {status === "missing" && !translateMutation.isPending && (
        <p className="text-xs text-muted-foreground">
          No translation has been generated for this devis yet. Click "Translate" to create an English version.
        </p>
      )}

      {(canEdit || isFinalised) && (
        <>
          {(localHeader?.summary || (showExplanations && localHeader?.descriptionExplanation)) && (
            <div className="rounded-sm border-l-2 border-primary bg-muted/40 p-3 space-y-2">
              {localHeader?.summary && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Document overview</div>
                  <Textarea
                    value={localHeader.summary || ""}
                    readOnly={false}
                    onChange={(e) => {
                      markDirty();
                      setLocalHeader({ ...(localHeader || {}), summary: e.target.value });
                    }}
                    onBlur={(e) => persistHeader({ summary: e.target.value })}
                    className="mt-1 min-h-[44px] text-sm bg-background"
                    data-testid={`text-translation-summary-${devisId}`}
                  />
                </div>
              )}
              {showExplanations && localHeader?.descriptionExplanation && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Plain-English note</div>
                  <Textarea
                    value={localHeader.descriptionExplanation || ""}
                    readOnly={false}
                    onChange={(e) => {
                      markDirty();
                      setLocalHeader({ ...(localHeader || {}), descriptionExplanation: e.target.value });
                    }}
                    onBlur={(e) => persistHeader({ descriptionExplanation: e.target.value })}
                    className="mt-1 min-h-[44px] text-xs bg-background"
                    data-testid={`text-translation-header-explanation-${devisId}`}
                  />
                </div>
              )}
            </div>
          )}

          <div className="space-y-3">
            {orderedLines.length === 0 && (
              <p className="py-3 text-center text-xs text-muted-foreground">No line items to translate.</p>
            )}
            {orderedLines.map((li) => {
              const t = localLines.get(li.lineNumber);
              const isLineRetranslating = retranslateLineMutation.isPending && retranslateLineMutation.variables === li.lineNumber;
              const isWorking = workingLineNumber === li.lineNumber;
              const isFlashing = flashLineNumber === li.lineNumber;
              return (
                <div
                  key={li.lineNumber}
                  id={`line-anchor-translation-${devisId}-${li.lineNumber}`}
                  className={`rounded-sm border p-3 transition-colors duration-500 ${
                    isFlashing
                      ? "border-[#C1A27B] bg-[#C1A27B]/15"
                      : isWorking
                        ? "border-[#C1A27B]/70 bg-[#C1A27B]/[0.06]"
                        : "border-border/60"
                  }`}
                  onClickCapture={() => onWorkingLineChange?.(li.lineNumber, li.id)}
                  onFocusCapture={() => onWorkingLineChange?.(li.lineNumber, li.id)}
                  data-testid={`row-translation-${devisId}-${li.lineNumber}`}
                >
                  <div className="flex items-start gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground pt-0.5 min-w-[1.5rem]">
                      {li.lineNumber}
                      {t?.edited && (
                        <span className="ml-1 text-[9px] uppercase text-amber-600" title="Edited by user">●</span>
                      )}
                    </span>
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">French (original)</div>
                      <p className="text-[11px] text-muted-foreground leading-snug whitespace-pre-wrap">
                        {li.description}
                      </p>
                      <div className="text-[10px] uppercase tracking-wider text-sky-700 dark:text-sky-400 pt-1">English (literal)</div>
                      <Textarea
                        value={t?.translation ?? ""}
                        readOnly={false}
                        onChange={(e) => {
                          markDirty();
                          const newMap = new Map(localLines);
                          const cur = newMap.get(li.lineNumber);
                          newMap.set(li.lineNumber, {
                            lineNumber: li.lineNumber,
                            originalDescription: li.description,
                            explanation: cur?.explanation ?? null,
                            ...cur,
                            translation: e.target.value,
                          });
                          setLocalLines(newMap);
                        }}
                        onBlur={(e) => persistLine(li.lineNumber, li.description, { translation: e.target.value })}
                        className="min-h-[44px] w-full text-[11px] leading-snug border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40"
                        data-testid={`input-translation-${devisId}-${li.lineNumber}`}
                      />
                      {showExplanations && (
                        <>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground pt-1">
                            Plain-English explanation
                          </div>
                          <Textarea
                            value={t?.explanation ?? ""}
                            readOnly={false}
                            onChange={(e) => {
                              markDirty();
                              const newMap = new Map(localLines);
                              const cur = newMap.get(li.lineNumber);
                              newMap.set(li.lineNumber, {
                                lineNumber: li.lineNumber,
                                originalDescription: li.description,
                                translation: cur?.translation ?? "",
                                ...cur,
                                explanation: e.target.value || null,
                              });
                              setLocalLines(newMap);
                            }}
                            onBlur={(e) => persistLine(li.lineNumber, li.description, { explanation: e.target.value || null })}
                            placeholder="Optional plain-English note"
                            className="min-h-[44px] w-full text-[11px] leading-snug"
                            data-testid={`input-explanation-${devisId}-${li.lineNumber}`}
                          />
                        </>
                      )}
                      {/* Mount the editor only once contexts have loaded so the
                          revision baseline is correct on first save. */}
                      {!lineContextsLoading && (
                        <div className="pt-1">
                          <DevisLineContextEditor
                            devisId={devisId}
                            lineItemId={li.id}
                            lineNumber={li.lineNumber}
                            context={contextsByLineItemId.get(li.id) ?? null}
                            readOnly={isFinalised}
                          />
                        </div>
                      )}
                    </div>
                    {!isFinalised && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0"
                        disabled={isLineRetranslating}
                        onClick={() => retranslateLineMutation.mutate(li.lineNumber)}
                        title="Re-translate this line"
                        data-testid={`button-retranslate-line-${devisId}-${li.lineNumber}`}
                      >
                        {isLineRetranslating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <DevisCostAnalysisCard devisId={devisId} translationFinalised={isFinalised} />
    </div>
  );
}
