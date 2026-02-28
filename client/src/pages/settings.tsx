import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Sidebar } from "@/components/layout/Sidebar";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Skeleton } from "@/components/ui/skeleton";
import { Zap, Sparkles, Crown, Gauge, DollarSign, Brain, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AiModelSetting } from "@shared/schema";

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
      </main>
    </div>
  );
}
