import { useState, useMemo, useEffect } from "react";
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
import { Languages, Loader2, RefreshCw, Save, FileDown, ChevronDown, AlertTriangle } from "lucide-react";
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

interface TranslationDraft {
  header: DevisTranslationHeader;
  lines: DevisTranslationLine[];
}

export function DevisTranslationSection({ devisId, devisCode, lineItems }: DevisTranslationSectionProps) {
  const { toast } = useToast();
  const [showExplanations, setShowExplanations] = useState(true);
  const [draft, setDraft] = useState<TranslationDraft | null>(null);
  const [dirty, setDirty] = useState(false);

  const { data: translation, isLoading } = useQuery<DevisTranslation>({
    queryKey: ["/api/devis", devisId, "translation"],
    refetchInterval: (q) => {
      const status = (q.state.data as DevisTranslation | undefined)?.status;
      return status === "processing" || status === "pending" ? 3000 : false;
    },
    retry: false,
  });

  useEffect(() => {
    if (translation && translation.status === "completed" && !dirty) {
      setDraft({
        header: (translation.headerTranslated as DevisTranslationHeader) || {},
        lines: (translation.lineTranslations as DevisTranslationLine[]) || [],
      });
    }
  }, [translation, dirty]);

  const lineByNumber = useMemo(() => {
    const m = new Map<number, DevisTranslationLine>();
    for (const t of draft?.lines ?? []) m.set(t.lineNumber, t);
    return m;
  }, [draft]);

  const translateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/translate`, {});
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      toast({ title: "Translation generated", description: `Devis ${devisCode} translated to English.` });
    },
    onError: (err: Error) => {
      toast({ title: "Translation failed", description: err.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Nothing to save");
      const res = await apiRequest("PATCH", `/api/devis/${devisId}/translation`, {
        header: draft.header,
        lines: draft.lines,
      });
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      toast({ title: "Translation saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const updateLine = (lineNumber: number, patch: Partial<DevisTranslationLine>) => {
    if (!draft) return;
    const lines = draft.lines.slice();
    const idx = lines.findIndex((l) => l.lineNumber === lineNumber);
    const original = lineItems.find((li) => li.lineNumber === lineNumber);
    if (idx >= 0) {
      lines[idx] = { ...lines[idx], ...patch };
    } else {
      lines.push({
        lineNumber,
        originalDescription: original?.description || "",
        translation: "",
        explanation: null,
        ...patch,
      });
    }
    setDraft({ ...draft, lines });
    setDirty(true);
  };

  const updateHeader = (patch: Partial<DevisTranslationHeader>) => {
    if (!draft) return;
    setDraft({ ...draft, header: { ...draft.header, ...patch } });
    setDirty(true);
  };

  const downloadPdf = (variant: "original" | "translation" | "combined") => {
    const explanationsParam = showExplanations ? "&explanations=true" : "";
    window.open(`/api/devis/${devisId}/pdf?variant=${variant}${explanationsParam}`, "_blank");
  };

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const status = translation?.status ?? "missing";
  const isProcessing = status === "processing" || status === "pending";

  return (
    <div className="space-y-4 rounded-md border border-border bg-card p-4" data-testid={`section-translation-${devisId}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Languages className="h-4 w-4 text-primary" />
          <h4 className="text-sm font-semibold uppercase tracking-wide text-foreground">English translation</h4>
          {status === "completed" && <Badge variant="secondary" data-testid={`badge-translation-status-${devisId}`}>Ready</Badge>}
          {isProcessing && (
            <Badge variant="outline" className="gap-1" data-testid={`badge-translation-status-${devisId}`}>
              <Loader2 className="h-3 w-3 animate-spin" /> Translating
            </Badge>
          )}
          {status === "failed" && (
            <Badge variant="destructive" className="gap-1" data-testid={`badge-translation-status-${devisId}`}>
              <AlertTriangle className="h-3 w-3" /> Failed
            </Badge>
          )}
          {status === "missing" && <Badge variant="outline" data-testid={`badge-translation-status-${devisId}`}>Not generated</Badge>}
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

          <Button
            size="sm"
            variant="outline"
            onClick={() => translateMutation.mutate()}
            disabled={translateMutation.isPending || isProcessing}
            data-testid={`button-translate-${devisId}`}
          >
            {translateMutation.isPending || isProcessing ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <RefreshCw className="h-3 w-3 mr-1" />
            )}
            {status === "completed" ? "Regenerate" : "Translate"}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" data-testid={`button-download-pdf-${devisId}`}>
                <FileDown className="h-3 w-3 mr-1" /> PDF <ChevronDown className="h-3 w-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => downloadPdf("original")} data-testid={`menu-pdf-original-${devisId}`}>
                Original (French)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => downloadPdf("translation")}
                disabled={status !== "completed"}
                data-testid={`menu-pdf-translation-${devisId}`}
              >
                Translation only (English)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => downloadPdf("combined")}
                disabled={status !== "completed"}
                data-testid={`menu-pdf-combined-${devisId}`}
              >
                English + French (combined)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {status === "failed" && translation?.errorMessage && (
        <p className="text-xs text-destructive">{translation.errorMessage}</p>
      )}

      {status === "missing" && !translateMutation.isPending && (
        <p className="text-xs text-muted-foreground">
          No translation has been generated for this devis yet. Click "Translate" to create an English version.
        </p>
      )}

      {draft && status === "completed" && (
        <>
          {draft.header.summary && (
            <div className="rounded-sm border-l-2 border-primary bg-muted/40 p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Document overview</div>
              <p className="mt-1 text-sm text-foreground" data-testid={`text-translation-summary-${devisId}`}>
                {draft.header.summary}
              </p>
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
                </tr>
              </thead>
              <tbody>
                {lineItems.map((li) => {
                  const t = lineByNumber.get(li.lineNumber);
                  return (
                    <tr key={li.lineNumber} className="border-b border-border/40 align-top" data-testid={`row-translation-${devisId}-${li.lineNumber}`}>
                      <td className="py-2 pr-2 font-mono text-muted-foreground">{li.lineNumber}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{li.description}</td>
                      <td className="py-2 pr-3">
                        <Textarea
                          value={t?.translation ?? ""}
                          onChange={(e) => updateLine(li.lineNumber, { translation: e.target.value })}
                          className="min-h-[44px] text-xs"
                          data-testid={`input-translation-${devisId}-${li.lineNumber}`}
                        />
                      </td>
                      {showExplanations && (
                        <td className="py-2 pr-3">
                          <Textarea
                            value={t?.explanation ?? ""}
                            onChange={(e) => updateLine(li.lineNumber, { explanation: e.target.value || null })}
                            placeholder="Optional plain-English note"
                            className="min-h-[44px] text-xs"
                            data-testid={`input-explanation-${devisId}-${li.lineNumber}`}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
                {lineItems.length === 0 && (
                  <tr>
                    <td colSpan={showExplanations ? 4 : 3} className="py-3 text-center text-muted-foreground">
                      No line items to translate.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {dirty && (
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft({
                    header: (translation?.headerTranslated as DevisTranslationHeader) || {},
                    lines: (translation?.lineTranslations as DevisTranslationLine[]) || [],
                  });
                  setDirty(false);
                }}
                data-testid={`button-translation-discard-${devisId}`}
              >
                Discard changes
              </Button>
              <Button
                size="sm"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                data-testid={`button-translation-save-${devisId}`}
              >
                {saveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                Save edits
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
