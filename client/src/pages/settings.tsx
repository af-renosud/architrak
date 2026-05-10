import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Sidebar } from "@/components/layout/Sidebar";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Zap, Sparkles, Crown, Gauge, DollarSign, Brain, Check, Upload, Trash2, Image, Building2, Scale, Layers, Plus, Pencil, Wand2, Loader2, RefreshCw, Users, FileText, ExternalLink, Lightbulb, Bug } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
import type { AiModelSetting, TemplateAsset, LotCatalog } from "@shared/schema";

interface ModelOption {
  provider: string;
  modelId: string;
  label: string;
  description: string;
  speed: number;
  quality: number;
  cost: number;
  icon: typeof Zap;
  accent: string;
}

const MODEL_OPTIONS: ModelOption[] = [
  {
    provider: "gemini",
    modelId: "gemini-2.0-flash-lite",
    label: "Gemini 2.0 Flash Lite",
    description: "Fastest option — basic extraction, lower accuracy",
    speed: 5,
    quality: 2,
    cost: 1,
    icon: Zap,
    accent: "text-amber-500",
  },
  {
    provider: "gemini",
    modelId: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    description: "Fast and reliable — good balance for most documents",
    speed: 4,
    quality: 3,
    cost: 2,
    icon: Gauge,
    accent: "text-blue-500",
  },
  {
    provider: "gemini",
    modelId: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    description: "Latest balanced model — improved accuracy",
    speed: 3,
    quality: 4,
    cost: 3,
    icon: Sparkles,
    accent: "text-violet-500",
  },
  {
    provider: "gemini",
    modelId: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    description: "Premium quality — best accuracy for complex documents",
    speed: 2,
    quality: 5,
    cost: 4,
    icon: Crown,
    accent: "text-[#c1a27b]",
  },
  {
    provider: "openai",
    modelId: "gpt-4o",
    label: "GPT-4o (OpenAI)",
    description: "OpenAI's multimodal model — excellent extraction quality",
    speed: 3,
    quality: 5,
    cost: 5,
    icon: Brain,
    accent: "text-emerald-500",
  },
];

