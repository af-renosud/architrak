import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Trash2,
  Save,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { DevisCostAnalysis } from "@shared/schema";
import {
  parseCostAnalysisMarkdown,
  type AnalysisBlock,
  type AnalysisInline,
  type CostAnalysisDocument,
} from "@shared/cost-analysis-doc";

interface DevisCostAnalysisCardProps {
  devisId: number;
  /** Mutations are disabled while the translation is finalised (locked). */
  translationFinalised: boolean;
}

function InlineSpans({ content }: { content: AnalysisInline[] }) {
  return (
    <>
      {content.map((n, i) => {
        let el: React.ReactNode = n.text;
        if (n.bold) el = <strong key={i}>{el}</strong>;
        else if (n.italic) el = <em key={i}>{el}</em>;
        else el = <span key={i}>{el}</span>;
        return el;
      })}
    </>
  );
}

function BlockView({ block }: { block: AnalysisBlock }) {
  switch (block.type) {
    case "heading":
      return block.level === 2 ? (
        <h4 className="text-sm font-bold uppercase tracking-wide text-primary mt-3 mb-1">
          <InlineSpans content={block.content} />
        </h4>
      ) : (
        <h5 className="text-sm font-semibold mt-2 mb-1">
          <InlineSpans content={block.content} />
        </h5>
      );
    case "paragraph":
      return (
        <p className="text-sm leading-relaxed my-1">
          <InlineSpans content={block.content} />
        </p>
      );
    case "table":
      return (
        <div className="overflow-x-auto my-2">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                {block.header.map((c, i) => (
                  <th key={i} className="bg-primary text-primary-foreground text-left px-2 py-1 font-semibold">
                    <InlineSpans content={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="odd:bg-muted/40">
                  {row.map((c, ci) => (
                    <td key={ci} className="border-b px-2 py-1 align-top">
                      <InlineSpans content={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function DocumentPreview({ document }: { document: CostAnalysisDocument }) {
  return (
    <div data-testid="cost-analysis-preview">
      {document.blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

export function DevisCostAnalysisCard({ devisId, translationFinalised }: DevisCostAnalysisCardProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [rawText, setRawText] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const { data, isLoading } = useQuery<{ analysis: DevisCostAnalysis | null }>({
    queryKey: ["/api/devis", devisId, "cost-analysis"],
  });
  const analysis = data?.analysis ?? null;

  // Sync the editor with the server row whenever it changes and the
  // architect has no unsaved local edits (stale-cache remount lesson).
  useEffect(() => {
    if (!dirty && analysis) setRawText(analysis.rawText);
    if (!analysis) {
      setRawText("");
      setDirty(false);
    }
  }, [analysis, dirty]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "cost-analysis"] });
  };

  const preview = useMemo(() => {
    const text = dirty ? rawText : analysis?.rawText ?? "";
    if (!text.trim()) return null;
    try {
      return parseCostAnalysisMarkdown(text);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) } as const;
    }
  }, [rawText, dirty, analysis?.rawText]);

  const onError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    toast({ title: "Cost analysis", description: message, variant: "destructive" });
    invalidate();
  };

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/cost-analysis/generate`, {});
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      invalidate();
      toast({ title: "Cost analysis generated", description: "Review the draft, then confirm it to include it in the PDF." });
    },
    onError,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/devis/${devisId}/cost-analysis`, {
        rawText,
        expectedRevision: analysis?.revision,
      });
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      invalidate();
      toast({ title: "Draft saved" });
    },
    onError,
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/cost-analysis/confirm`, {
        expectedRevision: analysis?.revision,
      });
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      toast({ title: "Cost analysis confirmed", description: "It will be appended to the translated and combined PDFs." });
    },
    onError,
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/devis/${devisId}/cost-analysis`, {
        expectedRevision: analysis?.revision,
      });
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      setRawText("");
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      toast({ title: "Cost analysis removed" });
    },
    onError,
  });

  const busy =
    generateMutation.isPending || saveMutation.isPending || confirmMutation.isPending || removeMutation.isPending;
  const locked = translationFinalised;
  const isConfirmed = analysis?.status === "confirmed";
  const warnings = (dirty || !analysis ? (preview && "warnings" in preview ? preview.warnings : []) : (analysis.warnings as string[]) ?? []) ?? [];

  return (
    <div className="border rounded-md mt-4" data-testid={`card-cost-analysis-${devisId}`}>
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen((o) => !o)}
        data-testid="button-toggle-cost-analysis"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="font-semibold text-sm">Cost analysis / value engineering</span>
          {isConfirmed ? (
            <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600 text-white" data-testid="badge-cost-analysis-status">
              <CheckCircle2 className="h-3 w-3" /> Attached to PDF
            </Badge>
          ) : analysis ? (
            <Badge variant="secondary" data-testid="badge-cost-analysis-status">Draft — not in PDF</Badge>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">Optional AI appendix</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {locked && (
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              The translation is approved &amp; locked — unlock it above to change the cost analysis.
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant={analysis ? "outline" : "default"}
              disabled={busy || locked || isLoading}
              onClick={() => (analysis ? setConfirmRegenerate(true) : generateMutation.mutate())}
              data-testid="button-generate-cost-analysis"
            >
              {generateMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4 mr-1" />
              )}
              {analysis ? "Regenerate" : "Generate cost analysis"}
            </Button>
            {analysis && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || locked || !dirty}
                  onClick={() => saveMutation.mutate()}
                  data-testid="button-save-cost-analysis"
                >
                  <Save className="h-4 w-4 mr-1" /> Save draft
                </Button>
                {!isConfirmed && (
                  <Button
                    size="sm"
                    disabled={busy || locked || dirty}
                    onClick={() => confirmMutation.mutate()}
                    data-testid="button-confirm-cost-analysis"
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1" /> Confirm &amp; attach
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy || locked}
                  onClick={() => setConfirmRemove(true)}
                  data-testid="button-remove-cost-analysis"
                >
                  <Trash2 className="h-4 w-4 mr-1" /> Remove
                </Button>
              </>
            )}
          </div>

          {analysis && (
            <>
              <Textarea
                value={rawText}
                onChange={(e) => {
                  setRawText(e.target.value);
                  setDirty(true);
                }}
                disabled={busy || locked}
                rows={10}
                className="font-mono text-xs"
                data-testid="textarea-cost-analysis"
              />
              {dirty && !isConfirmed && (
                <div className="text-xs text-muted-foreground">Save the draft before confirming.</div>
              )}
            </>
          )}

          {warnings.length > 0 && (
            <div
              className="border border-amber-300 bg-amber-50 dark:bg-amber-950/30 rounded-md p-2 text-xs space-y-1"
              data-testid="cost-analysis-warnings"
            >
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-1">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-amber-600" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {preview && "error" in preview && (
            <div className="text-xs text-destructive" data-testid="cost-analysis-parse-error">
              Cannot parse: {preview.error}
            </div>
          )}
          {preview && "document" in preview && <DocumentPreview document={preview.document} />}
        </div>
      )}

      <AlertDialog open={confirmRegenerate} onOpenChange={setConfirmRegenerate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate the cost analysis?</AlertDialogTitle>
            <AlertDialogDescription>
              This calls the AI again (which has a cost) and replaces the current
              {isConfirmed ? " CONFIRMED analysis — it will revert to an unconfirmed draft and drop out of the PDF until you confirm the new version." : " draft, including any manual edits."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDirty(false);
                generateMutation.mutate();
              }}
              data-testid="button-confirm-regenerate"
            >
              Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the cost analysis?</AlertDialogTitle>
            <AlertDialogDescription>
              {isConfirmed
                ? "It is currently attached to the PDF — removing it also removes it from future PDFs."
                : "The draft and any edits will be deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => removeMutation.mutate()} data-testid="button-confirm-remove-analysis">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
