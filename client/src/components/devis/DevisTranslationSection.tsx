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
import { Languages, Loader2, RefreshCw, FileDown, ChevronDown, AlertTriangle, Lock, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type {
  DevisTranslation,
  DevisLineItem,
  DevisTranslationLine,
  DevisTranslationHeader,
} from "@shared/schema";

interface DevisTranslationSectionProps {
  devisId: number;
  devisCode: string;
  lineItems: DevisLineItem[];
}

export function DevisTranslationSection({ devisId, devisCode, lineItems }: DevisTranslationSectionProps) {
  const { toast } = useToast();
  const [showExplanations, setShowExplanations] = useState(false);
  const [localLines, setLocalLines] = useState<Map<number, DevisTranslationLine>>(new Map());
  const [localHeader, setLocalHeader] = useState<DevisTranslationHeader | null>(null);
  const initialisedFor = useRef<string | null>(null);

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
    if (translation.status === "draft" || translation.status === "edited" || translation.status === "finalised") {
      const m = new Map<number, DevisTranslationLine>();
      for (const l of (translation.lineTranslations as DevisTranslationLine[]) || []) m.set(l.lineNumber, l);
      setLocalLines(m);
      setLocalHeader((translation.headerTranslated as DevisTranslationHeader) || {});
      initialisedFor.current = key;
    }
  }, [translation, devisId]);

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
      initialisedFor.current = null;
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      toast({ title: "Translation generated", description: `Devis ${devisCode} translated to English.` });
    },
    onError: (err: Error) => {
      toast({ title: "Translation failed", description: err.message, variant: "destructive" });
    },
  });

  const patchMutation = useMutation({
    mutationFn: async (payload: { header?: DevisTranslationHeader; lines?: DevisTranslationLine[] }) => {
      const res = await apiRequest("PATCH", `/api/devis/${devisId}/translation`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const retranslateLineMutation = useMutation({
    mutationFn: async (lineNumber: number) => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/translation/lines/${lineNumber}/retranslate`, {});
      return res.json();
    },
    onSuccess: () => {
      initialisedFor.current = null;
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
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
      toast({ title: "Translation finalised", description: "Translation locked and ready to share with the client." });
    },
    onError: (err: Error) => {
      toast({ title: "Finalise failed", description: err.message, variant: "destructive" });
    },
  });

  const orderedLines = useMemo(() => {
    return lineItems.slice().sort((a, b) => a.lineNumber - b.lineNumber);
  }, [lineItems]);

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
    if (
      current &&
      current.translation === next.translation &&
      (current.explanation ?? null) === (next.explanation ?? null)
    ) {
      return;
    }
    const newMap = new Map(localLines);
    newMap.set(lineNumber, next);
    setLocalLines(newMap);
    patchMutation.mutate({ lines: Array.from(newMap.values()) });
  };

  const persistHeader = (patch: Partial<DevisTranslationHeader>) => {
    const next: DevisTranslationHeader = { ...(localHeader || {}), ...patch };
    if (
      localHeader &&
      (localHeader.summary ?? null) === (next.summary ?? null) &&
      (localHeader.description ?? null) === (next.description ?? null) &&
      (localHeader.descriptionExplanation ?? null) === (next.descriptionExplanation ?? null)
    ) {
      return;
    }
    setLocalHeader(next);
    patchMutation.mutate({ header: next });
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
    if (status === "finalised") return <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600 text-white" data-testid={`badge-translation-status-${devisId}`}><Lock className="h-3 w-3" /> Finalised</Badge>;
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
          {patchMutation.isPending && (
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
          )}

          {(status === "draft" || status === "edited") && (
            <Button
              size="sm"
              onClick={() => finaliseMutation.mutate()}
              disabled={finaliseMutation.isPending}
              data-testid={`button-finalise-${devisId}`}
            >
              {finaliseMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <CheckCircle2 className="h-3 w-3 mr-1" />
              )}
              Finalise
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
                    readOnly={isFinalised}
                    onChange={(e) => setLocalHeader({ ...(localHeader || {}), summary: e.target.value })}
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
                    readOnly={isFinalised}
                    onChange={(e) => setLocalHeader({ ...(localHeader || {}), descriptionExplanation: e.target.value })}
                    onBlur={(e) => persistHeader({ descriptionExplanation: e.target.value })}
                    className="mt-1 min-h-[44px] text-xs bg-background"
                    data-testid={`text-translation-header-explanation-${devisId}`}
                  />
                </div>
              )}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="w-10 py-2 pr-2">#</th>
                  <th className="py-2 pr-3">French (original)</th>
                  <th className="py-2 pr-3">English (literal)</th>
                  {showExplanations && <th className="py-2 pr-3">Plain-English explanation</th>}
                  <th className="w-10 py-2 pr-2"></th>
                </tr>
              </thead>
              <tbody>
                {orderedLines.map((li) => {
                  const t = localLines.get(li.lineNumber);
                  const isLineRetranslating = retranslateLineMutation.isPending && retranslateLineMutation.variables === li.lineNumber;
                  return (
                    <tr key={li.lineNumber} className="border-b border-border/40 align-top" data-testid={`row-translation-${devisId}-${li.lineNumber}`}>
                      <td className="py-2 pr-2 font-mono text-muted-foreground">
                        {li.lineNumber}
                        {t?.edited && (
                          <span className="ml-1 text-[9px] uppercase text-amber-600" title="Edited by user">●</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{li.description}</td>
                      <td className="py-2 pr-3">
                        <Textarea
                          value={t?.translation ?? ""}
                          readOnly={isFinalised}
                          onChange={(e) => {
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
                          className="min-h-[44px] text-xs"
                          data-testid={`input-translation-${devisId}-${li.lineNumber}`}
                        />
                      </td>
                      {showExplanations && (
                        <td className="py-2 pr-3">
                          <Textarea
                            value={t?.explanation ?? ""}
                            readOnly={isFinalised}
                            onChange={(e) => {
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
                            className="min-h-[44px] text-xs"
                            data-testid={`input-explanation-${devisId}-${li.lineNumber}`}
                          />
                        </td>
                      )}
                      <td className="py-2 pr-2 text-right">
                        {!isFinalised && (
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={isLineRetranslating}
                            onClick={() => retranslateLineMutation.mutate(li.lineNumber)}
                            title="Re-translate this line"
                            data-testid={`button-retranslate-line-${devisId}-${li.lineNumber}`}
                          >
                            {isLineRetranslating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {orderedLines.length === 0 && (
                  <tr>
                    <td colSpan={showExplanations ? 5 : 4} className="py-3 text-center text-muted-foreground">
                      No line items to translate.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