function RatingDots({ value, max = 5, color }: { value: number; max?: number; color: string }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: max }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            i < value ? color : "bg-slate-200 dark:bg-slate-700"
          )}
        />
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const { toast } = useToast();

  const { data: settings, isLoading } = useQuery<AiModelSetting[]>({
    queryKey: ["/api/settings/ai-models"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ taskType, provider, modelId }: { taskType: string; provider: string; modelId: string }) => {
      const res = await apiRequest("PATCH", `/api/settings/ai-models/${taskType}`, { provider, modelId });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/ai-models"] });
      const model = MODEL_OPTIONS.find(m => m.modelId === variables.modelId);
      toast({ title: "AI model updated", description: `Document parsing will now use ${model?.label ?? variables.modelId}` });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update", description: error.message, variant: "destructive" });
    },
  });

  const activeSetting = settings?.find(s => s.taskType === "document_parsing");
  const activeModelId = activeSetting?.modelId ?? "gemini-2.0-flash";

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#F8F9FA" }}>
      <Sidebar />
      <main className="ml-64 p-8">
        <div className="mb-8">
          <h1
            className="text-[28px] font-black uppercase tracking-tight"
            style={{ color: "#0B2545" }}
            data-testid="text-settings-title"
          >
            Settings
          </h1>
          <p className="text-[11px] text-muted-foreground mt-1">
            Configure AI models and application preferences
          </p>
        </div>

        <div className="mb-6">
          <h2
            className="text-[16px] font-black uppercase tracking-tight mb-1"
            style={{ color: "#0B2545" }}
          >
            AI Model — Document Parsing
          </h2>
          <p className="text-[11px] text-muted-foreground mb-4">
            Select which AI model to use when extracting data from uploaded PDFs (Devis, invoices, etc.)
          </p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-2xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {MODEL_OPTIONS.map((model) => {
              const isActive = activeModelId === model.modelId;
              return (
                <div
                  key={model.modelId}
                  className={cn(
                    "relative rounded-[1.5rem] border-2 p-5 cursor-pointer transition-all",
                    isActive
                      ? "border-[#0B2545] bg-white shadow-md"
                      : "border-transparent bg-white/60 hover:bg-white hover:shadow-sm"
                  )}
                  onClick={() => {
                    if (!isActive) {
                      updateMutation.mutate({
                        taskType: "document_parsing",
                        provider: model.provider,
                        modelId: model.modelId,
                      });
                    }
                  }}
                  data-testid={`card-model-${model.modelId}`}
                >
                  {isActive && (
                    <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-[#0B2545] flex items-center justify-center">
                      <Check size={12} className="text-white" />
                    </div>
                  )}
                  <div className="flex items-center gap-2 mb-2">
                    <model.icon size={18} className={model.accent} strokeWidth={1.5} />
                    <h3 className="text-[13px] font-bold text-foreground">{model.label}</h3>
                  </div>
                  <p className="text-[10px] text-muted-foreground mb-4 leading-relaxed">
                    {model.description}
                  </p>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <TechnicalLabel>Speed</TechnicalLabel>
                      <RatingDots value={model.speed} color="bg-amber-400" />
                    </div>
                    <div className="flex items-center justify-between">
                      <TechnicalLabel>Quality</TechnicalLabel>
                      <RatingDots value={model.quality} color="bg-emerald-400" />
                    </div>
                    <div className="flex items-center justify-between">
                      <TechnicalLabel>Cost</TechnicalLabel>
                      <RatingDots value={model.cost} color="bg-rose-400" />
                    </div>
                  </div>
                  {isActive && (
                    <div className="mt-3 pt-3 border-t border-[rgba(0,0,0,0.06)]">
                      <span className="text-[8px] font-black uppercase tracking-widest text-[#0B2545]">
                        Active
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-8">
          <LuxuryCard>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                <DollarSign size={14} className="text-muted-foreground" />
              </div>
              <div>
                <h3 className="text-[12px] font-bold text-foreground mb-0.5">API Key Configuration</h3>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Gemini models use the GEMINI_API_KEY environment secret. OpenAI models use the configured AI Integrations connection.
                  Both are pre-configured — select a model above and start uploading documents.
                </p>
              </div>
            </div>
          </LuxuryCard>
        </div>

        <TemplateAssetsSection />
        <TemplatesSection />
        <WishListSection />
        <LotCatalogSection />
        <DevisRematchSection />
        <InvoiceRematchSection />
        <PageHintBackfillSection />
      </main>
    </div>
  );
}

interface RematchPreviewRow {
  devisId: number;
  devisCode: string | null;
  devisNumber: string | null;
  projectId: number;
  projectName: string | null;
  currentContractorId: number;
  currentContractorName: string | null;
  suggestedContractorId: number;
  suggestedContractorName: string;
  suggestedContractorOrphaned: boolean;
  confidence: number;
  matchedFields: Record<string, string>;
  status: string;
  projectArchived: boolean;
  applicable: boolean;
  blockedReason: string | null;
}

function DevisRematchSection() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const { data, isFetching, refetch } = useQuery<{ rows: RematchPreviewRow[] }>({
    queryKey: ["/api/admin/devis-rematch/preview"],
  });

  const rows = data?.rows ?? [];
  const applicableRows = rows.filter(r => r.applicable);

  const applyMutation = useMutation({
    mutationFn: async (devisIds: number[]) => {
      const res = await apiRequest("POST", "/api/admin/devis-rematch/apply", { devisIds });
      return (await res.json()) as {
        applied: Array<{ devisId: number; previousContractorId: number; newContractorId: number }>;
        skipped: Array<{ devisId: number; reason: string }>;
      };
    },
    onSuccess: (result) => {
      const appliedCount = result.applied.length;
      const skippedCount = result.skipped.length;
      toast({
        title: `Applied ${appliedCount} correction${appliedCount === 1 ? "" : "s"}`,
        description: skippedCount > 0
          ? `${skippedCount} skipped — see preview after refresh`
          : "All selected devis updated",
        variant: appliedCount === 0 ? "destructive" : undefined,
      });
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/admin/devis-rematch/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis"] });
    },
    onError: (err: Error) => {
      toast({ title: "Apply failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleOne = (id: number, applicable: boolean) => {
    if (!applicable) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === applicableRows.length && applicableRows.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(applicableRows.map(r => r.devisId)));
    }
  };

  const allSelected = applicableRows.length > 0 && selected.size === applicableRows.length;

  return (
    <div className="mt-10">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2
            className="text-[16px] font-black uppercase tracking-tight mb-1"
            style={{ color: "#0B2545" }}
            data-testid="text-devis-rematch-title"
          >
            Re-match Devis Contractors
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Re-runs the SIRET / name matcher against every devis using its already-stored extraction data.
            No AI calls are made. Review and apply auto-corrections in bulk.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-rematch-refresh"
        >
          <RefreshCw size={12} className={cn("mr-1.5", isFetching && "animate-spin")} />
          <span className="text-[10px] font-bold uppercase tracking-widest">
            {isFetching ? "Scanning..." : "Refresh"}
          </span>
        </Button>
      </div>

      <LuxuryCard>
        <div className="flex items-start gap-3 mb-5">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ backgroundColor: "rgba(11, 37, 69, 0.08)" }}
          >
            <Users size={14} style={{ color: "#0B2545" }} />
          </div>
          <div className="flex-1">
            <h3 className="text-[12px] font-bold text-foreground mb-0.5">
              Suggested corrections {rows.length > 0 ? `(${applicableRows.length} applicable, ${rows.length} total)` : ""}
            </h3>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Each applied row writes a manual-edit audit entry, exactly as if a user used the pencil on the devis.
            </p>
          </div>
        </div>

        {isFetching && rows.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-[11px] text-muted-foreground py-6 text-center" data-testid="text-rematch-empty">
            No mismatches found. Every devis already matches what the current AI matcher would assign.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left border-b border-[rgba(0,0,0,0.06)]">
                    <th className="py-2 pr-2 w-8">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={toggleAll}
                        disabled={applicableRows.length === 0}
                        data-testid="checkbox-rematch-select-all"
                      />
                    </th>
                    <th className="py-2 pr-2"><TechnicalLabel>Project</TechnicalLabel></th>
                    <th className="py-2 pr-2"><TechnicalLabel>Devis</TechnicalLabel></th>
                    <th className="py-2 pr-2"><TechnicalLabel>Current</TechnicalLabel></th>
                    <th className="py-2 pr-2"><TechnicalLabel>Suggested</TechnicalLabel></th>
                    <th className="py-2 pr-2"><TechnicalLabel>Confidence</TechnicalLabel></th>
                    <th className="py-2 pr-2"><TechnicalLabel>Status</TechnicalLabel></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr
                      key={r.devisId}
                      className={cn(
                        "border-b border-[rgba(0,0,0,0.04)]",
                        !r.applicable && "opacity-60"
                      )}
                      data-testid={`row-rematch-${r.devisId}`}
                    >
                      <td className="py-2 pr-2">
                        <Checkbox
                          checked={selected.has(r.devisId)}
                          onCheckedChange={() => toggleOne(r.devisId, r.applicable)}
                          disabled={!r.applicable}
                          data-testid={`checkbox-rematch-${r.devisId}`}
                        />
                      </td>
                      <td className="py-2 pr-2 align-top">
                        <div className="font-medium" data-testid={`text-rematch-project-${r.devisId}`}>
                          {r.projectName ?? `#${r.projectId}`}
                        </div>
                      </td>
                      <td className="py-2 pr-2 align-top">
                        <div className="font-medium">{r.devisCode ?? `#${r.devisId}`}</div>
                        {r.devisNumber && (
                          <div className="text-[10px] text-muted-foreground">{r.devisNumber}</div>
                        )}
                      </td>
                      <td className="py-2 pr-2 align-top text-rose-700" data-testid={`text-rematch-current-${r.devisId}`}>
                        {r.currentContractorName ?? `#${r.currentContractorId}`}
                      </td>
                      <td className="py-2 pr-2 align-top text-emerald-700" data-testid={`text-rematch-suggested-${r.devisId}`}>
                        {r.suggestedContractorName}
                        {r.suggestedContractorOrphaned && (
                          <span className="ml-1 text-[9px] text-amber-700">(orphaned)</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 align-top">{Math.round(r.confidence)}%</td>
                      <td className="py-2 pr-2 align-top">
                        {r.applicable ? (
                          <span className="text-[10px] text-muted-foreground">{r.status}</span>
                        ) : (
                          <span className="text-[10px] text-amber-700" data-testid={`text-rematch-blocked-${r.devisId}`}>
                            {r.blockedReason}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex items-center justify-end gap-3">
              <span className="text-[10px] text-muted-foreground">
                {selected.size} selected
              </span>
              <Button
                size="sm"
                onClick={() => applyMutation.mutate(Array.from(selected))}
                disabled={selected.size === 0 || applyMutation.isPending}
                data-testid="button-rematch-apply"
              >
                {applyMutation.isPending ? (
                  <Loader2 size={12} className="mr-1.5 animate-spin" />
                ) : (
                  <Check size={12} className="mr-1.5" />
                )}
                <span className="text-[10px] font-bold uppercase tracking-widest">
                  Apply {selected.size > 0 ? `(${selected.size})` : ""}
                </span>
              </Button>
            </div>
          </>
        )}
      </LuxuryCard>
    </div>
  );
}

interface InvoiceRematchPreviewRow {
  invoiceId: number;
  invoiceNumber: string | null;
  projectId: number;
  projectName: string | null;
  currentContractorId: number;
  currentContractorName: string | null;
  suggestedContractorId: number;
  suggestedContractorName: string;
  suggestedContractorOrphaned: boolean;
  confidence: number;
  matchedFields: Record<string, string>;
  status: string;
  projectArchived: boolean;
  applicable: boolean;
  blockedReason: string | null;
}

function InvoiceRematchSection() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const { data, isFetching, refetch } = useQuery<{ rows: InvoiceRematchPreviewRow[] }>({
    queryKey: ["/api/admin/invoice-rematch/preview"],
  });

  const rows = data?.rows ?? [];
  const applicableRows = rows.filter(r => r.applicable);

  const applyMutation = useMutation({
    mutationFn: async (invoiceIds: number[]) => {
      const res = await apiRequest("POST", "/api/admin/invoice-rematch/apply", { invoiceIds });
      return (await res.json()) as {
        applied: Array<{ invoiceId: number; previousContractorId: number; newContractorId: number }>;
        skipped: Array<{ invoiceId: number; reason: string }>;
      };
    },
    onSuccess: (result) => {
      const appliedCount = result.applied.length;
      const skippedCount = result.skipped.length;
      toast({
        title: `Applied ${appliedCount} correction${appliedCount === 1 ? "" : "s"}`,
        description: skippedCount > 0
          ? `${skippedCount} skipped — see preview after refresh`
          : "All selected invoices updated",
        variant: appliedCount === 0 ? "destructive" : undefined,
      });
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoice-rematch/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Apply failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleOne = (id: number, applicable: boolean) => {
    if (!applicable) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === applicableRows.length && applicableRows.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(applicableRows.map(r => r.invoiceId)));
    }
  };

  const allSelected = applicableRows.length > 0 && selected.size === applicableRows.length;

  return (
    <div className="mt-10">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2
            className="text-[16px] font-black uppercase tracking-tight mb-1"
            style={{ color: "#0B2545" }}
            data-testid="text-invoice-rematch-title"
          >
            Re-match Invoice Contractors
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Re-runs the SIRET / name matcher against every invoice using its already-stored extraction data.
            No AI calls are made. Review and apply auto-corrections in bulk.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-invoice-rematch-refresh"
        >
          <RefreshCw size={12} className={cn("mr-1.5", isFetching && "animate-spin")} />
          <span className="text-[10px] font-bold uppercase tracking-widest">
            {isFetching ? "Scanning..." : "Refresh"}
          </span>
        </Button>
      </div>

      <LuxuryCard>
        <div className="flex items-start gap-3 mb-5">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ backgroundColor: "rgba(11, 37, 69, 0.08)" }}
          >
            <Users size={14} style={{ color: "#0B2545" }} />
          </div>
          <div className="flex-1">
            <h3 className="text-[12px] font-bold text-foreground mb-0.5">
              Suggested corrections {rows.length > 0 ? `(${applicableRows.length} applicable, ${rows.length} total)` : ""}
            </h3>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Each applied row writes a manual-edit audit entry, exactly as if a user had edited the invoice contractor by hand.
            </p>
          </div>
        </div>

        {isFetching && rows.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-[11px] text-muted-foreground py-6 text-center" data-testid="text-invoice-rematch-empty">
            No mismatches found. Every invoice already matches what the current AI matcher would assign.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left border-b border-[rgba(0,0,0,0.06)]">
                    <th className="py-2 pr-2 w-8">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={toggleAll}
                        disabled={applicableRows.length === 0}
                        data-testid="checkbox-invoice-rematch-select-all"
                      />
                    </th>
                    <th className="py-2 pr-2"><TechnicalLabel>Project</TechnicalLabel></th>
                    <th className="py-2 pr-2"><TechnicalLabel>Invoice</TechnicalLabel></th>
                    <th className="py-2 pr-2"><TechnicalLabel>Current</TechnicalLabel></th>
                    <th className="py-2 pr-2"><TechnicalLabel>Suggested</TechnicalLabel></th>
                    <th className="py-2 pr-2"><TechnicalLabel>Confidence</TechnicalLabel></th>
                    <th className="py-2 pr-2"><TechnicalLabel>Status</TechnicalLabel></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr
                      key={r.invoiceId}
                      className={cn(
                        "border-b border-[rgba(0,0,0,0.04)]",
                        !r.applicable && "opacity-60"
                      )}
                      data-testid={`row-invoice-rematch-${r.invoiceId}`}
                    >
                      <td className="py-2 pr-2">
                        <Checkbox
                          checked={selected.has(r.invoiceId)}
                          onCheckedChange={() => toggleOne(r.invoiceId, r.applicable)}
                          disabled={!r.applicable}
                          data-testid={`checkbox-invoice-rematch-${r.invoiceId}`}
                        />
                      </td>
                      <td className="py-2 pr-2 align-top">
                        <div className="font-medium" data-testid={`text-invoice-rematch-project-${r.invoiceId}`}>
                          {r.projectName ?? `#${r.projectId}`}
                        </div>
                      </td>
                      <td className="py-2 pr-2 align-top">
                        <div className="font-medium">{r.invoiceNumber ?? `#${r.invoiceId}`}</div>
                      </td>
                      <td className="py-2 pr-2 align-top text-rose-700" data-testid={`text-invoice-rematch-current-${r.invoiceId}`}>
                        {r.currentContractorName ?? `#${r.currentContractorId}`}
                      </td>
                      <td className="py-2 pr-2 align-top text-emerald-700" data-testid={`text-invoice-rematch-suggested-${r.invoiceId}`}>
                        {r.suggestedContractorName}
                        {r.suggestedContractorOrphaned && (
                          <span className="ml-1 text-[9px] text-amber-700">(orphaned)</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 align-top">{Math.round(r.confidence)}%</td>
                      <td className="py-2 pr-2 align-top">
                        {r.applicable ? (
                          <span className="text-[10px] text-muted-foreground">{r.status}</span>
                        ) : (
                          <span className="text-[10px] text-amber-700" data-testid={`text-invoice-rematch-blocked-${r.invoiceId}`}>
                            {r.blockedReason}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex items-center justify-end gap-3">
              <span className="text-[10px] text-muted-foreground">
                {selected.size} selected
              </span>
              <Button
                size="sm"
                onClick={() => applyMutation.mutate(Array.from(selected))}
                disabled={selected.size === 0 || applyMutation.isPending}
                data-testid="button-invoice-rematch-apply"
              >
                {applyMutation.isPending ? (
                  <Loader2 size={12} className="mr-1.5 animate-spin" />
                ) : (
                  <Check size={12} className="mr-1.5" />
                )}
                <span className="text-[10px] font-bold uppercase tracking-widest">
                  Apply {selected.size > 0 ? `(${selected.size})` : ""}
                </span>
              </Button>
            </div>
          </>
        )}
      </LuxuryCard>
    </div>
  );
}

interface BackfillStats {
  devisId: number;
  devisCode: string | null;
  status:
    | "skipped-no-pdf"
    | "skipped-no-lines"
    | "skipped-already-complete"
    | "skipped-parse-failed"
    | "skipped-no-extracted-lines"
    | "updated"
    | "no-new-hints";
  lineItems: number;
  alreadyHinted: number;
  updated: number;
  reason?: string;
}

interface PageHintCandidate {
  devisId: number;
  devisCode: string | null;
  devisNumber: string | null;
  projectId: number;
  projectName: string | null;
  totalLines: number;
  missingHints: number;
}

interface PageHintStats {
  totalDevisWithPdf: number;
  devisMissingHints: number;
  lineItemsMissingHints: number;
  candidates: PageHintCandidate[];
}

interface BulkProgress {
  processed: number;
  total: number;
  updatedDevis: number;
  skippedDevis: number;
  failedDevis: number;
  totalLineItemsUpdated: number;
  currentLabel?: string;
  done: boolean;
  aborted: boolean;
  error?: string;
}

function PageHintBackfillSection() {
  const { toast } = useToast();
  const [runningId, setRunningId] = useState<number | null>(null);
  const [lastResultByDevis, setLastResultByDevis] = useState<Record<number, BackfillStats>>({});
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const { data, isFetching, refetch } = useQuery<PageHintStats>({
    queryKey: ["/api/admin/page-hint-backfill/stats"],
  });

  const candidates = data?.candidates ?? [];
  const bulkRunning = bulkProgress != null && !bulkProgress.done && bulkProgress.error == null;

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

  const startBulk = () => {
    if (bulkRunning) return;
    if (candidates.length === 0) return;
    setLastResultByDevis({});
    setBulkProgress({
      processed: 0,
      total: candidates.length,
      updatedDevis: 0,
      skippedDevis: 0,
      failedDevis: 0,
      totalLineItemsUpdated: 0,
      done: false,
      aborted: false,
    });

    const es = new EventSource("/api/admin/page-hint-backfill/run-all", {
      withCredentials: true,
    });
    eventSourceRef.current = es;

    es.addEventListener("start", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { total: number };
      setBulkProgress((prev) =>
        prev ? { ...prev, total: data.total } : prev,
      );
    });

    es.addEventListener("progress", (ev) => {
      const payload = JSON.parse((ev as MessageEvent).data) as {
        processed: number;
        total: number;
        updatedDevis: number;
        skippedDevis: number;
        failedDevis: number;
        totalLineItemsUpdated: number;
        stats: BackfillStats;
        candidate: { devisId: number; devisCode: string | null; projectName: string | null };
      };
      setLastResultByDevis((prev) => ({ ...prev, [payload.stats.devisId]: payload.stats }));
      const label =
        payload.candidate.devisCode ??
        payload.candidate.projectName ??
        `#${payload.candidate.devisId}`;
      setBulkProgress({
        processed: payload.processed,
        total: payload.total,
        updatedDevis: payload.updatedDevis,
        skippedDevis: payload.skippedDevis,
        failedDevis: payload.failedDevis,
        totalLineItemsUpdated: payload.totalLineItemsUpdated,
        currentLabel: label,
        done: false,
        aborted: false,
      });
    });

    es.addEventListener("done", (ev) => {
      const payload = JSON.parse((ev as MessageEvent).data) as {
        processed: number;
        total: number;
        updatedDevis: number;
        skippedDevis: number;
        failedDevis: number;
        totalLineItemsUpdated: number;
        aborted: boolean;
      };
      setBulkProgress({ ...payload, done: true, currentLabel: undefined });
      es.close();
      eventSourceRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["/api/admin/page-hint-backfill/stats"] });
      toast({
        title: payload.aborted ? "Backfill stopped" : "Backfill all complete",
        description: `${payload.processed}/${payload.total} processed · ${payload.updatedDevis} updated · ${payload.skippedDevis} skipped · ${payload.failedDevis} failed · ${payload.totalLineItemsUpdated} line items patched.`,
      });
    });

    es.addEventListener("error", (ev) => {
      const isMessage = (ev as MessageEvent).data != null;
      let message = "Stream interrupted before completion.";
      if (isMessage) {
        try {
          const payload = JSON.parse((ev as MessageEvent).data) as { message?: string };
          message = payload.message ?? message;
        } catch {
          // not JSON — fall back to default message
        }
      }
      setBulkProgress((prev) =>
        prev ? { ...prev, done: true, error: message } : prev,
      );
      es.close();
      eventSourceRef.current = null;
      toast({ title: "Backfill all failed", description: message, variant: "destructive" });
    });
  };

  const stopBulk = () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setBulkProgress((prev) =>
      prev ? { ...prev, done: true, aborted: true, currentLabel: undefined } : prev,
    );
    queryClient.invalidateQueries({ queryKey: ["/api/admin/page-hint-backfill/stats"] });
  };

  const runMutation = useMutation({
    mutationFn: async (devisId: number) => {
      const res = await apiRequest("POST", "/api/admin/page-hint-backfill/run", { devisId });
      return (await res.json()) as { stats: BackfillStats };
    },
    onMutate: (devisId: number) => {
      setRunningId(devisId);
    },
    onSuccess: (result, devisId) => {
      setLastResultByDevis((prev) => ({ ...prev, [devisId]: result.stats }));
      const s = result.stats;
      const tag = s.devisCode ?? `#${s.devisId}`;
      if (s.status === "updated") {
        toast({
          title: `${tag}: ${s.updated} hint${s.updated === 1 ? "" : "s"} added`,
          description: `${s.alreadyHinted} were already set, ${s.lineItems - s.alreadyHinted} were pending.`,
        });
      } else if (s.status === "no-new-hints") {
        toast({
          title: `${tag}: re-extracted but no usable hints`,
          description: "The AI did not emit page hints for the pending lines.",
          variant: "destructive",
        });
      } else {
        toast({
          title: `${tag}: ${s.status}`,
          description: s.reason ?? "Nothing to do.",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/admin/page-hint-backfill/stats"] });
    },
    onError: (err: Error) => {
      toast({ title: "Backfill failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => {
      setRunningId(null);
    },
  });

  return (
    <div className="mt-10">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2
            className="text-[16px] font-black uppercase tracking-tight mb-1"
            style={{ color: "#0B2545" }}
            data-testid="text-page-hint-backfill-title"
          >
            Backfill PDF Page Hints
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Re-extracts the per-line PDF page hint used by the contractor portal's
            "Voir page N" button. Triggers the same per-devis logic as the CLI script.
            Only the page-hint column is patched — descriptions, totals and other fields are left alone.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {bulkRunning ? (
            <Button
              size="sm"
              variant="outline"
              onClick={stopBulk}
              data-testid="button-page-hint-bulk-stop"
            >
              <span className="text-[10px] font-bold uppercase tracking-widest">Stop</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={startBulk}
              disabled={candidates.length === 0 || isFetching}
              data-testid="button-page-hint-bulk-run"
            >
              <Wand2 size={12} className="mr-1.5" />
              <span className="text-[10px] font-bold uppercase tracking-widest">
                {`Backfill all (${candidates.length})`}
              </span>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching || bulkRunning}
            data-testid="button-page-hint-refresh"
          >
            <RefreshCw size={12} className={cn("mr-1.5", isFetching && "animate-spin")} />
            <span className="text-[10px] font-bold uppercase tracking-widest">
              {isFetching ? "Scanning..." : "Refresh"}
            </span>
          </Button>
        </div>
      </div>

      {bulkProgress && (
        <div
          className="mb-4 rounded-md border border-[rgba(0,0,0,0.08)] bg-[rgba(11,37,69,0.03)] px-4 py-3"
          data-testid="bulk-page-hint-progress"
        >
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="text-[11px] font-bold text-foreground">
              {bulkProgress.error
                ? "Bulk backfill failed"
                : bulkProgress.done
                  ? bulkProgress.aborted
                    ? "Bulk backfill stopped"
                    : "Bulk backfill complete"
                  : "Bulk backfill in progress"}
            </div>
            <div
              className="text-[10px] text-muted-foreground tabular-nums"
              data-testid="text-page-hint-bulk-counter"
            >
              {bulkProgress.processed} / {bulkProgress.total}
            </div>
          </div>
          <div className="h-1.5 rounded-full bg-[rgba(0,0,0,0.06)] overflow-hidden">
            <div
              className="h-full bg-[#0B2545] transition-all"
              style={{
                width: `${
                  bulkProgress.total > 0
                    ? Math.min(
                        100,
                        Math.round((bulkProgress.processed / bulkProgress.total) * 100),
                      )
                    : 0
                }%`,
              }}
              data-testid="bar-page-hint-bulk-progress"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
            <span data-testid="text-page-hint-bulk-updated">
              <span className="text-emerald-700 font-medium">{bulkProgress.updatedDevis}</span> updated
            </span>
            <span data-testid="text-page-hint-bulk-skipped">
              <span className="text-foreground font-medium">{bulkProgress.skippedDevis}</span> skipped
            </span>
            <span data-testid="text-page-hint-bulk-failed">
              <span className="text-rose-700 font-medium">{bulkProgress.failedDevis}</span> failed
            </span>
            <span data-testid="text-page-hint-bulk-lines">
              <span className="text-foreground font-medium">{bulkProgress.totalLineItemsUpdated}</span> line items patched
            </span>
            {bulkProgress.currentLabel && !bulkProgress.done && (
              <span data-testid="text-page-hint-bulk-current">
                Currently: {bulkProgress.currentLabel}
              </span>
            )}
            {bulkProgress.error && (
              <span className="text-rose-700" data-testid="text-page-hint-bulk-error">
                {bulkProgress.error}
              </span>
            )}
          </div>
        </div>
      )}

      <LuxuryCard>
        <div className="flex items-start gap-3 mb-5">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ backgroundColor: "rgba(11, 37, 69, 0.08)" }}
          >
            <FileText size={14} style={{ color: "#0B2545" }} />
          </div>
          <div className="flex-1">
            <h3 className="text-[12px] font-bold text-foreground mb-0.5">
              Coverage
            </h3>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              {data
                ? `${data.devisMissingHints} of ${data.totalDevisWithPdf} devis-with-PDF are missing at least one page hint (${data.lineItemsMissingHints} line item${data.lineItemsMissingHints === 1 ? "" : "s"} pending).`
                : "Loading coverage statistics..."}
            </p>
          </div>
        </div>

        {isFetching && candidates.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
          </div>
        ) : candidates.length === 0 ? (
          <div className="text-[11px] text-muted-foreground py-6 text-center" data-testid="text-page-hint-empty">
            Every devis with a stored PDF already has page hints on every line item. Nothing to backfill.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left border-b border-[rgba(0,0,0,0.06)]">
                  <th className="py-2 pr-2"><TechnicalLabel>Project</TechnicalLabel></th>
                  <th className="py-2 pr-2"><TechnicalLabel>Devis</TechnicalLabel></th>
                  <th className="py-2 pr-2 text-right"><TechnicalLabel>Pending / Total</TechnicalLabel></th>
                  <th className="py-2 pr-2"><TechnicalLabel>Last result</TechnicalLabel></th>
                  <th className="py-2 pr-2 text-right"><TechnicalLabel>Action</TechnicalLabel></th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const last = lastResultByDevis[c.devisId];
                  const isRunning = runningId === c.devisId && runMutation.isPending;
                  return (
                    <tr
                      key={c.devisId}
                      className="border-b border-[rgba(0,0,0,0.04)]"
                      data-testid={`row-page-hint-${c.devisId}`}
                    >
                      <td className="py-2 pr-2 align-top">
                        <div className="font-medium" data-testid={`text-page-hint-project-${c.devisId}`}>
                          {c.projectName ?? `#${c.projectId}`}
                        </div>
                      </td>
                      <td className="py-2 pr-2 align-top">
                        <div className="font-medium">{c.devisCode ?? `#${c.devisId}`}</div>
                        {c.devisNumber && (
                          <div className="text-[10px] text-muted-foreground">{c.devisNumber}</div>
                        )}
                      </td>
                      <td className="py-2 pr-2 align-top text-right" data-testid={`text-page-hint-pending-${c.devisId}`}>
                        <span className="text-amber-700 font-medium">{c.missingHints}</span>
                        <span className="text-muted-foreground"> / {c.totalLines}</span>
                      </td>
                      <td className="py-2 pr-2 align-top">
                        {last ? (
                          <span
                            className={cn(
                              "text-[10px]",
                              last.status === "updated" && "text-emerald-700",
                              last.status === "no-new-hints" && "text-amber-700",
                              last.status.startsWith("skipped") && "text-muted-foreground",
                            )}
                            data-testid={`text-page-hint-last-${c.devisId}`}
                          >
                            {last.status === "updated"
                              ? `+${last.updated} hint${last.updated === 1 ? "" : "s"}`
                              : last.status}
                            {last.reason ? ` — ${last.reason}` : ""}
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 align-top text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runMutation.mutate(c.devisId)}
                          disabled={runMutation.isPending || bulkRunning}
                          data-testid={`button-page-hint-run-${c.devisId}`}
                        >
                          {isRunning ? (
                            <Loader2 size={12} className="mr-1.5 animate-spin" />
                          ) : (
                            <Wand2 size={12} className="mr-1.5" />
                          )}
                          <span className="text-[10px] font-bold uppercase tracking-widest">
                            {isRunning ? "Running..." : "Backfill"}
                          </span>
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </LuxuryCard>
    </div>
  );
}

function LotCatalogSection() {
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const [descriptionFr, setDescriptionFr] = useState("");
  const [descriptionUk, setDescriptionUk] = useState("");
  const [editing, setEditing] = useState<LotCatalog | null>(null);
  const [editCode, setEditCode] = useState("");
  const [editDescriptionFr, setEditDescriptionFr] = useState("");
  const [editDescriptionUk, setEditDescriptionUk] = useState("");
  const [deleting, setDeleting] = useState<LotCatalog | null>(null);

  const { data: catalog, isLoading } = useQuery<LotCatalog[]>({
    queryKey: ["/api/lot-catalog"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { code: string; descriptionFr: string; descriptionUk?: string | null }) => {
      const res = await apiRequest("POST", "/api/lot-catalog", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lot-catalog"] });
      setCode("");
      setDescriptionFr("");
      setDescriptionUk("");
      toast({ title: "Lot added to master list" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to add lot", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: { code: string; descriptionFr: string; descriptionUk?: string | null } }) => {
      const res = await apiRequest("PATCH", `/api/lot-catalog/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lot-catalog"] });
      setEditing(null);
      toast({ title: "Lot updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update lot", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/lot-catalog/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lot-catalog"] });
      setDeleting(null);
      toast({ title: "Lot deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Cannot delete lot", description: error.message, variant: "destructive" });
    },
  });

  type SuggestTarget = "add" | "edit";
  const [suggesting, setSuggesting] = useState<SuggestTarget | null>(null);

  type BulkRow = {
    id: number;
    code: string;
    descriptionFr: string;
    translation: string;
    edited: string;
    skipped: boolean;
    error?: string;
  };
  const [bulkRows, setBulkRows] = useState<BulkRow[] | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);

  const emptyRows = (catalog ?? []).filter(
    (e) => !e.descriptionUk || e.descriptionUk.trim().length === 0,
  );

  const startBulkSuggest = async () => {
    if (emptyRows.length === 0) {
      toast({ title: "Nothing to translate", description: "All lots already have an English description." });
      return;
    }
    setBulkLoading(true);
    setBulkRows([]);
    try {
      const res = await apiRequest("POST", "/api/lot-catalog/translate-batch", {
        items: emptyRows.map((e) => ({
          id: e.id,
          descriptionFr: e.descriptionFr,
          code: e.code,
        })),
      });
      const data = (await res.json()) as {
        results: Array<{ id: number; ok: boolean; translation?: string; error?: string }>;
      };
      const byId = new Map(data.results.map((r) => [r.id, r]));
      const rows: BulkRow[] = emptyRows.map((e) => {
        const r = byId.get(e.id);
        return {
          id: e.id,
          code: e.code,
          descriptionFr: e.descriptionFr,
          translation: r?.translation ?? "",
          edited: r?.translation ?? "",
          skipped: !r?.ok,
          error: r?.ok ? undefined : r?.error ?? "Translation failed",
        };
      });
      setBulkRows(rows);
      const failures = rows.filter((r) => r.error).length;
      if (failures > 0) {
        toast({
          title: `Generated ${rows.length - failures} of ${rows.length} suggestions`,
          description: `${failures} failed — review and retry by editing manually.`,
          variant: failures === rows.length ? "destructive" : undefined,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bulk translation failed";
      toast({ title: "Bulk translation failed", description: message, variant: "destructive" });
      setBulkRows(null);
    } finally {
      setBulkLoading(false);
    }
  };

  const saveBulk = async () => {
    if (!bulkRows) return;
    const toSave = bulkRows.filter((r) => !r.skipped && r.edited.trim().length > 0);
    if (toSave.length === 0) {
      toast({ title: "Nothing to save", description: "Accept at least one suggestion first." });
      return;
    }
    setBulkSaving(true);
    const savedIds = new Set<number>();
    const failedIds = new Map<number, string>();
    for (const row of toSave) {
      try {
        await apiRequest("PATCH", `/api/lot-catalog/${row.id}`, {
          descriptionUk: row.edited.trim(),
        });
        savedIds.add(row.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Save failed";
        failedIds.set(row.id, message);
        console.warn(`[LotCatalog] Failed to save translation for ${row.code}:`, err);
      }
    }
    setBulkSaving(false);
    queryClient.invalidateQueries({ queryKey: ["/api/lot-catalog"] });
    const saved = savedIds.size;
    const failed = failedIds.size;
    if (failed === 0) {
      toast({ title: `Saved ${saved} translation${saved === 1 ? "" : "s"}` });
      setBulkRows(null);
    } else {
      // Drop saved rows so a retry only targets the failures.
      setBulkRows((prev) =>
        prev
          ? prev
              .filter((r) => !savedIds.has(r.id))
              .map((r) =>
                failedIds.has(r.id)
                  ? { ...r, error: failedIds.get(r.id), skipped: false }
                  : r,
              )
          : prev,
      );
      toast({
        title: `Saved ${saved}, ${failed} failed`,
        description: "Failed rows remain in the dialog for retry.",
        variant: "destructive",
      });
    }
  };

  const suggestMutation = useMutation({
    mutationFn: async (data: { descriptionFr: string; code?: string }) => {
      const res = await apiRequest("POST", "/api/lot-catalog/translate", data);
      return (await res.json()) as { translation: string };
    },
    onError: (error: Error) => {
      toast({ title: "Could not suggest translation", description: error.message, variant: "destructive" });
    },
  });

  const suggestForAdd = async () => {
    const fr = descriptionFr.trim();
    if (!fr) {
      toast({ title: "Add a French description first", variant: "destructive" });
      return;
    }
    setSuggesting("add");
    try {
      const { translation } = await suggestMutation.mutateAsync({ descriptionFr: fr, code: code.trim() || undefined });
      setDescriptionUk(translation);
    } catch {
      // toast handled in onError
    } finally {
      setSuggesting(null);
    }
  };

  const suggestForEdit = async () => {
    const fr = editDescriptionFr.trim();
    if (!fr) {
      toast({ title: "French description is required", variant: "destructive" });
      return;
    }
    setSuggesting("edit");
    try {
      const { translation } = await suggestMutation.mutateAsync({ descriptionFr: fr, code: editCode.trim() || undefined });
      setEditDescriptionUk(translation);
    } catch {
      // toast handled in onError
    } finally {
      setSuggesting(null);
    }
  };

  const suggestForRow = async (entry: LotCatalog) => {
    setEditing(entry);
    setEditCode(entry.code);
    setEditDescriptionFr(entry.descriptionFr);
    setEditDescriptionUk(entry.descriptionUk ?? "");
    setSuggesting("edit");
    try {
      const { translation } = await suggestMutation.mutateAsync({
        descriptionFr: entry.descriptionFr,
        code: entry.code,
      });
      setEditDescriptionUk(translation);
    } catch {
      // toast handled in onError
    } finally {
      setSuggesting(null);
    }
  };

  const openEdit = (entry: LotCatalog) => {
    setEditing(entry);
    setEditCode(entry.code);
    setEditDescriptionFr(entry.descriptionFr);
    setEditDescriptionUk(entry.descriptionUk ?? "");
  };

  const canSubmit = code.trim().length > 0 && descriptionFr.trim().length > 0 && !createMutation.isPending;
  const canSaveEdit =
    editing !== null &&
    editCode.trim().length > 0 &&
    editDescriptionFr.trim().length > 0 &&
    !updateMutation.isPending &&
    (editCode.trim().toUpperCase() !== editing.code ||
      editDescriptionFr.trim() !== editing.descriptionFr ||
      editDescriptionUk.trim() !== (editing.descriptionUk ?? ""));

  return (
    <div className="mt-10">
      <div className="mb-6">
        <h2
          className="text-[16px] font-black uppercase tracking-tight mb-1"
          style={{ color: "#0B2545" }}
          data-testid="text-lot-catalog-title"
        >
          Lots Master List
        </h2>
        <p className="text-[11px] text-muted-foreground mb-4">
          Standard lot codes used across all projects. Selecting a lot on a Devis pulls from this list.
        </p>
      </div>

      <LuxuryCard>
        <div className="flex items-start gap-3 mb-5">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ backgroundColor: "rgba(11, 37, 69, 0.08)" }}
          >
            <Layers size={14} style={{ color: "#0B2545" }} />
          </div>
          <div className="flex-1">
            <h3 className="text-[12px] font-bold text-foreground mb-0.5">Add a new lot</h3>
            <p className="text-[10px] text-muted-foreground leading-relaxed mb-3">
              New entries become available on every project's Lot Assignment dropdown.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr_1fr_auto] gap-2">
              <Input
                placeholder="Code (e.g. LOT3)"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                className="text-[11px] uppercase tracking-wider"
                maxLength={16}
                data-testid="input-lot-catalog-code"
              />
              <Input
                placeholder="French description"
                value={descriptionFr}
                onChange={(e) => setDescriptionFr(e.target.value)}
                className="text-[11px]"
                maxLength={200}
                data-testid="input-lot-catalog-description"
              />
              <div className="relative">
                <Input
                  placeholder="English description (optional)"
                  value={descriptionUk}
                  onChange={(e) => setDescriptionUk(e.target.value)}
                  className="text-[11px] pr-8"
                  maxLength={200}
                  data-testid="input-lot-catalog-description-uk"
                />
                <button
                  type="button"
                  onClick={suggestForAdd}
                  disabled={suggesting !== null || descriptionFr.trim().length === 0}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-[rgba(0,0,0,0.05)] disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Suggest English translation"
                  aria-label="Suggest English translation"
                  data-testid="button-suggest-lot-catalog-description-uk"
                >
                  {suggesting === "add" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Wand2 size={12} />
                  )}
                </button>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  const uk = descriptionUk.trim();
                  createMutation.mutate({
                    code: code.trim(),
                    descriptionFr: descriptionFr.trim(),
                    descriptionUk: uk.length > 0 ? uk : null,
                  });
                }}
                disabled={!canSubmit}
                data-testid="button-add-lot-catalog"
              >
                <Plus size={12} className="mr-1.5" />
                <span className="text-[10px] font-bold uppercase tracking-widest">
                  {createMutation.isPending ? "Adding..." : "Add Lot"}
                </span>
              </Button>
            </div>
          </div>
        </div>

        <div className="border-t border-[rgba(0,0,0,0.06)] pt-4">
          <div className="flex items-center justify-between mb-3 gap-3">
            <TechnicalLabel className="block">
              Master List ({catalog?.length ?? 0} {catalog?.length === 1 ? "entry" : "entries"})
            </TechnicalLabel>
            <Button
              size="sm"
              variant="outline"
              onClick={startBulkSuggest}
              disabled={bulkLoading || emptyRows.length === 0}
              data-testid="button-suggest-all-empty"
              title={
                emptyRows.length === 0
                  ? "Every lot already has an English description"
                  : `Generate English suggestions for ${emptyRows.length} empty row${emptyRows.length === 1 ? "" : "s"}`
              }
            >
              {bulkLoading ? (
                <Loader2 size={12} className="mr-1.5 animate-spin" />
              ) : (
                <Wand2 size={12} className="mr-1.5" />
              )}
              <span className="text-[10px] font-bold uppercase tracking-widest">
                {bulkLoading
                  ? "Suggesting..."
                  : `Suggest English for all empty${emptyRows.length > 0 ? ` (${emptyRows.length})` : ""}`}
              </span>
            </Button>
          </div>
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-md" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {catalog?.map((entry) => (
                <div
                  key={entry.id}
                  className="group flex items-center gap-2 px-3 py-2 rounded-md bg-[rgba(0,0,0,0.02)] border border-[rgba(0,0,0,0.04)]"
                  data-testid={`row-lot-catalog-${entry.code}`}
                >
                  <span
                    className="text-[10px] font-black uppercase tracking-widest shrink-0 px-1.5 py-0.5 rounded bg-[rgba(11,37,69,0.08)]"
                    style={{ color: "#0B2545" }}
                    data-testid={`text-lot-catalog-code-${entry.code}`}
                  >
                    {entry.code}
                  </span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-[11px] text-foreground truncate" data-testid={`text-lot-catalog-description-${entry.code}`}>
                      {entry.descriptionFr}
                    </span>
                    <span
                      className="text-[10px] text-muted-foreground truncate italic"
                      data-testid={`text-lot-catalog-description-uk-${entry.code}`}
                    >
                      {entry.descriptionUk ?? "No English description"}
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() => suggestForRow(entry)}
                      disabled={suggesting !== null}
                      data-testid={`button-suggest-lot-catalog-${entry.code}`}
                      aria-label={`Suggest English for ${entry.code}`}
                      title="Suggest English translation"
                    >
                      <Wand2 size={11} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() => openEdit(entry)}
                      data-testid={`button-edit-lot-catalog-${entry.code}`}
                      aria-label={`Edit ${entry.code}`}
                    >
                      <Pencil size={11} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      onClick={() => setDeleting(entry)}
                      data-testid={`button-delete-lot-catalog-${entry.code}`}
                      aria-label={`Delete ${entry.code}`}
                    >
                      <Trash2 size={11} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </LuxuryCard>

      <Dialog
        open={bulkRows !== null}
        onOpenChange={(open) => {
          if (!open && !bulkSaving) setBulkRows(null);
        }}
      >
        <DialogContent className="max-w-2xl" data-testid="dialog-bulk-suggest-lot-catalog">
          <DialogHeader>
            <DialogTitle>Review English suggestions</DialogTitle>
            <DialogDescription>
              Edit, accept, or skip each suggestion. Nothing is saved until you click "Save accepted".
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-2 py-2 pr-1">
            {bulkRows?.length === 0 ? (
              <div className="text-[11px] text-muted-foreground py-4 text-center">
                No empty rows to translate.
              </div>
            ) : (
              bulkRows?.map((row, idx) => (
                <div
                  key={row.id}
                  className={cn(
                    "flex items-start gap-2 p-2 rounded-md border",
                    row.skipped
                      ? "border-[rgba(0,0,0,0.04)] bg-[rgba(0,0,0,0.02)] opacity-60"
                      : "border-[rgba(0,0,0,0.06)] bg-white",
                  )}
                  data-testid={`row-bulk-suggest-${row.code}`}
                >
                  <span
                    className="text-[10px] font-black uppercase tracking-widest shrink-0 px-1.5 py-0.5 rounded bg-[rgba(11,37,69,0.08)]"
                    style={{ color: "#0B2545" }}
                  >
                    {row.code}
                  </span>
                  <div className="flex flex-col flex-1 min-w-0 gap-1">
                    <span className="text-[11px] text-foreground truncate" title={row.descriptionFr}>
                      {row.descriptionFr}
                    </span>
                    {row.error ? (
                      <span className="text-[10px] text-destructive" data-testid={`text-bulk-error-${row.code}`}>
                        {row.error}
                      </span>
                    ) : null}
                    <Input
                      value={row.edited}
                      onChange={(e) => {
                        const next = e.target.value;
                        setBulkRows((prev) =>
                          prev ? prev.map((r, i) => (i === idx ? { ...r, edited: next } : r)) : prev,
                        );
                      }}
                      disabled={row.skipped || bulkSaving}
                      placeholder={row.error ? "Type a translation manually" : "English description"}
                      className="text-[11px]"
                      maxLength={200}
                      data-testid={`input-bulk-suggest-${row.code}`}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={row.skipped ? "outline" : "ghost"}
                    onClick={() =>
                      setBulkRows((prev) =>
                        prev ? prev.map((r, i) => (i === idx ? { ...r, skipped: !r.skipped } : r)) : prev,
                      )
                    }
                    disabled={bulkSaving}
                    className="text-[10px] font-bold uppercase tracking-widest shrink-0"
                    data-testid={`button-bulk-toggle-${row.code}`}
                  >
                    {row.skipped ? "Include" : "Skip"}
                  </Button>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <div className="flex-1 text-[10px] text-muted-foreground">
              {bulkRows
                ? `${bulkRows.filter((r) => !r.skipped && r.edited.trim().length > 0).length} of ${bulkRows.length} ready to save`
                : ""}
            </div>
            <Button
              variant="outline"
              onClick={() => setBulkRows(null)}
              disabled={bulkSaving}
              data-testid="button-cancel-bulk-suggest"
            >
              Cancel
            </Button>
            <Button
              onClick={saveBulk}
              disabled={
                bulkSaving ||
                !bulkRows ||
                bulkRows.every((r) => r.skipped || r.edited.trim().length === 0)
              }
              data-testid="button-save-bulk-suggest"
            >
              {bulkSaving ? (
                <Loader2 size={12} className="mr-1.5 animate-spin" />
              ) : (
                <Check size={12} className="mr-1.5" />
              )}
              <span className="text-[10px] font-bold uppercase tracking-widest">
                {bulkSaving ? "Saving..." : "Save accepted"}
              </span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent data-testid="dialog-edit-lot-catalog">
          <DialogHeader>
            <DialogTitle>Edit lot</DialogTitle>
            <DialogDescription>
              Changes update the description for this lot everywhere it's used. Renaming the code also updates project lots.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <TechnicalLabel className="mb-1.5 block">Code</TechnicalLabel>
              <Input
                value={editCode}
                onChange={(e) => setEditCode(e.target.value.toUpperCase())}
                className="text-[11px] uppercase tracking-wider"
                maxLength={16}
                data-testid="input-edit-lot-catalog-code"
              />
            </div>
            <div>
              <TechnicalLabel className="mb-1.5 block">French description</TechnicalLabel>
              <Input
                value={editDescriptionFr}
                onChange={(e) => setEditDescriptionFr(e.target.value)}
                className="text-[11px]"
                maxLength={200}
                data-testid="input-edit-lot-catalog-description"
              />
            </div>
            <div>
              <TechnicalLabel className="mb-1.5 block">English description (optional)</TechnicalLabel>
              <div className="flex gap-2">
                <Input
                  value={editDescriptionUk}
                  onChange={(e) => setEditDescriptionUk(e.target.value)}
                  className="text-[11px] flex-1"
                  maxLength={200}
                  placeholder="Leave empty to clear"
                  data-testid="input-edit-lot-catalog-description-uk"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={suggestForEdit}
                  disabled={suggesting !== null || editDescriptionFr.trim().length === 0}
                  data-testid="button-suggest-edit-lot-catalog-description-uk"
                >
                  {suggesting === "edit" ? (
                    <Loader2 size={12} className="mr-1.5 animate-spin" />
                  ) : (
                    <Wand2 size={12} className="mr-1.5" />
                  )}
                  <span className="text-[10px] font-bold uppercase tracking-widest">
                    {suggesting === "edit" ? "Suggesting..." : "Suggest"}
                  </span>
                </Button>
              </div>
              <p className="mt-1 text-[9px] text-muted-foreground">
                Saving an English description backfills it on existing project lots that don't yet have one.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} data-testid="button-cancel-edit-lot-catalog">
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!editing) return;
                const uk = editDescriptionUk.trim();
                updateMutation.mutate({
                  id: editing.id,
                  data: {
                    code: editCode.trim(),
                    descriptionFr: editDescriptionFr.trim(),
                    descriptionUk: uk.length > 0 ? uk : null,
                  },
                });
              }}
              disabled={!canSaveEdit}
              data-testid="button-save-edit-lot-catalog"
            >
              {updateMutation.isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent data-testid="dialog-delete-lot-catalog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete lot "{deleting?.code}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the lot from the master list. If any project still uses this code, deletion will be blocked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-lot-catalog">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (deleting) deleteMutation.mutate(deleting.id);
              }}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-lot-catalog"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const ASSET_SLOTS = [
  {
    assetType: "company_logo",
    label: "Company Logo",
    description: "Displayed in the header of generated Certificats de Paiement and other documents",
    icon: Building2,
  },
  {
    assetType: "architects_order_logo",
    label: "Order of Architects Logo",
    description: "Displayed in the footer/registration section of generated certificates",
    icon: Scale,
  },
] as const;

interface WishListItemDto {
  id: number;
  type: "feature" | "bug";
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "done" | "wontfix";
  imageStorageKeys: string[];
  createdAt: string;
  updatedAt: string;
}

interface DraftImage {
  storageKey: string;
  previewUrl: string;
}

const WISH_STATUS_LABEL: Record<WishListItemDto["status"], string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
  wontfix: "Won't fix",
};

const WISH_STATUS_CLASS: Record<WishListItemDto["status"], string> = {
  open: "bg-amber-100 text-amber-800 border-amber-300",
  in_progress: "bg-blue-100 text-blue-800 border-blue-300",
  done: "bg-emerald-100 text-emerald-800 border-emerald-300",
  wontfix: "bg-slate-200 text-slate-700 border-slate-300",
};

function WishListSection() {
  const { toast } = useToast();
  const [type, setType] = useState<"feature" | "bug">("feature");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: items = [], isLoading } = useQuery<WishListItemDto[]>({
    queryKey: ["/api/wish-list"],
  });

  const uploadImageFile = async (file: File): Promise<string | null> => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Only images can be attached", variant: "destructive" });
      return null;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast({ title: "Image too large", description: "Max 8 MB per image", variant: "destructive" });
      return null;
    }
    setIsUploadingImage(true);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name || "pasted.png");
      const res = await fetch("/api/wish-list/upload-image", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => "Upload failed");
        throw new Error(msg || "Upload failed");
      }
      const json = (await res.json()) as { storageKey: string };
      const previewUrl = URL.createObjectURL(file);
      setDraftImages((prev) => [...prev, { storageKey: json.storageKey, previewUrl }]);
      return json.storageKey;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      toast({ title: "Image upload failed", description: message, variant: "destructive" });
      return null;
    } finally {
      setIsUploadingImage(false);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length === 0) return;
    e.preventDefault();
    for (const f of imageFiles) {
      // eslint-disable-next-line no-await-in-loop
      await uploadImageFile(f);
    }
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop
      await uploadImageFile(f);
    }
  };

  const removeDraftImage = (storageKey: string) => {
    setDraftImages((prev) => {
      const target = prev.find((d) => d.storageKey === storageKey);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((d) => d.storageKey !== storageKey);
    });
  };

  const createMutation = useMutation({
    mutationFn: async (body: { type: string; title: string; description: string; imageStorageKeys: string[] }) => {
      const res = await apiRequest("POST", "/api/wish-list", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wish-list"] });
      toast({ title: "Added to wish list" });
      setTitle("");
      setDescription("");
      setType("feature");
      draftImages.forEach((d) => URL.revokeObjectURL(d.previewUrl));
      setDraftImages([]);
    },
    onError: (err: Error) => {
      toast({ title: "Could not save", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: WishListItemDto["status"] }) => {
      const res = await apiRequest("PATCH", `/api/wish-list/${id}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wish-list"] });
    },
    onError: (err: Error) => {
      toast({ title: "Could not update", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/wish-list/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wish-list"] });
      toast({ title: "Removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Could not delete", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      toast({ title: "Title is required", variant: "destructive" });
      return;
    }
    createMutation.mutate({
      type,
      title: trimmed,
      description: description.trim(),
      imageStorageKeys: draftImages.map((d) => d.storageKey),
    });
  };

  const openItems = items.filter((i) => i.status === "open" || i.status === "in_progress");
  const closedItems = items.filter((i) => i.status === "done" || i.status === "wontfix");

  return (
    <div className="mt-10">
      <div className="mb-6">
        <h2
          className="text-[16px] font-black uppercase tracking-tight mb-1"
          style={{ color: "#0B2545" }}
          data-testid="text-wish-list-title"
        >
          Wish List
        </h2>
        <p className="text-[11px] text-muted-foreground">
          Capture feature requests and bugs as you think of them. They live here so nothing gets lost.
        </p>
      </div>

      <LuxuryCard>
        <form onSubmit={handleSubmit} className="space-y-3" data-testid="form-wish-list">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setType("feature")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-[11px] font-bold uppercase tracking-wide transition-colors ${
                type === "feature"
                  ? "bg-amber-50 border-amber-400 text-amber-900"
                  : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
              }`}
              data-testid="button-wish-type-feature"
            >
              <Lightbulb size={13} />
              Feature
            </button>
            <button
              type="button"
              onClick={() => setType("bug")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-[11px] font-bold uppercase tracking-wide transition-colors ${
                type === "bug"
                  ? "bg-rose-50 border-rose-400 text-rose-900"
                  : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
              }`}
              data-testid="button-wish-type-bug"
            >
              <Bug size={13} />
              Bug
            </button>
          </div>

          <Input
            placeholder={type === "bug" ? "What's broken? (short summary)" : "What would you like to see?"}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            data-testid="input-wish-title"
          />
          <textarea
            placeholder="Optional details — steps to reproduce, why it matters, etc. Tip: paste screenshots here."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onPaste={handlePaste}
            maxLength={2000}
            rows={3}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-[12px] text-foreground placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300"
            data-testid="textarea-wish-description"
          />

          {(draftImages.length > 0 || isUploadingImage) && (
            <div className="flex flex-wrap gap-2" data-testid="container-wish-draft-images">
              {draftImages.map((img) => (
                <div
                  key={img.storageKey}
                  className="relative group rounded-md overflow-hidden border border-slate-200 bg-slate-50"
                  data-testid={`thumb-wish-draft-${img.storageKey.slice(-12)}`}
                >
                  <img
                    src={img.previewUrl}
                    alt="Pasted attachment"
                    className="h-20 w-20 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeDraftImage(img.storageKey)}
                    className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    data-testid={`button-remove-draft-${img.storageKey.slice(-12)}`}
                    aria-label="Remove image"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
              {isUploadingImage && (
                <div className="h-20 w-20 rounded-md border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center">
                  <Loader2 size={16} className="animate-spin text-slate-400" />
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploadingImage}
                data-testid="button-wish-attach-image"
              >
                <Image size={13} className="mr-1.5" />
                Attach image
              </Button>
              <span className="text-[10px] text-muted-foreground hidden sm:inline">
                or paste a screenshot into the description
              </span>
            </div>
            <Button type="submit" size="sm" disabled={createMutation.isPending || isUploadingImage} data-testid="button-wish-submit">
              {createMutation.isPending ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Plus size={14} className="mr-1.5" />}
              Add to wish list
            </Button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFilePick}
            data-testid="input-file-wish-image"
          />
        </form>
      </LuxuryCard>

      <div className="mt-6">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic" data-testid="text-wish-empty">
            No items yet — add the first one above.
          </p>
        ) : (
          <div className="space-y-4">
            {openItems.length > 0 && (
              <WishListGroup
                heading={`Active (${openItems.length})`}
                items={openItems}
                onChangeStatus={(id, status) => updateMutation.mutate({ id, status })}
                onDelete={(id) => deleteMutation.mutate(id)}
              />
            )}
            {closedItems.length > 0 && (
              <WishListGroup
                heading={`Closed (${closedItems.length})`}
                items={closedItems}
                onChangeStatus={(id, status) => updateMutation.mutate({ id, status })}
                onDelete={(id) => deleteMutation.mutate(id)}
                muted
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WishListGroup({
  heading,
  items,
  onChangeStatus,
  onDelete,
  muted = false,
}: {
  heading: string;
  items: WishListItemDto[];
  onChangeStatus: (id: number, status: WishListItemDto["status"]) => void;
  onDelete: (id: number) => void;
  muted?: boolean;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-2">{heading}</h3>
      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            className={`rounded-lg border border-slate-200 bg-white p-3 ${muted ? "opacity-70" : ""}`}
            data-testid={`row-wish-${item.id}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <div
                  className={`shrink-0 mt-0.5 w-6 h-6 rounded-md flex items-center justify-center ${
                    item.type === "bug" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {item.type === "bug" ? <Bug size={12} /> : <Lightbulb size={12} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-foreground break-words" data-testid={`text-wish-title-${item.id}`}>
                    {item.title}
                  </p>
                  {item.description && (
                    <p className="text-[11px] text-muted-foreground mt-0.5 whitespace-pre-wrap break-words">{item.description}</p>
                  )}
                  {item.imageStorageKeys && item.imageStorageKeys.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2" data-testid={`images-wish-${item.id}`}>
                      {item.imageStorageKeys.map((_key, idx) => (
                        <a
                          key={idx}
                          href={`/api/wish-list/${item.id}/image/${idx}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block rounded-md overflow-hidden border border-slate-200 hover:border-slate-400 transition-colors"
                          data-testid={`link-wish-image-${item.id}-${idx}`}
                        >
                          <img
                            src={`/api/wish-list/${item.id}/image/${idx}`}
                            alt={`Attachment ${idx + 1}`}
                            className="h-16 w-16 object-cover"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                  <p className="text-[9px] text-slate-400 mt-1 uppercase tracking-wide">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <select
                  value={item.status}
                  onChange={(e) => onChangeStatus(item.id, e.target.value as WishListItemDto["status"])}
                  className={`text-[10px] font-bold uppercase tracking-wide rounded-md border px-2 py-1 ${WISH_STATUS_CLASS[item.status]}`}
                  data-testid={`select-wish-status-${item.id}`}
                >
                  {(Object.keys(WISH_STATUS_LABEL) as WishListItemDto["status"][]).map((s) => (
                    <option key={s} value={s}>
                      {WISH_STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDelete(item.id)}
                  className="h-7 w-7 text-slate-400 hover:text-rose-600"
                  data-testid={`button-wish-delete-${item.id}`}
                  title="Delete"
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplatesSection() {
  const previewUrl = "/api/settings/templates/certificat-paiement/preview";
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="mt-10">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h2
            className="text-[16px] font-black uppercase tracking-tight mb-1"
            style={{ color: "#0B2545" }}
            data-testid="text-templates-title"
          >
            Document Templates
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Live preview of the templates used to generate official PDFs. Sample data is shown — your branding (logos)
            from <em>Template Assets</em> above is applied automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((k) => k + 1)}
            data-testid="button-templates-refresh"
          >
            <RefreshCw size={14} className="mr-1.5" />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}
            data-testid="button-templates-open-tab"
          >
            <ExternalLink size={14} className="mr-1.5" />
            Open in new tab
          </Button>
        </div>
      </div>

      <LuxuryCard>
        <div className="flex items-start gap-3 mb-4">
          <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
            <FileText size={14} className="text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-[12px] font-bold text-foreground mb-0.5">Certificat de Paiement</h3>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Cover page + financial annex. The same HTML is sent to DocRaptor when you generate a real certificate.
            </p>
          </div>
        </div>

        <div
          className="rounded-lg border border-slate-200 overflow-hidden bg-slate-50"
          style={{ height: "1100px" }}
        >
          <iframe
            key={reloadKey}
            src={previewUrl}
            title="Certificat de Paiement preview"
            className="w-full h-full bg-white"
            data-testid="iframe-certificat-preview"
          />
        </div>
      </LuxuryCard>
    </div>
  );
}

function TemplateAssetsSection() {
  const { toast } = useToast();

  const { data: assets, isLoading } = useQuery<TemplateAsset[]>({
    queryKey: ["/api/settings/template-assets"],
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ assetType, file }: { assetType: string; file: File }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("assetType", assetType);
      const res = await fetch("/api/settings/template-assets/upload", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/template-assets"] });
      const slot = ASSET_SLOTS.find(s => s.assetType === variables.assetType);
      toast({ title: "Logo uploaded", description: `${slot?.label ?? "Asset"} has been saved` });
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/settings/template-assets/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/template-assets"] });
      toast({ title: "Logo removed" });
    },
    onError: (error: Error) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  return (
    <div className="mt-10">
      <div className="mb-6">
        <h2
          className="text-[16px] font-black uppercase tracking-tight mb-1"
          style={{ color: "#0B2545" }}
          data-testid="text-template-assets-title"
        >
          Template Assets
        </h2>
        <p className="text-[11px] text-muted-foreground mb-4">
          Upload logos used in generated Certificats de Paiement and other official documents
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ASSET_SLOTS.map((slot) => {
            const asset = assets?.find(a => a.assetType === slot.assetType);
            return (
              <TemplateAssetSlot
                key={slot.assetType}
                slot={slot}
                asset={asset}
                onUpload={(file) => uploadMutation.mutate({ assetType: slot.assetType, file })}
                onDelete={() => asset && deleteMutation.mutate(asset.id)}
                isUploading={uploadMutation.isPending && uploadMutation.variables?.assetType === slot.assetType}
                isDeleting={deleteMutation.isPending}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function TemplateAssetSlot({
  slot,
  asset,
  onUpload,
  onDelete,
  isUploading,
  isDeleting,
}: {
  slot: typeof ASSET_SLOTS[number];
  asset?: TemplateAsset;
  onUpload: (file: File) => void;
  onDelete: () => void;
  isUploading: boolean;
  isDeleting: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const SlotIcon = slot.icon;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUpload(file);
      e.target.value = "";
    }
  };

  return (
    <LuxuryCard data-testid={`card-template-asset-${slot.assetType}`}>
      <div className="flex items-start gap-3 mb-4">
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
          style={{ backgroundColor: "rgba(11, 37, 69, 0.08)" }}
        >
          <SlotIcon size={14} style={{ color: "#0B2545" }} />
        </div>
        <div>
          <h3 className="text-[12px] font-bold text-foreground mb-0.5">{slot.label}</h3>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            {slot.description}
          </p>
        </div>
      </div>

      {asset ? (
        <div className="space-y-3">
          <div
            className="rounded-md border border-[rgba(0,0,0,0.06)] dark:border-[rgba(255,255,255,0.06)] bg-[rgba(0,0,0,0.02)] dark:bg-[rgba(255,255,255,0.02)] p-4 flex items-center justify-center"
            style={{ minHeight: "80px" }}
          >
            <img
              src={`/api/template-assets/${slot.assetType}/file`}
              alt={slot.label}
              className="max-h-16 max-w-full object-contain"
              data-testid={`img-template-asset-${slot.assetType}`}
            />
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <TechnicalLabel>{asset.fileName}</TechnicalLabel>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                data-testid={`button-replace-${slot.assetType}`}
              >
                <Upload size={12} className="mr-1.5" />
                {isUploading ? "Uploading..." : "Replace"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onDelete}
                disabled={isDeleting}
                data-testid={`button-delete-${slot.assetType}`}
              >
                <Trash2 size={12} className="mr-1.5" />
                Remove
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div
          className="rounded-md border-2 border-dashed border-[rgba(0,0,0,0.1)] dark:border-[rgba(255,255,255,0.1)] p-6 flex flex-col items-center justify-center cursor-pointer transition-colors"
          onClick={() => fileInputRef.current?.click()}
          data-testid={`dropzone-${slot.assetType}`}
        >
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center mb-3"
            style={{ backgroundColor: "rgba(11, 37, 69, 0.06)" }}
          >
            <Image size={16} className="text-muted-foreground" />
          </div>
          <p className="text-[11px] font-medium text-foreground mb-1">
            {isUploading ? "Uploading..." : "Click to upload"}
          </p>
          <p className="text-[9px] text-muted-foreground">
            PNG, JPG or SVG recommended
          </p>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
        data-testid={`input-file-${slot.assetType}`}
      />
    </LuxuryCard>
  );
}
