import { useQuery, useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Sidebar } from "@/components/layout/Sidebar";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Zap, Sparkles, Crown, Gauge, DollarSign, Brain, Check, Upload, Trash2, Image, Building2, Scale } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AiModelSetting, TemplateAsset } from "@shared/schema";

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
      </main>
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
