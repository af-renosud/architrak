import { useState, useCallback, useRef, useEffect } from "react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Receipt, FilePlus2, ListOrdered, Languages } from "lucide-react";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Plus, ChevronDown, ChevronRight, FileText, ArrowUpRight, ArrowDownRight, Upload, Loader2, ExternalLink, Check, Ban, AlertTriangle, Eye, EyeOff, ShieldCheck, ShieldAlert, ShieldX, Trash2, X, Tag, Settings as SettingsIcon, Wand2, Pencil, UserCog, Copy, Send, MessageSquare, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import { getDevisUploadErrorTitle } from "@shared/devis-upload-errors";
import { getInvoiceUploadErrorTitle } from "@shared/invoice-upload-errors";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient, ApiError } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertDevisLineItemSchema, insertAvenantSchema, insertLotSchema } from "@shared/schema";
import type { Devis, Contractor, Lot, LotCatalog, DevisLineItem, Avenant, Invoice, DevisRefEdit } from "@shared/schema";
import { formatLotDescription } from "@shared/lot-label";
import {
  composeDevisCode,
  tryParseDevisCode,
  validateDevisCodeParts,
  DEVIS_CODE_MAX_LOT_REF,
  DEVIS_CODE_MAX_DESCRIPTION,
} from "@shared/devis-code";
import { z } from "zod";
import { AdvisoriesList, AdvisoryBadge } from "@/components/advisories/AdvisoriesList";
import { DevisTranslationSection } from "@/components/devis/DevisTranslationSection";
import { PdfPopoutViewer } from "@/components/devis/PdfPopoutViewer";
import { ContractorSelect } from "@/components/ui/contractor-select";
import { TvaDerivedHint } from "@/components/ui/tva-derived-hint";
import {
  partitionDraftWarnings,
  focusContractorSelect,
  ContractorAdvisoryBanner,
  GenericValidationWarningsList,
  type DraftValidationWarning,
} from "@/components/devis/draft-warnings";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

export type LotCodeValue = {
  lotCatalogId: number | null;
  lotRefText: string;
  lotSequence: number | null;
  lotDescription: string;
};

type LotCodeUpdater = LotCodeValue | ((prev: LotCodeValue) => LotCodeValue);

interface LotCodeComposerProps {
  projectId: string;
  excludeDevisId?: number;
  value: LotCodeValue;
  /**
   * Accepts either a flat replacement or an updater fn (à la
   * `useState`). Async paths (next-number fetch, 409 re-suggest)
   * **must** use the updater form so they merge against the latest
   * state instead of clobbering edits the user made while the request
   * was in flight.
   */
  onChange: (next: LotCodeUpdater) => void;
  /** Suggested next sequence to honour (e.g. after a 409). */
  forcedNextLotSequence?: number | null;
  testIdPrefix?: string;
}

/**
 * Three-part composer for the structured devis-code (Task #176).
 *
 * The architect either picks a lot from the firm-wide catalog or toggles
 * "Custom" to type a free-text reference. Either way, when the lot ref
 * settles we ask the server for the next available sequence number for
 * `(projectId, lotRef)` and pre-fill it. The composed string
 * `{LOTREF}.{N}.{description}` is rendered live so reviewers see exactly
 * what will be persisted into `devisCode`.
 *
 * Catalog-vs-custom detection on the way IN: if the initial value's
 * `lotRefText` matches a catalog entry case-insensitively we surface the
 * catalog ID so the dropdown shows the picked entry; otherwise we drop
 * into custom mode.
 */
function LotCodeComposer({ projectId, excludeDevisId, value, onChange, forcedNextLotSequence = null, testIdPrefix = "lot-code" }: LotCodeComposerProps) {
  // Server's most recently advertised next-available sequence, scoped to a
  // specific lot ref. We track the ref alongside the number so a stale
  // suggestion for a previous lot can never be mistakenly displayed against
  // the current one. Cleared whenever the lot ref changes.
  const [suggestion, setSuggestion] = useState<{ lotRef: string; nextLotSequence: number } | null>(null);
  const { data: catalog = [] } = useQuery<LotCatalog[]>({
    queryKey: ["/api/lot-catalog"],
  });
  const sortedCatalog = [...catalog].sort((a, b) =>
    (a.code ?? "").localeCompare(b.code ?? "", undefined, { numeric: true, sensitivity: "base" }),
  );

  const matchedCatalogId = (() => {
    if (value.lotCatalogId != null) return value.lotCatalogId;
    if (!value.lotRefText) return null;
    const hit = catalog.find((c) => (c.code ?? "").toLowerCase() === value.lotRefText.toLowerCase());
    return hit?.id ?? null;
  })();
  const [customMode, setCustomMode] = useState<boolean>(() => {
    if (value.lotRefText && matchedCatalogId == null) return true;
    return false;
  });

  // Once the catalog query resolves we may discover the initial lotRefText
  // actually matches a catalog entry — flip out of custom mode in that case
  // (one-shot per catalog change).
  useEffect(() => {
    if (catalog.length === 0) return;
    if (value.lotRefText && customMode) {
      const hit = catalog.find((c) => (c.code ?? "").toLowerCase() === value.lotRefText.toLowerCase());
      if (hit) {
        setCustomMode(false);
        onChange((prev) => ({ ...prev, lotCatalogId: hit.id, lotRefText: hit.code }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.length]);

  const fetchNext = useCallback(async (lotRef: string) => {
    if (!lotRef.trim()) return;
    const params = new URLSearchParams({ lotRef });
    if (excludeDevisId) params.set("excludeDevisId", String(excludeDevisId));
    const res = await fetch(`/api/projects/${projectId}/devis/next-lot-number?${params}`, { credentials: "include" });
    if (!res.ok) return;
    const body: { nextLotSequence: number } = await res.json();
    const refKey = lotRef.trim().toUpperCase();
    // Cache the suggestion (keyed by ref) so the hint can be rendered
    // even after the user manually overrides the value, and the
    // "Reset to next" link knows what to restore.
    setSuggestion({ lotRef: refKey, nextLotSequence: body.nextLotSequence });
    // Functional update so we merge against the latest state — by the
    // time this resolves the user may have changed the description or
    // toggled the catalog selection, and a flat replace would clobber
    // those edits (notably `lotCatalogId`).
    onChange((prev) => {
      // Don't override a sequence the user typed manually while we were
      // fetching, and don't write a stale sequence onto a lot ref that
      // has since changed.
      if (prev.lotRefText.trim().toUpperCase() !== refKey) return prev;
      if (prev.lotSequence != null) return prev;
      return { ...prev, lotSequence: body.nextLotSequence };
    });
  }, [projectId, excludeDevisId, onChange]);

  // Auto-suggest the next sequence whenever a lot ref is supplied without
  // a sequence — covers the AI-prefilled draft-review case where the
  // lotRefText comes from the extraction (no user click on the catalog
  // dropdown / no blur on the custom input). The `autoFetchedRef` guard
  // ensures we issue the suggestion fetch exactly once per (lotRef)
  // change so manual overrides aren't clobbered.
  const autoFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    const ref = value.lotRefText.trim();
    if (!ref) {
      autoFetchedRef.current = null;
      return;
    }
    if (value.lotSequence != null) return;
    if (autoFetchedRef.current === ref.toUpperCase()) return;
    autoFetchedRef.current = ref.toUpperCase();
    void fetchNext(ref);
  }, [value.lotRefText, value.lotSequence, fetchNext]);

  // Honour a server-suggested next sequence (e.g. after a 409 collision
  // the parent re-suggests via `forcedNextLotSequence`). Reuses the same
  // auto-fetch debouncing key so this counts as a fresh suggestion.
  useEffect(() => {
    if (forcedNextLotSequence == null) return;
    const refKey = value.lotRefText.trim().toUpperCase();
    onChange((prev) => ({ ...prev, lotSequence: forcedNextLotSequence }));
    autoFetchedRef.current = refKey || null;
    if (refKey) setSuggestion({ lotRef: refKey, nextLotSequence: forcedNextLotSequence });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forcedNextLotSequence]);

  const handleCatalogPick = (idStr: string) => {
    const id = Number(idStr);
    const entry = catalog.find((c) => c.id === id);
    if (!entry) return;
    // Reset the sequence so the auto-fetch effect re-runs against the
    // newly-picked lot — the in-flight fetch (if any) for the previous
    // lot is skipped via the `lotRefText` mismatch guard in `fetchNext`.
    onChange((prev) => ({ ...prev, lotCatalogId: id, lotRefText: entry.code, lotSequence: null }));
  };

  const handleToggleCustom = () => {
    const goingCustom = !customMode;
    setCustomMode(goingCustom);
    if (goingCustom) {
      onChange((prev) => ({ ...prev, lotCatalogId: null }));
    } else {
      onChange((prev) => ({ ...prev, lotCatalogId: null, lotRefText: "", lotSequence: null }));
    }
  };

  const handleCustomBlur = () => {
    if (customMode && value.lotRefText.trim()) {
      void fetchNext(value.lotRefText.trim());
    }
  };

  const errors = validateDevisCodeParts({
    lotRef: value.lotRefText,
    lotSequence: value.lotSequence ?? undefined,
    description: value.lotDescription,
  });
  const errorByField = (field: "lotRef" | "lotSequence" | "description") =>
    errors.find((e) => e.field === field)?.message;

  const previewReady = errors.length === 0;
  const preview = previewReady
    ? composeDevisCode({
        lotRef: value.lotRefText,
        lotSequence: value.lotSequence as number,
        description: value.lotDescription,
      })
    : "—";

  return (
    <div className="space-y-2 rounded border border-border/60 bg-muted/20 p-2.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <TechnicalLabel>Devis Code (structured)</TechnicalLabel>
        <button
          type="button"
          className="text-[9px] uppercase tracking-widest text-muted-foreground hover:text-foreground underline"
          onClick={handleToggleCustom}
          data-testid={`${testIdPrefix}-toggle-custom`}
        >
          {customMode ? "Pick from catalog" : "Use custom reference"}
        </button>
      </div>
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
        <div className="space-y-1">
          <span className="text-[9px] uppercase tracking-widest text-muted-foreground">Lot</span>
          {customMode ? (
            <Input
              value={value.lotRefText}
              onChange={(e) => {
                const v = e.target.value.slice(0, DEVIS_CODE_MAX_LOT_REF);
                // Reset sequence so the auto-fetch effect picks the
                // suggestion for the newly-typed lot ref.
                onChange((prev) => ({ ...prev, lotRefText: v, lotSequence: null }));
              }}
              onBlur={handleCustomBlur}
              placeholder="e.g. FD"
              maxLength={DEVIS_CODE_MAX_LOT_REF}
              className="text-[11px] uppercase"
              data-testid="select-lot-ref"
            />
          ) : (
            <Select
              value={matchedCatalogId != null ? String(matchedCatalogId) : ""}
              onValueChange={handleCatalogPick}
            >
              <SelectTrigger className="text-[11px]" data-testid="select-lot-ref">
                <SelectValue placeholder="Select lot…" />
              </SelectTrigger>
              <SelectContent>
                {sortedCatalog.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)} className="text-[11px]">
                    <span className="font-mono font-bold">{c.code}</span>
                    <span className="text-muted-foreground"> · {formatLotDescription(c) || ""}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {errorByField("lotRef") && (
            <p className="text-[9px] text-rose-600" data-testid={`${testIdPrefix}-error-lot-ref`}>{errorByField("lotRef")}</p>
          )}
        </div>
        <div className="space-y-1">
          <span className="text-[9px] uppercase tracking-widest text-muted-foreground">Number</span>
          <Input
            type="number"
            min={1}
            value={value.lotSequence ?? ""}
            onChange={(e) => {
              const n = e.target.value === "" ? null : Number(e.target.value);
              onChange((prev) => ({ ...prev, lotSequence: n }));
            }}
            placeholder="auto"
            className="text-[11px]"
            title={
              suggestion && suggestion.lotRef === value.lotRefText.trim().toUpperCase()
                ? `Server suggested next free number: ${suggestion.nextLotSequence}`
                : undefined
            }
            data-testid="input-lot-number"
          />
          {(() => {
            // Only render the hint when the cached suggestion is for the
            // *current* lot ref — otherwise we'd be showing a stale number
            // for a different lot.
            if (!suggestion) return null;
            if (suggestion.lotRef !== value.lotRefText.trim().toUpperCase()) return null;
            const matches = value.lotSequence === suggestion.nextLotSequence;
            if (matches) {
              return (
                <p
                  className="text-[9px] text-muted-foreground"
                  data-testid={`${testIdPrefix}-next-hint`}
                >
                  next free: <span className="font-mono">{suggestion.nextLotSequence}</span>
                </p>
              );
            }
            return (
              <p className="text-[9px] text-muted-foreground">
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => {
                    onChange((prev) => ({ ...prev, lotSequence: suggestion.nextLotSequence }));
                  }}
                  data-testid={`${testIdPrefix}-reset-to-next`}
                >
                  Reset to next: <span className="font-mono">{suggestion.nextLotSequence}</span>
                </button>
              </p>
            );
          })()}
          {errorByField("lotSequence") && (
            <p className="text-[9px] text-rose-600" data-testid={`${testIdPrefix}-error-lot-number`}>{errorByField("lotSequence")}</p>
          )}
        </div>
      </div>
      <div className="space-y-1">
        <span className="text-[9px] uppercase tracking-widest text-muted-foreground">Description</span>
        <Input
          value={value.lotDescription}
          onChange={(e) => {
            const v = e.target.value.slice(0, DEVIS_CODE_MAX_DESCRIPTION);
            onChange((prev) => ({ ...prev, lotDescription: v }));
          }}
          placeholder="e.g. HOUSE FACADE"
          maxLength={DEVIS_CODE_MAX_DESCRIPTION}
          className="text-[11px]"
          data-testid="input-lot-description"
        />
        {errorByField("description") && (
          <p className="text-[9px] text-rose-600" data-testid={`${testIdPrefix}-error-description`}>{errorByField("description")}</p>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2 border-t border-border/40 pt-1.5">
        <span className="text-[9px] uppercase tracking-widest text-muted-foreground">Preview</span>
        <span
          className={`text-[11px] font-mono ${previewReady ? "text-foreground font-semibold" : "text-muted-foreground italic"}`}
          data-testid="text-devis-code-preview"
        >
          {preview}
        </span>
      </div>
    </div>
  );
}

/** True when every part of a `LotCodeValue` is filled and well-formed. */
function isLotCodeValueComplete(v: LotCodeValue): v is LotCodeValue & { lotSequence: number } {
  return (
    !!v.lotRefText.trim() &&
    typeof v.lotSequence === "number" &&
    v.lotSequence >= 1 &&
    !!v.lotDescription.trim() &&
    validateDevisCodeParts({
      lotRef: v.lotRefText,
      lotSequence: v.lotSequence,
      description: v.lotDescription,
    }).length === 0
  );
}

/**
 * Build a `LotCodeValue` from an existing devis row.
 *
 * Reads ONLY the structured columns — legacy free-text `devisCode` values
 * are intentionally NOT reverse-parsed (Task #176 explicitly excludes
 * automated backfill). Legacy rows surface as an empty composer that the
 * architect must fill in deliberately, which then writes the structured
 * columns going forward.
 *
 * For freshly-created structured rows we also pull the description out
 * of `devisCode` (the third dot-segment) so the editor renders the
 * persisted text rather than a blank field.
 */
function lotCodeValueFromDevis(d: Pick<Devis, "devisCode" | "lotCatalogId" | "lotRefText" | "lotSequence">): LotCodeValue {
  if (d.lotRefText && d.lotSequence) {
    const parsed = tryParseDevisCode(d.devisCode);
    return {
      lotCatalogId: d.lotCatalogId ?? null,
      lotRefText: d.lotRefText,
      lotSequence: d.lotSequence,
      lotDescription: parsed?.description ?? "",
    };
  }
  return { lotCatalogId: null, lotRefText: "", lotSequence: null, lotDescription: "" };
}

const avenantFormSchema = insertAvenantSchema.extend({
  descriptionFr: z.string().min(1, "Description is required"),
  amountHt: z.string().min(1, "Required"),
  amountTtc: z.string().min(1, "Required"),
});

const lineItemFormSchema = insertDevisLineItemSchema.extend({
  description: z.string().min(1, "Required"),
  quantity: z.string().min(1, "Required"),
  unitPriceHt: z.string().min(1, "Required"),
  totalHt: z.string().min(1, "Required"),
});

function InvoiceUploadDialog({
  devisId,
  projectId,
  open,
  onOpenChange,
}: {
  devisId: number;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/devis/${devisId}/invoices/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        const e = new Error(err.message || "Upload failed") as Error & { code?: string };
        e.code = err.code;
        throw e;
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "invoices"] });
      onOpenChange(false);
      const ext = data.extraction;
      if (ext.confidence === "low") {
        toast({ title: "Invoice uploaded — review needed", description: `${data.fileName} — amounts could not be extracted automatically. Please check the invoice record.`, variant: "destructive" });
      } else {
        toast({ title: "Invoice uploaded successfully", description: `${data.fileName} — ${formatCurrency(ext.amountHt)} HT detected` });
      }
    },
    onError: (error: Error & { code?: string }) => {
      const title = getInvoiceUploadErrorTitle(error.code);
      toast({ title, description: error.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!uploadMutation.isPending) onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-black uppercase tracking-tight">Upload Invoice PDF</DialogTitle>
          <DialogDescription className="text-[11px]">Upload the contractor's invoice document. The system will extract amounts and details automatically.</DialogDescription>
        </DialogHeader>
        {uploadMutation.isPending ? (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-[#0B2545]" />
            <p className="text-[11px] text-muted-foreground text-center">Processing PDF... Extracting invoice details</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div
              className="border-2 border-dashed border-[#c1a27b]/40 rounded-2xl p-8 text-center cursor-pointer hover:border-[#c1a27b] hover:bg-[#c1a27b]/5 transition-all"
              onClick={() => fileRef.current?.click()}
              data-testid={`dropzone-invoice-upload-${devisId}`}
            >
              <Upload className="h-8 w-8 mx-auto mb-2 text-[#c1a27b]" />
              <p className="text-[12px] font-semibold text-foreground">Click to select invoice PDF</p>
              <p className="text-[10px] text-muted-foreground mt-1">PDF files only — the AI will extract invoice number, amounts, and date</p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadMutation.mutate(file);
                e.target.value = "";
              }}
              data-testid={`input-invoice-file-${devisId}`}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AvenantDialog({
  devisId,
  projectId,
  open,
  onOpenChange,
}: {
  devisId: number;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const form = useForm<z.infer<typeof avenantFormSchema>>({
    resolver: zodResolver(avenantFormSchema),
    defaultValues: {
      devisId,
      avenantNumber: "",
      type: "pv",
      descriptionFr: "",
      descriptionUk: null,
      amountHt: "0.00",
      amountTtc: "0.00",
      dateSigned: null,
      status: "draft",
      pvmvRef: null,
    },
  });

  const defaultAvenantValues = {
    devisId,
    avenantNumber: "",
    type: "pv" as const,
    descriptionFr: "",
    descriptionUk: null,
    amountHt: "0.00",
    amountTtc: "0.00",
    dateSigned: null,
    status: "draft" as const,
    pvmvRef: null,
  };

  useEffect(() => {
    if (open) {
      form.reset(defaultAvenantValues);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const createMutation = useMutation({
    mutationFn: async (data: z.infer<typeof avenantFormSchema>) => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/avenants`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "avenants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      onOpenChange(false);
      form.reset(defaultAvenantValues);
      toast({ title: "Avenant created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-black uppercase tracking-tight">New Avenant</DialogTitle>
          <DialogDescription className="text-[11px]">Add a plus-value or moins-value variation</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((d) => createMutation.mutate(d))} className="space-y-4">
            <FormField control={form.control} name="type" render={({ field }) => (
              <FormItem>
                <FormLabel><TechnicalLabel>Type</TechnicalLabel></FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger data-testid="select-avenant-type"><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="pv">Plus-value (PV)</SelectItem>
                    <SelectItem value="mv">Moins-value (MV)</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="descriptionFr" render={({ field }) => (
              <FormItem>
                <FormLabel><TechnicalLabel>Description</TechnicalLabel></FormLabel>
                <FormControl><Textarea {...field} className="resize-none" data-testid="input-avenant-desc" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="amountHt" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Amount HT</TechnicalLabel></FormLabel>
                  <FormControl><Input {...field} type="number" step="0.01" data-testid="input-avenant-ht" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="amountTtc" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Amount TTC</TechnicalLabel></FormLabel>
                  <FormControl><Input {...field} type="number" step="0.01" data-testid="input-avenant-ttc" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <TvaDerivedHint
              amountHt={form.watch("amountHt")}
              amountTtc={form.watch("amountTtc")}
              testId="text-avenant-tva-derived"
            />
            <Button type="submit" className="w-full" disabled={createMutation.isPending} data-testid="button-submit-avenant">
              <span className="text-[9px] font-bold uppercase tracking-widest">
                {createMutation.isPending ? "Creating..." : "Create Avenant"}
              </span>
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

interface DevisRowProps {
  d: Devis;
  projectId: string;
  contractors: Contractor[];
  lots: Lot[];
  isArchived: boolean;
  expanded: boolean;
  openChecks: number;
  onToggle: () => void;
  onEditRefs: (d: Devis) => void;
  onReviewDraft: (d: Devis) => void;
}

function DevisRow({ d, projectId, contractors, lots, isArchived, expanded, openChecks, onToggle, onEditRefs, onReviewDraft }: DevisRowProps) {
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [avenantOpen, setAvenantOpen] = useState(false);
  const [pdfPopoutOpen, setPdfPopoutOpen] = useState(false);
  const isVoid = d.status === "void";
  const hasPdf = !!d.pdfStorageKey;

  return (
    <div>
      <LuxuryCard
        data-testid={`card-devis-${d.id}`}
        className={
          expanded
            ? "border-2 border-[#0B2545]/40 dark:border-[#0B2545]/60 shadow-[0_2px_8px_rgba(11,37,69,0.08)] transition-[border-color,box-shadow] duration-150"
            : "transition-[border-color,box-shadow] duration-150"
        }
      >
        <div
          className={`flex items-center justify-between gap-3 flex-wrap cursor-pointer ${isVoid ? "opacity-50" : ""}`}
          onClick={onToggle}
          data-testid={`row-devis-toggle-${d.id}`}
        >
          <div className="flex items-center gap-3 flex-wrap min-w-0 flex-1">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[16px] font-black text-[#0B2545] tracking-tight" data-testid={`text-devis-code-${d.id}`}>{d.devisCode}</span>
                {d.devisNumber && <span className="text-[11px] text-muted-foreground" data-testid={`text-devis-number-${d.id}`}>N° {d.devisNumber}</span>}
                {d.ref2 && <span className="text-[11px] text-muted-foreground" data-testid={`text-devis-ref2-${d.id}`}>Ref {d.ref2}</span>}
                {!isVoid && !isArchived && (
                  <button
                    type="button"
                    className="p-0.5 text-muted-foreground hover:text-[#0B2545] transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditRefs(d);
                    }}
                    title="Edit contractor, devis code & references"
                    data-testid={`button-edit-devis-refs-${d.id}`}
                  >
                    <Pencil size={11} />
                  </button>
                )}
              </div>
              <p className="text-[12px] text-foreground mt-0.5 truncate">{d.descriptionFr}</p>
              <span className="text-[10px] text-muted-foreground">
                {contractors.find((c) => c.id === d.contractorId)?.name ?? `#${d.contractorId}`}
              </span>
            </div>
          </div>
          <TooltipProvider delayDuration={200}>
            <div className="flex items-center gap-3 flex-wrap justify-end">
              {/* Compact toolbar: status + mode + advisory + actions, with hairline dividers */}
              <div className="flex items-center gap-2 min-[900px]:gap-2.5">
                <StatusBadge status={d.status} />

                <span className="hidden min-[900px]:block h-4 w-px bg-border" aria-hidden />

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className="hidden min-[900px]:flex items-center gap-1.5 cursor-help"
                      data-testid={`badge-invoicing-mode-${d.id}`}
                    >
                      <TechnicalLabel>Mode</TechnicalLabel>
                      <span className="text-[11px] font-semibold text-foreground">
                        {d.invoicingMode === "mode_a" ? "A" : "B"}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[280px] text-[11px] leading-snug">
                    {d.invoicingMode === "mode_a" ? (
                      <>
                        <span className="font-semibold">Mode A — Tick-off</span>
                        <br />
                        Each line item is billed in full once it's marked
                        complete. Use this when work is delivered as discrete
                        units (e.g. fixed deliverables).
                      </>
                    ) : (
                      <>
                        <span className="font-semibold">Mode B — % completion</span>
                        <br />
                        Each line is billed by the percentage of work done so
                        far (line total × % complete). Use this for ongoing
                        work measured progressively (e.g. m², m³, hours).
                      </>
                    )}
                  </TooltipContent>
                </Tooltip>

                <span className="hidden min-[900px]:block h-4 w-px bg-border empty:hidden" aria-hidden />

                <div className="empty:hidden">
                  <AdvisoryBadge subject={{ type: "devis", id: d.id }} />
                </div>

                {openChecks > 0 ? (
                  <span
                    className="px-2 py-0.5 rounded-full bg-amber-500 text-white text-[9px] font-bold uppercase tracking-widest"
                    title={`${openChecks} question(s) en cours avec l'entreprise`}
                    data-testid={`badge-checking-${d.id}`}
                  >
                    Checking · {openChecks}
                  </span>
                ) : null}

                <span className="hidden min-[900px]:block h-4 w-px bg-border" aria-hidden />

                {/* Icon-only action cluster */}
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 border-[#0B2545]/20 text-[#0B2545] hover:bg-[#0B2545]/5"
                          disabled={!hasPdf}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (hasPdf) setPdfPopoutOpen(true);
                          }}
                          data-testid={`button-view-pdf-${d.id}`}
                          aria-label="View PDF"
                        >
                          <FileText size={13} />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-[10px]">
                      {hasPdf ? "View PDF" : "No PDF on file"}
                    </TooltipContent>
                  </Tooltip>
                  {!isVoid ? (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            disabled={isArchived}
                            onClick={(e) => {
                              e.stopPropagation();
                              setInvoiceOpen(true);
                            }}
                            data-testid={`button-quick-upload-invoice-${d.id}`}
                            aria-label="Téléverser une facture"
                          >
                            <Receipt size={13} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-[10px]">Téléverser une facture</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            disabled={isArchived}
                            onClick={(e) => {
                              e.stopPropagation();
                              setAvenantOpen(true);
                            }}
                            data-testid={`button-quick-add-avenant-${d.id}`}
                            aria-label="Ajouter un avenant"
                          >
                            <FilePlus2 size={13} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-[10px]">Ajouter un avenant</TooltipContent>
                      </Tooltip>
                    </>
                  ) : null}
                  {d.status === "draft" ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => {
                            e.stopPropagation();
                            onReviewDraft(d);
                          }}
                          disabled={isArchived}
                          data-testid={`button-review-draft-${d.id}`}
                          aria-label="Review draft"
                        >
                          <ShieldAlert size={13} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-[10px]">Review draft</TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              </div>

              {/* Slot: Totals — anchored hard right with navy left rule */}
              <div className="pl-4 border-l-2 border-[#0B2545]/20 min-w-[10rem] text-right tabular-nums">
                <div className="text-[18px] font-black tracking-tight leading-none text-[#0B2545]" data-testid={`text-devis-ttc-${d.id}`}>
                  {formatCurrency(parseFloat(d.amountTtc))}
                </div>
                <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mt-1">TTC</p>
                <span className="text-[10px] text-muted-foreground" data-testid={`text-devis-ht-${d.id}`}>
                  {formatCurrency(parseFloat(d.amountHt))} HT
                </span>
              </div>
            </div>
          </TooltipProvider>
        </div>
      </LuxuryCard>

      {expanded && (
        <DevisDetailInline
          devis={d}
          projectId={projectId}
          contractors={contractors}
          lots={lots}
          isArchived={isArchived}
          onOpenInvoiceUpload={() => setInvoiceOpen(true)}
          onOpenAvenantDialog={() => setAvenantOpen(true)}
          onOpenPdfPopout={() => {
            if (hasPdf) setPdfPopoutOpen(true);
          }}
          hasPdf={hasPdf}
        />
      )}

      <InvoiceUploadDialog devisId={d.id} projectId={projectId} open={invoiceOpen} onOpenChange={setInvoiceOpen} />
      <AvenantDialog devisId={d.id} projectId={projectId} open={avenantOpen} onOpenChange={setAvenantOpen} />
      {pdfPopoutOpen && (
        <PdfPopoutViewer
          devisId={d.id}
          devisCode={d.devisCode}
          hasOriginal={hasPdf}
          onClose={() => setPdfPopoutOpen(false)}
        />
      )}
    </div>
  );
}

interface DevisTabProps {
  projectId: string;
  contractors: Contractor[];
  lots: Lot[];
  isArchived?: boolean;
  initialExpandedDevisId?: number | null;
  initialFocusedCheckId?: number | null;
}

export function DevisTab({
  projectId,
  contractors,
  lots,
  isArchived = false,
  initialExpandedDevisId = null,
  initialFocusedCheckId = null,
}: DevisTabProps) {
  const { toast } = useToast();
  const [expandedDevis, setExpandedDevis] = useState<number | null>(initialExpandedDevisId);

  useEffect(() => {
    if (initialExpandedDevisId) setExpandedDevis(initialExpandedDevisId);
  }, [initialExpandedDevisId]);

  useEffect(() => {
    if (!initialFocusedCheckId) return;
    let cancelled = false;
    let attempts = 0;
    const tryScroll = () => {
      if (cancelled) return;
      const el = document.querySelector(
        `[data-testid="check-${initialFocusedCheckId}"]`,
      );
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        (el as HTMLElement).classList.add("ring-2", "ring-amber-400");
        window.setTimeout(() => {
          (el as HTMLElement).classList.remove("ring-2", "ring-amber-400");
        }, 2500);
        return;
      }
      attempts += 1;
      if (attempts < 25) window.setTimeout(tryScroll, 200);
    };
    tryScroll();
    return () => {
      cancelled = true;
    };
  }, [initialFocusedCheckId, initialExpandedDevisId]);
  const [uploading, setUploading] = useState(false);
  const [showVoid, setShowVoid] = useState(false);
  const [draftReviewData, setDraftReviewData] = useState<{
    devisId: number;
    extraction: any;
    validation: any;
    devis: any;
  } | null>(null);
  const [editRefsFor, setEditRefsFor] = useState<Devis | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: devisList, isLoading } = useQuery<Devis[]>({
    queryKey: ["/api/projects", projectId, "devis"],
  });
  const { data: openChecksByDevis = {} } = useQuery<Record<number, number>>({
    queryKey: ["/api/projects", projectId, "devis-checks", "open-counts"],
  });

  const voidCount = devisList?.filter(d => d.status === "void").length ?? 0;

  // Devis list filters (Task #176): lot multi-select + free-text search.
  // Lot options come from the structured `lotRefText` column on currently
  // visible (non-void unless toggled) devis — we don't surface lots that
  // have no visible rows. Search matches devisCode, descriptionFr,
  // contractor name, and amounts (HT/TTC, both raw and FR-formatted).
  const [selectedLots, setSelectedLots] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const contractorById = new Map<number, Contractor>(contractors.map((c) => [c.id, c]));
  const visibleBeforeFilters = showVoid ? (devisList ?? []) : (devisList ?? []).filter(d => d.status !== "void");
  // Build the lot filter options + tag each one as catalog vs custom
  // (custom = free-text). A lot is considered catalog-backed if at least
  // one currently-visible devis with that ref carries a `lotCatalogId`.
  // Free-text lots are intentionally NOT promoted to the master list
  // (per spec) — but the filter still surfaces them so they're filterable.
  const lotOriginByRef = new Map<string, "catalog" | "custom">();
  for (const d of visibleBeforeFilters) {
    const ref = (d.lotRefText ?? "").toUpperCase().trim();
    if (!ref) continue;
    const current = lotOriginByRef.get(ref);
    if (d.lotCatalogId != null) {
      lotOriginByRef.set(ref, "catalog");
    } else if (current == null) {
      lotOriginByRef.set(ref, "custom");
    }
  }
  const lotOptions = Array.from(lotOriginByRef.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );

  const matchesSearch = (d: Devis): boolean => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const haystacks: string[] = [
      d.devisCode ?? "",
      d.descriptionFr ?? "",
      d.devisNumber ?? "",
      contractorById.get(d.contractorId)?.name ?? "",
      d.amountHt ?? "",
      d.amountTtc ?? "",
    ];
    const ht = parseFloat(d.amountHt ?? "");
    const ttc = parseFloat(d.amountTtc ?? "");
    if (Number.isFinite(ht)) {
      haystacks.push(new Intl.NumberFormat("fr-FR").format(ht));
      haystacks.push(String(Math.round(ht)));
    }
    if (Number.isFinite(ttc)) {
      haystacks.push(new Intl.NumberFormat("fr-FR").format(ttc));
      haystacks.push(String(Math.round(ttc)));
    }
    const normalisedQ = q.replace(/\s+/g, "");
    return haystacks.some((h) => {
      const lower = h.toLowerCase();
      if (lower.includes(q)) return true;
      // Allow numeric search to match across NBSP / regular-space FR formatting.
      const compact = lower.replace(/\s|\u00a0/g, "");
      return compact.includes(normalisedQ);
    });
  };

  const filteredDevisList = visibleBeforeFilters.filter((d) => {
    if (selectedLots.length > 0) {
      const lr = (d.lotRefText ?? "").toUpperCase();
      if (!selectedLots.includes(lr)) return false;
    }
    if (!matchesSearch(d)) return false;
    return true;
  });
  const hiddenByFilterCount = visibleBeforeFilters.length - filteredDevisList.length;
  const filtersActive = selectedLots.length > 0 || searchQuery.trim().length > 0;

  const toggleLotFilter = (lot: string) => {
    setSelectedLots((prev) => (prev.includes(lot) ? prev.filter((l) => l !== lot) : [...prev, lot]));
  };
  const clearFilters = () => {
    setSelectedLots([]);
    setSearchQuery("");
  };

  const activeDevis = devisList?.filter(d => d.status !== "void") ?? [];
  const totalDevisCount = activeDevis.length;
  const totalAmountTtc = activeDevis.reduce((sum, d) => sum + parseFloat(d.amountTtc?.toString() ?? "0"), 0);
  const totalAmountHt = activeDevis.reduce((sum, d) => sum + parseFloat(d.amountHt?.toString() ?? "0"), 0);
  const pendingDevisCount = activeDevis.filter(d => d.signOffStage !== "signed").length;
  const signedDevisCount = activeDevis.filter(d => d.signOffStage === "signed").length;

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/devis/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        const e = new Error(err.message || "Upload failed") as Error & {
          status?: number;
          code?: string;
          extraction?: { contractorName?: string | null };
        };
        e.status = res.status;
        e.code = err.code;
        e.extraction = err.extraction;
        throw e;
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      setUploading(false);
      if (data.devis?.status === "draft" && data.validation) {
        setDraftReviewData({
          devisId: data.devis.id,
          extraction: data.extraction,
          validation: data.validation,
          devis: data.devis,
        });
      } else {
        const ext = data.extraction;
        const matchInfo = ext.matchConfidence > 0
          ? ` • Matched: ${ext.contractorName} (${Math.round(ext.matchConfidence)}%)`
          : "";
        toast({
          title: "Devis created from PDF",
          description: `${ext.documentType || "document"} — ${formatCurrency(parseFloat(data.devis.amountHt))} HT${matchInfo}${ext.lineItemsCreated > 0 ? ` • ${ext.lineItemsCreated} line items` : ""}`,
        });
      }
    },
    onError: (error: Error & { status?: number; code?: string; extraction?: { contractorName?: string | null } }) => {
      const msg = error.message || "";
      const title = getDevisUploadErrorTitle(error.code);
      toast({ title, description: msg, variant: "destructive" });
      setUploading(false);
    },
  });

  const handleFileSelect = useCallback((file: File) => {
    if (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) {
      toast({ title: "Invalid file", description: "Please upload a PDF file", variant: "destructive" });
      return;
    }
    setUploading(true);
    uploadMutation.mutate(file);
  }, [uploadMutation, toast]);


  if (isLoading) {
    return <LuxuryCard><Skeleton className="h-40 w-full" /></LuxuryCard>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <LuxuryCard data-testid="card-devis-count">
          <TechnicalLabel>Total Devis</TechnicalLabel>
          <p className="text-[20px] font-light text-foreground mt-1" data-testid="text-devis-count">{totalDevisCount}</p>
        </LuxuryCard>
        <LuxuryCard data-testid="card-devis-total">
          <TechnicalLabel>Total Amount</TechnicalLabel>
          <p className="text-[16px] font-semibold text-foreground mt-1">{formatCurrency(totalAmountTtc)} <span className="text-[9px] text-muted-foreground">TTC</span></p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(totalAmountHt)} HT</p>
        </LuxuryCard>
        <LuxuryCard data-testid="card-devis-pending">
          <TechnicalLabel>Pending</TechnicalLabel>
          <p className="text-[20px] font-light text-amber-600 mt-1" data-testid="text-devis-pending">{pendingDevisCount}</p>
        </LuxuryCard>
        <LuxuryCard data-testid="card-devis-signed">
          <TechnicalLabel>Signed</TechnicalLabel>
          <p className="text-[20px] font-light text-emerald-600 mt-1" data-testid="text-devis-signed">{signedDevisCount}</p>
        </LuxuryCard>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {uploading ? (
            <Button variant="outline" size="sm" className="h-7 text-[10px] px-3 gap-1.5" disabled data-testid="button-upload-devis">
              <Loader2 size={12} className="animate-spin" />
              Processing...
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px] px-3 gap-1.5"
              onClick={() => fileInputRef.current?.click()}
              disabled={isArchived}
              data-testid="button-upload-devis"
            >
              <Upload size={12} />
              Upload Devis
            </Button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileSelect(file);
              if (e.target) e.target.value = "";
            }}
            data-testid="input-devis-pdf"
          />
        </div>
        {voidCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-3 gap-1.5"
            onClick={() => setShowVoid(!showVoid)}
            data-testid="button-toggle-void"
          >
            {showVoid ? <EyeOff size={12} /> : <Eye size={12} />}
            {showVoid ? "Hide" : "Show"} Void [{voidCount}]
          </Button>
        )}
      </div>

      {(lotOptions.length > 0 || filtersActive || (visibleBeforeFilters.length > 0)) && (
        <div className="flex items-center gap-2 flex-wrap" data-testid="row-devis-filters">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search devis (code, description, contractor, amount)…"
            className="h-7 text-[11px] flex-1 min-w-[200px]"
            data-testid="input-search-devis"
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[10px] px-3 gap-1.5"
                data-testid="select-filter-lot"
              >
                <Tag size={12} />
                {selectedLots.length === 0 ? "All lots" : `Lots · ${selectedLots.length}`}
                <ChevronDown size={12} />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-2" align="end">
              {lotOptions.length === 0 ? (
                <p className="text-[10px] text-muted-foreground italic px-1 py-2">No lots in this project yet.</p>
              ) : (
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {lotOptions.map((lot) => {
                    const checked = selectedLots.includes(lot);
                    const origin = lotOriginByRef.get(lot) ?? "custom";
                    return (
                      <label
                        key={lot}
                        className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-muted/60 text-[11px]"
                        data-testid={`option-filter-lot-${lot}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleLotFilter(lot)}
                          className="h-3 w-3"
                        />
                        <span className="font-mono font-bold flex-1">{lot}</span>
                        <span
                          className={`text-[8px] uppercase tracking-widest ${origin === "catalog" ? "text-muted-foreground" : "text-amber-600"}`}
                          data-testid={`label-lot-origin-${lot}`}
                        >
                          {origin === "catalog" ? "Catalog" : "Custom"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {selectedLots.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[9px] uppercase tracking-widest mt-1 w-full"
                  onClick={() => setSelectedLots([])}
                  data-testid="button-clear-lot-filter"
                >
                  Clear lot filter
                </Button>
              )}
            </PopoverContent>
          </Popover>
          {filtersActive && (
            <>
              <span className="text-[10px] text-muted-foreground" data-testid="text-filter-hidden-count">
                {hiddenByFilterCount > 0
                  ? `${hiddenByFilterCount} devis hidden by filters`
                  : "No devis hidden"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[9px] uppercase tracking-widest"
                onClick={clearFilters}
                data-testid="button-clear-filters"
              >
                Clear
              </Button>
            </>
          )}
        </div>
      )}

      {filteredDevisList && filteredDevisList.length > 0 ? (
        <div className="space-y-3">
          {filteredDevisList.map((d) => (
            <DevisRow
              key={d.id}
              d={d}
              projectId={projectId}
              contractors={contractors}
              lots={lots}
              isArchived={isArchived}
              expanded={expandedDevis === d.id}
              openChecks={openChecksByDevis[d.id] ?? 0}
              onToggle={() => setExpandedDevis(expandedDevis === d.id ? null : d.id)}
              onEditRefs={setEditRefsFor}
              onReviewDraft={(dev) => setDraftReviewData({
                devisId: dev.id,
                extraction: {
                  contractorName: contractors.find(c => c.id === dev.contractorId)?.name ?? "Unknown",
                  contractorId: dev.contractorId,
                },
                validation: {
                  isValid: !(dev.validationWarnings as any[])?.some((w: any) => w.severity === "error"),
                  warnings: (dev.validationWarnings as any[]) || [],
                  confidenceScore: dev.aiConfidence ?? 50,
                },
                devis: dev,
              })}
            />
          ))}
        </div>
      ) : !uploading ? (
        filtersActive && visibleBeforeFilters.length > 0 ? (
          <LuxuryCard data-testid="card-empty-devis-filtered">
            <div className="text-center py-6 space-y-2">
              <p className="text-[12px] text-muted-foreground">
                No devis match the current filters.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[10px] px-3"
                onClick={clearFilters}
                data-testid="button-clear-filters-empty"
              >
                Clear filters
              </Button>
            </div>
          </LuxuryCard>
        ) : (
          <LuxuryCard data-testid="card-empty-devis">
            <p className="text-[12px] text-muted-foreground text-center py-6">
              No Devis for this project yet. Drop a quotation PDF above to get started.
            </p>
          </LuxuryCard>
        )
      ) : null}

      {draftReviewData && (
        <DraftReviewPanel
          data={draftReviewData}
          projectId={projectId}
          contractors={contractors}
          onClose={() => setDraftReviewData(null)}
          isArchived={isArchived}
        />
      )}

      {editRefsFor && (
        <EditDevisRefsDialog
          devis={editRefsFor}
          projectId={projectId}
          contractors={contractors}
          onClose={() => setEditRefsFor(null)}
        />
      )}
    </div>
  );
}

const REF_FIELD_LABELS: Record<string, string> = {
  devisCode: "Devis Code",
  devisNumber: "Supplier Reference (N°)",
  ref2: "Additional Reference",
  contractorId: "Contractor",
};

function parseContractorRef(v: string | null | undefined): { id: number | null; name: string } | null {
  if (v == null || v === "") return null;
  const colonAt = v.indexOf(":");
  if (colonAt <= 0) return { id: null, name: v };
  const idStr = v.slice(0, colonAt);
  const name = v.slice(colonAt + 1);
  const id = Number(idStr);
  return { id: Number.isFinite(id) ? id : null, name };
}

function formatRefValue(v: string | null | undefined, field?: string) {
  if (v == null || v === "") return "—";
  if (field === "contractorId") {
    const parsed = parseContractorRef(v);
    return parsed?.name || v;
  }
  return v;
}

function formatEditTimestamp(ts: string | Date) {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toLocaleString();
}

function DevisRefEditsHistory({ devisId, projectId }: { devisId: number; projectId: string }) {
  const { toast } = useToast();
  const { data: edits } = useQuery<DevisRefEdit[]>({
    queryKey: ["/api/devis", devisId, "ref-edits"],
  });
  const [revertCandidate, setRevertCandidate] = useState<DevisRefEdit | null>(null);

  const revertMutation = useMutation({
    mutationFn: async (edit: DevisRefEdit) => {
      const raw = edit.previousValue;
      let payload: Record<string, unknown>;
      if (edit.field === "contractorId") {
        const parsed = parseContractorRef(raw);
        if (!parsed?.id) {
          throw new Error("Cannot revert: previous contractor reference is malformed");
        }
        payload = { contractorId: parsed.id };
      } else {
        const normalized = edit.field === "devisCode" ? raw : (raw == null || raw === "" ? null : raw);
        payload = { [edit.field]: normalized };
      }
      const res = await apiRequest("PATCH", `/api/devis/${devisId}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "ref-edits"] });
      toast({ title: "Reference reverted" });
      setRevertCandidate(null);
    },
    onError: (error: Error) => {
      toast({ title: "Revert failed", description: error.message, variant: "destructive" });
    },
  });

  if (!edits || edits.length === 0) return null;
  const last = edits[0];
  const editor = last.editedByEmail ?? "Unknown editor";

  return (
    <div className="flex items-center gap-2 text-[10px] text-muted-foreground" data-testid={`section-ref-edits-${devisId}`}>
      <span data-testid={`text-last-ref-edit-${devisId}`}>
        Last edited {REF_FIELD_LABELS[last.field] ?? last.field} by {editor} on {formatEditTimestamp(last.editedAt)}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="underline hover:text-[#0B2545] transition-colors"
            data-testid={`button-ref-edit-history-${devisId}`}
          >
            View history ({edits.length})
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-96 max-h-80 overflow-y-auto" align="start" data-testid={`popover-ref-edit-history-${devisId}`}>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#0B2545]">Reference edit history</p>
            <ul className="space-y-2">
              {edits.map((e) => {
                const canRevert = e.field !== "devisCode" || (e.previousValue != null && e.previousValue !== "");
                const latestForField = edits.find((x) => x.field === e.field);
                const isCurrentValueOfField = latestForField
                  ? (latestForField.newValue ?? "") === (e.previousValue ?? "")
                  : false;
                return (
                  <li
                    key={e.id}
                    className="text-[10px] border-b border-[rgba(0,0,0,0.06)] pb-2 last:border-b-0 last:pb-0"
                    data-testid={`row-ref-edit-${e.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-foreground">
                          {REF_FIELD_LABELS[e.field] ?? e.field}
                        </div>
                        <div className="text-muted-foreground">
                          <span className="line-through">{formatRefValue(e.previousValue, e.field)}</span>
                          <span className="mx-1">→</span>
                          <span className="text-foreground">{formatRefValue(e.newValue, e.field)}</span>
                        </div>
                        <div className="text-muted-foreground mt-0.5">
                          {(e.editedByEmail ?? "Unknown editor")} · {formatEditTimestamp(e.editedAt)}
                        </div>
                      </div>
                      {canRevert && !isCurrentValueOfField && (
                        <button
                          type="button"
                          className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-[#0B2545] underline hover:text-[#1a3a6b] transition-colors disabled:opacity-50"
                          onClick={() => setRevertCandidate(e)}
                          disabled={revertMutation.isPending}
                          data-testid={`button-revert-ref-edit-${e.id}`}
                        >
                          Revert
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </PopoverContent>
      </Popover>
      <AlertDialog open={revertCandidate !== null} onOpenChange={(open) => { if (!open && !revertMutation.isPending) setRevertCandidate(null); }}>
        <AlertDialogContent data-testid={`dialog-confirm-revert-${devisId}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert this reference?</AlertDialogTitle>
            <AlertDialogDescription>
              {revertCandidate && (
                <>
                  This will set <strong>{REF_FIELD_LABELS[revertCandidate.field] ?? revertCandidate.field}</strong> back to{" "}
                  <strong>{formatRefValue(revertCandidate.previousValue)}</strong>. The change will be recorded in the edit history under your name.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revertMutation.isPending} data-testid={`button-cancel-revert-${devisId}`}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={revertMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (revertCandidate) revertMutation.mutate(revertCandidate);
              }}
              data-testid={`button-confirm-revert-${devisId}`}
            >
              {revertMutation.isPending ? "Reverting…" : "Revert"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface EditDevisRefsDialogProps {
  devis: Devis;
  projectId: string;
  contractors: Contractor[];
  onClose: () => void;
}

function EditDevisRefsDialog({ devis, projectId, contractors, onClose }: EditDevisRefsDialogProps) {
  const { toast } = useToast();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [contractorId, setContractorIdState] = useState<number>(devis.contractorId);
  const [lotCode, setLotCode] = useState<LotCodeValue>(() => lotCodeValueFromDevis(devis));
  const [forcedNextLotSequence, setForcedNextLotSequence] = useState<number | null>(null);
  const [devisNumber, setDevisNumber] = useState(devis.devisNumber ?? "");
  const [ref2, setRef2] = useState(devis.ref2 ?? "");
  // Architect-commission override. "" = inherit project rate (NULL),
  // any other string = explicit per-devis rate (including "0" for
  // professional-services devis that don't carry a commission).
  const [feeOverride, setFeeOverride] = useState<string>(
    devis.feePercentageOverride ?? "",
  );

  const mutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/devis/${devis.id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "ref-edits"] });
      toast({ title: "References updated" });
      onClose();
    },
    onError: (error: Error) => {
      // 409 from buildLotCodeUpdates carries `nextLotSequence` —
      // auto-fill the composer with the suggestion so the architect
      // can resubmit without manual hunting.
      if (error instanceof ApiError && error.status === 409) {
        const data = error.data as { nextLotSequence?: number } | null;
        if (data?.nextLotSequence != null) {
          setForcedNextLotSequence(data.nextLotSequence);
          toast({
            title: "That number is already taken",
            description: `Suggested next free number: ${data.nextLotSequence}.`,
            variant: "destructive",
          });
          return;
        }
      }
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    if (!isAuthenticated) {
      toast({
        title: "Sign in required",
        description: "You must be signed in as an architect to edit devis references.",
        variant: "destructive",
      });
      return;
    }
    const trimmedNumber = devisNumber.trim();
    const trimmedRef2 = ref2.trim();
    if (!isLotCodeValueComplete(lotCode)) {
      toast({ title: "Devis code incomplete", description: "Lot, number and description are all required.", variant: "destructive" });
      return;
    }
    const payload: Record<string, unknown> = {};
    if (contractorId !== devis.contractorId) payload.contractorId = contractorId;
    const composedNow = composeDevisCode({
      lotRef: lotCode.lotRefText,
      lotSequence: lotCode.lotSequence,
      description: lotCode.lotDescription,
    });
    const lotChanged =
      composedNow !== (devis.devisCode ?? "") ||
      lotCode.lotCatalogId !== (devis.lotCatalogId ?? null) ||
      lotCode.lotRefText.toUpperCase() !== (devis.lotRefText ?? "").toUpperCase() ||
      lotCode.lotSequence !== (devis.lotSequence ?? null);
    if (lotChanged) {
      payload.lotCode = {
        lotCatalogId: lotCode.lotCatalogId,
        lotRefText: lotCode.lotRefText.trim().toUpperCase(),
        lotSequence: lotCode.lotSequence,
        lotDescription: lotCode.lotDescription.trim(),
      };
    }
    if (trimmedNumber !== (devis.devisNumber ?? "")) payload.devisNumber = trimmedNumber === "" ? null : trimmedNumber;
    if (trimmedRef2 !== (devis.ref2 ?? "")) payload.ref2 = trimmedRef2 === "" ? null : trimmedRef2;
    const trimmedFee = feeOverride.trim();
    const currentFee = devis.feePercentageOverride ?? "";
    if (trimmedFee !== currentFee) {
      if (trimmedFee === "") {
        payload.feePercentageOverride = null;
      } else {
        const parsed = parseFloat(trimmedFee);
        if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
          toast({
            title: "Invalid commission rate",
            description: "Enter a number between 0 and 100, or leave blank to use the project rate.",
            variant: "destructive",
          });
          return;
        }
        payload.feePercentageOverride = parsed.toFixed(2);
      }
    }
    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="dialog-edit-devis-refs">
        <DialogHeader>
          <DialogTitle className="text-[14px] font-black uppercase tracking-tight">Edit References</DialogTitle>
          <DialogDescription className="text-[11px]">
            Correct the devis code or supplier reference numbers if the AI mis-extracted them.
          </DialogDescription>
        </DialogHeader>
        {!authLoading && !isAuthenticated && (
          <div
            className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive"
            data-testid="text-edit-devis-refs-auth-warning"
          >
            You're signed out. Sign in as an architect to edit devis references — anonymous edits aren't allowed.
          </div>
        )}
        <div className="space-y-3">
          <div className="space-y-1">
            <TechnicalLabel>Contractor</TechnicalLabel>
            <ContractorSelect
              contractors={contractors}
              value={contractorId}
              onChange={setContractorIdState}
              testId="select-edit-devis-contractor"
            />
          </div>
          <LotCodeComposer
            projectId={projectId}
            excludeDevisId={devis.id}
            value={lotCode}
            onChange={setLotCode}
            forcedNextLotSequence={forcedNextLotSequence}
            testIdPrefix="edit-devis-code"
          />
          <div className="space-y-1">
            <TechnicalLabel>Supplier Reference (N°)</TechnicalLabel>
            <Input
              value={devisNumber}
              onChange={(e) => setDevisNumber(e.target.value)}
              className="text-[12px]"
              placeholder="e.g. DVP0000580"
              data-testid="input-edit-devis-number"
            />
          </div>
          <div className="space-y-1">
            <TechnicalLabel>Additional Reference</TechnicalLabel>
            <Input
              value={ref2}
              onChange={(e) => setRef2(e.target.value)}
              className="text-[12px]"
              placeholder="Optional"
              data-testid="input-edit-devis-ref2"
            />
          </div>
          <div className="space-y-1">
            <TechnicalLabel>Architect Commission Override (%)</TechnicalLabel>
            <Input
              value={feeOverride}
              onChange={(e) => setFeeOverride(e.target.value)}
              className="text-[12px]"
              placeholder="Leave blank to use project rate"
              inputMode="decimal"
              data-testid="input-edit-devis-fee-override"
            />
            <p className="text-[10px] text-muted-foreground">
              Blank = inherit project rate. Enter <strong>0</strong> for
              professional-services devis that don't carry a commission.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={mutation.isPending}
            data-testid="button-cancel-edit-devis-refs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={mutation.isPending || !isLotCodeValueComplete(lotCode) || !isAuthenticated || authLoading}
            data-testid="button-save-edit-devis-refs"
          >
            {mutation.isPending ? <Loader2 size={12} className="animate-spin" /> : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface DraftReviewPanelProps {
  data: {
    devisId: number;
    extraction: any;
    validation: any;
    devis: any;
  };
  projectId: string;
  contractors: Contractor[];
  onClose: () => void;
  isArchived?: boolean;
}

interface LotReferenceWarningBannerProps {
  warnings: Array<{ field: string; expected: any; actual: any; message: string; severity: "error" | "warning" }>;
  projectId: string;
  devisId: number;
  isArchived?: boolean;
}

function LotReferenceWarningBanner({
  warnings,
  projectId,
  devisId,
  isArchived = false,
}: LotReferenceWarningBannerProps) {
  const { toast } = useToast();
  const [addingNew, setAddingNew] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newDescUk, setNewDescUk] = useState("");
  const [suggesting, setSuggesting] = useState(false);

  const { data: lotCatalog = [] } = useQuery<LotCatalog[]>({
    queryKey: ["/api/lot-catalog"],
  });

  const suggestMutation = useMutation({
    mutationFn: async (data: { descriptionFr: string; code?: string }) => {
      const res = await apiRequest("POST", "/api/lot-catalog/translate", data);
      return (await res.json()) as { translation: string };
    },
    onError: (error: Error) => {
      toast({ title: "Could not suggest translation", description: error.message, variant: "destructive" });
    },
  });

  const handleSuggest = async () => {
    const fr = newDesc.trim();
    if (!fr) return;
    setSuggesting(true);
    try {
      const result = await suggestMutation.mutateAsync({ descriptionFr: fr, code: newCode.trim() || undefined });
      if (result?.translation) setNewDescUk(result.translation);
    } catch {
      // handled in onError
    } finally {
      setSuggesting(false);
    }
  };

  const assignMutation = useMutation({
    mutationFn: async (catalogCode: string) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/lots/assign-from-catalog`, {
        catalogCode,
        devisId,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "lots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      toast({ title: "Lot assigned" });
    },
    onError: (error: Error) => {
      toast({ title: "Error assigning lot", description: error.message, variant: "destructive" });
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: { code: string; descriptionFr: string; descriptionUk?: string | null }) => {
      const res = await apiRequest("POST", `/api/lot-catalog`, data);
      return res.json();
    },
    onSuccess: (entry: LotCatalog) => {
      queryClient.invalidateQueries({ queryKey: ["/api/lot-catalog"] });
      assignMutation.mutate(entry.code);
      setAddingNew(false);
      setNewCode("");
      setNewDesc("");
      setNewDescUk("");
      toast({ title: "Lot added to master list" });
    },
    onError: (error: Error) => {
      toast({ title: "Error creating lot", description: error.message, variant: "destructive" });
    },
  });

  if (warnings.length === 0) return null;

  return (
    <div
      className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/40 p-3 space-y-2.5"
      data-testid={`banner-needs-new-lot-${devisId}`}
    >
      <div className="flex items-start gap-2">
        <Tag size={16} className="text-amber-600 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-amber-800">
            Needs new lot
          </p>
          <p className="text-[10px] mt-0.5 text-amber-800/90">
            The AI suggested lot code(s) that don't exist in the master catalog. Pick an existing master code or add a new one before confirming.
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {warnings.map((w, i) => (
              <li
                key={i}
                className="text-[10px] text-foreground/80 font-mono truncate"
                data-testid={`needs-new-lot-suggestion-${devisId}-${i}`}
              >
                AI suggested: <span className="font-semibold">"{String(w.actual ?? "")}"</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {!isArchived && (
        <div className="space-y-2 pl-6">
          {!addingNew ? (
            <div className="flex items-center gap-2 flex-wrap">
              <Select
                onValueChange={(val) => {
                  if (val === "__new__") setAddingNew(true);
                  else assignMutation.mutate(val);
                }}
                disabled={assignMutation.isPending}
              >
                <SelectTrigger className="flex-1 h-8 text-[11px] bg-white" data-testid={`select-needs-new-lot-${devisId}`}>
                  <SelectValue placeholder="Pick a master lot code..." />
                </SelectTrigger>
                <SelectContent>
                  {lotCatalog.map((entry) => (
                    <SelectItem key={entry.id} value={entry.code} data-testid={`option-needs-new-lot-${entry.code}`}>
                      {entry.code} — {formatLotDescription(entry)}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">+ Add new lot to master list</SelectItem>
                </SelectContent>
              </Select>
              <Link href="/settings">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 gap-1 text-[10px] text-amber-800 hover:text-amber-900"
                  data-testid={`link-manage-master-list-${devisId}`}
                >
                  <SettingsIcon size={11} />
                  Manage master list
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-2 p-2 rounded-md border border-amber-300 bg-white/70">
              <p className="text-[9px] text-muted-foreground">Adds to the master list — available across all projects.</p>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Code (e.g. LOT3)"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  className="text-[11px] h-8"
                  data-testid={`input-needs-new-lot-code-${devisId}`}
                />
                <Input
                  placeholder="French description"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="text-[11px] h-8"
                  data-testid={`input-needs-new-lot-desc-${devisId}`}
                />
              </div>
              <div className="relative">
                <Input
                  placeholder="English description (optional)"
                  value={newDescUk}
                  onChange={(e) => setNewDescUk(e.target.value)}
                  className="text-[11px] h-8 pr-8"
                  data-testid={`input-needs-new-lot-desc-uk-${devisId}`}
                />
                <button
                  type="button"
                  onClick={handleSuggest}
                  disabled={suggesting || newDesc.trim().length === 0}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Suggest English translation"
                  data-testid={`button-suggest-needs-new-lot-uk-${devisId}`}
                >
                  {suggesting ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  disabled={!newCode.trim() || !newDesc.trim() || createMutation.isPending || assignMutation.isPending}
                  onClick={() => createMutation.mutate({ code: newCode.trim(), descriptionFr: newDesc.trim(), descriptionUk: newDescUk.trim() || null })}
                  data-testid={`button-save-needs-new-lot-${devisId}`}
                >
                  <span className="text-[9px] font-bold uppercase tracking-widest">
                    {createMutation.isPending || assignMutation.isPending ? "Saving..." : "Save & Assign"}
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  onClick={() => { setAddingNew(false); setNewCode(""); setNewDesc(""); setNewDescUk(""); }}
                  data-testid={`button-cancel-needs-new-lot-${devisId}`}
                >
                  <span className="text-[9px] font-bold uppercase tracking-widest">Cancel</span>
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfidenceIndicator({ score }: { score: number }) {
  const color = score > 80 ? "text-emerald-600" : score >= 50 ? "text-amber-500" : "text-rose-500";
  const bgColor = score > 80 ? "bg-emerald-50 dark:bg-emerald-950/40" : score >= 50 ? "bg-amber-50 dark:bg-amber-950/40" : "bg-rose-50 dark:bg-rose-950/40";
  const borderColor = score > 80 ? "border-emerald-200 dark:border-emerald-800" : score >= 50 ? "border-amber-200 dark:border-amber-800" : "border-rose-200 dark:border-rose-800";
  const Icon = score > 80 ? ShieldCheck : score >= 50 ? ShieldAlert : ShieldX;
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border ${bgColor} ${borderColor}`} data-testid="indicator-ai-confidence">
      <Icon size={14} className={color} />
      <span className={`text-[11px] font-bold ${color}`}>{score}%</span>
      <span className="text-[9px] text-muted-foreground">AI Confidence</span>
    </div>
  );
}

function DraftReviewPanel({ data, projectId, contractors, onClose, isArchived = false }: DraftReviewPanelProps) {
  const { toast } = useToast();
  const { devisId, extraction, validation, devis } = data;
  const initialContractorId: number = devis.contractorId ?? extraction?.contractorId ?? 0;
  const [draftContractorId, setDraftContractorId] = useState<number>(initialContractorId);
  const contractorSectionRef = useRef<HTMLDivElement>(null);
  const { lotRefWarnings, contractorAdvisories, generic: warnings } =
    partitionDraftWarnings(validation?.warnings as DraftValidationWarning[] | undefined);

  const handleChooseContractor = () => {
    focusContractorSelect(contractorSectionRef.current);
  };
  const confidenceScore: number = validation?.confidenceScore ?? 50;

  const [editValues, setEditValues] = useState({
    amountHt: devis.amountHt ?? "",
    amountTtc: devis.amountTtc ?? "",
    devisNumber: devis.devisNumber ?? "",
    descriptionFr: devis.descriptionFr ?? "",
    dateSent: devis.dateSent ?? "",
    feePercentageOverride: devis.feePercentageOverride ?? "",
  });
  // Pre-fill the structured composer from the AI extraction's lot reference
  // when present (e.g. "FD" detected on the PDF). The number always starts
  // empty here; the composer will fetch the project-scoped next available
  // sequence the moment the lot is set, so the architect never picks an
  // already-used (lot, n) tuple by accident.
  const initialLotCode: LotCodeValue = (() => {
    const fromDevis = lotCodeValueFromDevis(devis);
    if (fromDevis.lotRefText) return fromDevis;
    const aiLotRefs: string[] = Array.isArray(extraction?.lotReferences) ? extraction.lotReferences : [];
    const aiLotRef = (aiLotRefs.find((r) => typeof r === "string" && r.trim().length > 0) ?? "").trim();
    return {
      lotCatalogId: null,
      lotRefText: aiLotRef,
      lotSequence: null,
      lotDescription: "",
    };
  })();
  const [lotCode, setLotCode] = useState<LotCodeValue>(initialLotCode);
  const [forcedNextLotSequence, setForcedNextLotSequence] = useState<number | null>(null);

  const fieldWarnings = (field: string) => warnings.filter(w => w.field === field);

  const confirmMutation = useMutation({
    mutationFn: async (corrections: Record<string, any>) => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/confirm`, corrections);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      toast({ title: "Devis confirmed", description: "Draft has been confirmed and is now pending" });
      onClose();
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status === 409) {
        const data = error.data as { nextLotSequence?: number } | null;
        if (data?.nextLotSequence != null) {
          setForcedNextLotSequence(data.nextLotSequence);
          toast({
            title: "That number is already taken",
            description: `Suggested next free number: ${data.nextLotSequence}.`,
            variant: "destructive",
          });
          return;
        }
      }
      toast({ title: "Confirmation failed", description: error.message, variant: "destructive" });
    },
  });

  const discardMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/devis/${devisId}`, { status: "void", voidReason: "Discarded draft — AI extraction rejected by user" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      toast({ title: "Draft discarded", description: "The draft devis has been voided" });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Discard failed", description: error.message, variant: "destructive" });
    },
  });

  const handleConfirm = async () => {
    if (!isLotCodeValueComplete(lotCode)) {
      toast({
        title: "Devis code incomplete",
        description: "Pick a lot, set the number, and add a description before confirming.",
        variant: "destructive",
      });
      return;
    }
    const corrections: Record<string, any> = {
      lotCode: {
        lotCatalogId: lotCode.lotCatalogId,
        lotRefText: lotCode.lotRefText.trim().toUpperCase(),
        lotSequence: lotCode.lotSequence,
        lotDescription: lotCode.lotDescription.trim(),
      },
    };
    if (editValues.amountHt !== (devis.amountHt ?? "")) corrections.amountHt = editValues.amountHt;
    if (editValues.amountTtc !== (devis.amountTtc ?? "")) corrections.amountTtc = editValues.amountTtc;
    if (editValues.devisNumber !== (devis.devisNumber ?? "")) corrections.devisNumber = editValues.devisNumber;
    if (editValues.descriptionFr !== (devis.descriptionFr ?? "")) corrections.descriptionFr = editValues.descriptionFr;
    if (editValues.dateSent !== (devis.dateSent ?? "")) corrections.dateSent = editValues.dateSent;
    const trimmedFee = editValues.feePercentageOverride.trim();
    const currentFee = devis.feePercentageOverride ?? "";
    if (trimmedFee !== currentFee) {
      if (trimmedFee === "") {
        corrections.feePercentageOverride = null;
      } else {
        const parsed = parseFloat(trimmedFee);
        if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
          toast({
            title: "Invalid commission rate",
            description: "Enter a number between 0 and 100, or leave blank to use the project rate.",
            variant: "destructive",
          });
          return;
        }
        corrections.feePercentageOverride = parsed;
      }
    }

    if (draftContractorId && draftContractorId !== initialContractorId) {
      try {
        await apiRequest("PATCH", `/api/devis/${devisId}`, { contractorId: draftContractorId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast({ title: "Could not update contractor", description: message, variant: "destructive" });
        return;
      }
    }

    confirmMutation.mutate(corrections);
  };

  const updateField = (field: string, value: string) => {
    setEditValues(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !confirmMutation.isPending && !discardMutation.isPending) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-draft-review">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-black uppercase tracking-tight flex items-center gap-3 flex-wrap">
            Review AI Extraction
            <ConfidenceIndicator score={confidenceScore} />
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            Verify AI-extracted values before confirming. Edit any incorrect fields.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {lotRefWarnings.length > 0 && (
            <LotReferenceWarningBanner
              warnings={lotRefWarnings}
              projectId={projectId}
              devisId={devisId}
              isArchived={isArchived}
            />
          )}
          <ContractorAdvisoryBanner
            warnings={contractorAdvisories}
            devisId={devisId}
            isArchived={isArchived}
            onChooseContractor={handleChooseContractor}
          />
          <GenericValidationWarningsList warnings={warnings} />

          <div className="space-y-1.5">
            <TechnicalLabel>Persisted Advisories</TechnicalLabel>
            <AdvisoriesList subject={{ type: "devis", id: devisId }} />
          </div>

          <div className="space-y-1.5" ref={contractorSectionRef}>
            <TechnicalLabel>Contractor</TechnicalLabel>
            <ContractorSelect
              contractors={contractors}
              value={draftContractorId}
              onChange={setDraftContractorId}
              disabled={isArchived}
              testId="select-draft-contractor"
              className="text-[11px]"
            />
            {draftContractorId !== initialContractorId && (
              <p className="text-[10px] text-amber-700" data-testid="text-draft-contractor-changed">
                Contractor will be reassigned when you confirm.
              </p>
            )}
          </div>

          <LotCodeComposer
            projectId={projectId}
            excludeDevisId={devisId}
            value={lotCode}
            onChange={setLotCode}
            forcedNextLotSequence={forcedNextLotSequence}
            testIdPrefix="draft-devis-code"
          />
          {fieldWarnings("devisCode").map((w, i) => (
            <Badge key={i} variant="outline" className={`text-[8px] ${w.severity === "error" ? "border-rose-300 text-rose-600" : "border-amber-300 text-amber-600"}`}>
              {w.severity}: devis code · {w.message ?? ""}
            </Badge>
          ))}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <TechnicalLabel>Devis Number (supplier ref)</TechnicalLabel>
              {fieldWarnings("devisNumber").map((w, i) => (
                <Badge key={i} variant="outline" className={`text-[8px] ${w.severity === "error" ? "border-rose-300 text-rose-600" : "border-amber-300 text-amber-600"}`}>
                  {w.severity}
                </Badge>
              ))}
            </div>
            <Input
              value={editValues.devisNumber}
              onChange={(e) => updateField("devisNumber", e.target.value)}
              className="text-[11px]"
              data-testid="input-draft-devis-number"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <TechnicalLabel>Description</TechnicalLabel>
              {fieldWarnings("descriptionFr").map((w, i) => (
                <Badge key={i} variant="outline" className={`text-[8px] ${w.severity === "error" ? "border-rose-300 text-rose-600" : "border-amber-300 text-amber-600"}`}>
                  {w.severity}
                </Badge>
              ))}
            </div>
            <Textarea
              value={editValues.descriptionFr}
              onChange={(e) => updateField("descriptionFr", e.target.value)}
              className="text-[11px] resize-none"
              rows={2}
              data-testid="input-draft-description"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <TechnicalLabel>Amount HT</TechnicalLabel>
                {fieldWarnings("amountHt").map((w, i) => (
                  <Badge key={i} variant="outline" className={`text-[8px] ${w.severity === "error" ? "border-rose-300 text-rose-600" : "border-amber-300 text-amber-600"}`}>
                    {w.severity}
                  </Badge>
                ))}
              </div>
              <Input
                type="number"
                step="0.01"
                value={editValues.amountHt}
                onChange={(e) => updateField("amountHt", e.target.value)}
                className="text-[11px]"
                data-testid="input-draft-amount-ht"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <TechnicalLabel>Amount TTC</TechnicalLabel>
                {fieldWarnings("amountTtc").map((w, i) => (
                  <Badge key={i} variant="outline" className={`text-[8px] ${w.severity === "error" ? "border-rose-300 text-rose-600" : "border-amber-300 text-amber-600"}`}>
                    {w.severity}
                  </Badge>
                ))}
              </div>
              <Input
                type="number"
                step="0.01"
                value={editValues.amountTtc}
                onChange={(e) => updateField("amountTtc", e.target.value)}
                className="text-[11px]"
                data-testid="input-draft-amount-ttc"
              />
            </div>
          </div>

          <TvaDerivedHint
            amountHt={editValues.amountHt}
            amountTtc={editValues.amountTtc}
            testId="text-draft-tva-derived"
          />

          <div className="space-y-1">
            <TechnicalLabel>Date</TechnicalLabel>
            <Input
              type="date"
              value={editValues.dateSent}
              onChange={(e) => updateField("dateSent", e.target.value)}
              className="text-[11px]"
              data-testid="input-draft-date"
            />
          </div>

          <div className="space-y-1">
            <TechnicalLabel>Architect Commission Override (%)</TechnicalLabel>
            <Input
              value={editValues.feePercentageOverride}
              onChange={(e) => updateField("feePercentageOverride", e.target.value)}
              className="text-[11px]"
              placeholder="Leave blank to use project rate"
              inputMode="decimal"
              data-testid="input-draft-fee-override"
            />
            <p className="text-[10px] text-muted-foreground">
              Blank = inherit project rate. Enter <strong>0</strong> for any
              devis the firm doesn't charge a commission on.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 border-rose-200 text-rose-600"
            onClick={() => discardMutation.mutate()}
            disabled={discardMutation.isPending || confirmMutation.isPending || isArchived}
            data-testid="button-discard-draft"
          >
            <Trash2 size={12} />
            <span className="text-[9px] font-bold uppercase tracking-widest">
              {discardMutation.isPending ? "Discarding..." : "Discard"}
            </span>
          </Button>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={confirmMutation.isPending || discardMutation.isPending}
              data-testid="button-cancel-draft-review"
            >
              <span className="text-[9px] font-bold uppercase tracking-widest">Review Later</span>
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={confirmMutation.isPending || discardMutation.isPending || isArchived || !isLotCodeValueComplete(lotCode)}
              data-testid="button-confirm-draft"
            >
              <Check size={12} />
              <span className="text-[9px] font-bold uppercase tracking-widest">
                {confirmMutation.isPending ? "Confirming..." : "Confirm"}
              </span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const CHECK_COLORS: Record<string, { bg: string; border: string; ring: string; row: string }> = {
  // `bg`/`ring` style the status PILL. `border` is the 3px coloured stripe on
  // the left edge of the row. `row` is the subtle background wash applied to
  // the whole <tr> so flagged lines pop at-a-glance — this matches the
  // `rowTint` helper from the canvas-approved Variant B mockup
  // (artifacts/mockup-sandbox/src/components/mockups/devis-checks/_shared.tsx).
  green: { bg: "bg-emerald-500", border: "border-l-emerald-500", ring: "ring-emerald-300", row: "bg-emerald-50/30" },
  amber: { bg: "bg-amber-400", border: "border-l-amber-400", ring: "ring-amber-200", row: "bg-amber-50/40" },
  red: { bg: "bg-rose-500", border: "border-l-rose-500", ring: "ring-rose-300", row: "bg-rose-50/40" },
  unchecked: { bg: "", border: "border-l-transparent", ring: "", row: "" },
};

function LineItemWithCheck({
  li,
  onUpdate,
  devisId,
  openCheck,
  onSaveCheckQuery,
  disabled = false,
}: {
  li: DevisLineItem;
  onUpdate: (data: Record<string, string>) => Promise<unknown> | unknown;
  devisId: number;
  openCheck: { id: number; query: string } | null;
  onSaveCheckQuery: (checkId: number, query: string) => Promise<unknown>;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const status = li.checkStatus || "unchecked";
  const notes = li.checkNotes || "";
  const colors = CHECK_COLORS[status] || CHECK_COLORS.unchecked;
  const [notesOpen, setNotesOpen] = useState(!!notes);
  const [editingDesc, setEditingDesc] = useState(false);
  const [draftDesc, setDraftDesc] = useState(li.description);
  const [savingDesc, setSavingDesc] = useState(false);

  // Variant B inline-popover state. Opens when the architect clicks the red
  // status button (after the line PATCH auto-creates the check server-side
  // and we've refetched checks so `openCheck` populates), or when clicking
  // the rose "QUESTION RÉDIGÉE" pill on a line that already has a draft.
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverDraft, setPopoverDraft] = useState("");
  const [pendingOpenAfterFlag, setPendingOpenAfterFlag] = useState(false);
  const [savingPopover, setSavingPopover] = useState(false);

  // Once the just-toggled-red check arrives via refetch, seed the draft
  // from the server's auto-suggested query and open the popover.
  useEffect(() => {
    if (pendingOpenAfterFlag && openCheck) {
      setPopoverDraft(openCheck.query);
      setPopoverOpen(true);
      setPendingOpenAfterFlag(false);
    }
  }, [pendingOpenAfterFlag, openCheck]);

  // Esc closes the popover.
  useEffect(() => {
    if (!popoverOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPopoverOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popoverOpen]);

  const fireUpdate = (data: Record<string, string>) => {
    void Promise.resolve(onUpdate(data)).catch(() => {});
  };

  const toggleStatus = async (newStatus: string) => {
    if (disabled) return;
    const next = status === newStatus ? "unchecked" : newStatus;
    try {
      await Promise.resolve(onUpdate({ checkStatus: next }));
      // Always refetch checks: the backend may upsert an open draft on red,
      // drop a message-less draft on unchecked/green, or leave checks intact
      // on amber. Invalidating universally keeps the bottom-mirror digest,
      // CTA count, and "QUESTION RÉDIGÉE" pill in sync regardless of which
      // direction the toggle went.
      await queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "checks"] });
      if (next === "red") {
        // Once `openCheck` populates from the refetch, the effect below
        // seeds the draft from the server's auto-suggested query and opens
        // the popover.
        setPendingOpenAfterFlag(true);
      } else {
        setPopoverOpen(false);
        setPopoverDraft("");
      }
    } catch {
      // Mutation already toasts via parent; nothing to do here.
    }
  };

  const openExistingPopover = () => {
    if (!openCheck) return;
    setPopoverDraft(openCheck.query);
    setPopoverOpen(true);
  };

  const cancelPopover = () => {
    setPopoverOpen(false);
    setPopoverDraft("");
  };

  const savePopover = async () => {
    if (!openCheck || savingPopover) return;
    const next = popoverDraft.trim();
    if (!next) {
      cancelPopover();
      return;
    }
    setSavingPopover(true);
    try {
      await onSaveCheckQuery(openCheck.id, next);
      setPopoverOpen(false);
      setPopoverDraft("");
    } catch (err) {
      toast({
        title: "Impossible d'enregistrer la question",
        description: err instanceof Error ? err.message : "Veuillez réessayer.",
        variant: "destructive",
      });
    } finally {
      setSavingPopover(false);
    }
  };

  const enterDescEdit = () => {
    if (disabled || savingDesc) return;
    setDraftDesc(li.description);
    setEditingDesc(true);
  };

  const cancelDescEdit = () => {
    setDraftDesc(li.description);
    setEditingDesc(false);
  };

  const saveDescEdit = async () => {
    if (savingDesc) return;
    const next = draftDesc.trim();
    if (!next) {
      cancelDescEdit();
      return;
    }
    if (next === li.description) {
      setEditingDesc(false);
      return;
    }
    setSavingDesc(true);
    try {
      await Promise.resolve(onUpdate({ description: next }));
      toast({ title: "Description updated" });
      setEditingDesc(false);
    } catch (err) {
      setDraftDesc(li.description);
      setEditingDesc(false);
      toast({
        title: "Couldn't update description",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingDesc(false);
    }
  };

  return (
    <>
      <tr className={`border-l-[3px] ${colors.border} ${colors.row} ${savingDesc ? "opacity-60" : ""}`}>
        <td className="py-1.5 px-2 text-[11px] align-top">{li.lineNumber}</td>
        <td className="py-1.5 px-2 text-[11px] align-top">
          {editingDesc ? (
            <div className="flex flex-col gap-1">
              <Textarea
                autoFocus
                value={draftDesc}
                onChange={(e) => setDraftDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelDescEdit();
                  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    saveDescEdit();
                  }
                }}
                onBlur={() => { if (editingDesc) saveDescEdit(); }}
                rows={2}
                className="text-[11px] min-h-[44px] py-1.5"
                disabled={savingDesc}
                data-testid={`textarea-line-description-${li.id}`}
              />
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={saveDescEdit}
                  disabled={savingDesc}
                  data-testid={`button-save-line-description-${li.id}`}
                >
                  {savingDesc ? <Loader2 size={10} className="animate-spin" /> : "Save"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={cancelDescEdit}
                  disabled={savingDesc}
                  data-testid={`button-cancel-line-description-${li.id}`}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div
              role={disabled ? undefined : "button"}
              tabIndex={disabled ? -1 : 0}
              onClick={enterDescEdit}
              onKeyDown={(e) => {
                if (disabled) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  enterDescEdit();
                }
              }}
              className={`whitespace-pre-wrap rounded px-1 -mx-1 outline-none ${disabled ? "" : "cursor-text hover:bg-[#c1a27b]/10 focus:ring-2 focus:ring-[#c1a27b]/40"}`}
              title={disabled ? undefined : "Click to edit"}
              data-testid={`cell-line-description-${li.id}`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span>{li.description}</span>
                {openCheck && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); openExistingPopover(); }}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 text-[9px] font-bold uppercase tracking-widest hover:bg-rose-200"
                    title={openCheck.query}
                    data-testid={`badge-question-redigee-${li.id}`}
                  >
                    <MessageSquare size={9} /> Question rédigée
                  </button>
                )}
              </div>
            </div>
          )}
        </td>
        <td className="py-1.5 px-2 text-[11px] text-right">{li.quantity}</td>
        <td className="py-1.5 px-2 text-[11px] text-right">{li.unitPriceHt ? formatCurrency(parseFloat(li.unitPriceHt)) : "-"}</td>
        <td className="py-1.5 px-2 text-[11px] text-right font-medium">{formatCurrency(parseFloat(li.totalHt))}</td>
        <td className="py-1.5 px-2 relative">
          {popoverOpen && openCheck && (
            <div
              className="absolute right-2 top-9 z-30 w-[380px] rounded-xl border-2 border-rose-300 bg-white shadow-xl p-3 text-left"
              data-testid={`popover-check-editor-${li.id}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[9px] font-bold uppercase tracking-widest text-rose-700">Question à l'entreprise</span>
                <button
                  type="button"
                  className="text-rose-400 hover:text-rose-600"
                  onClick={cancelPopover}
                  aria-label="Fermer"
                  data-testid={`button-popover-close-${li.id}`}
                >
                  <X size={14} />
                </button>
              </div>
              <p className="text-[10px] text-slate-500 mb-1.5">
                Ligne {li.lineNumber} · {formatCurrency(parseFloat(li.totalHt))} HT
              </p>
              <Textarea
                autoFocus
                value={popoverDraft}
                onChange={(e) => setPopoverDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void savePopover();
                  }
                }}
                rows={3}
                className="text-[11px] min-h-[68px]"
                disabled={savingPopover}
                data-testid={`textarea-popover-query-${li.id}`}
              />
              <div className="flex items-center justify-end gap-1.5 mt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-[10px]"
                  onClick={cancelPopover}
                  disabled={savingPopover}
                  data-testid={`button-popover-cancel-${li.id}`}
                >
                  Annuler
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-[10px] bg-rose-600 hover:bg-rose-700 text-white"
                  onClick={savePopover}
                  disabled={savingPopover || !popoverDraft.trim()}
                  data-testid={`button-popover-save-${li.id}`}
                >
                  {savingPopover ? <Loader2 size={10} className="animate-spin" /> : "Enregistrer"}
                </Button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-end gap-1">
            <Input
              type="number"
              className="h-6 w-16 text-[10px] text-right inline-block"
              defaultValue={li.percentComplete ?? "0"}
              min={0}
              max={100}
              step={5}
              onBlur={(e) => { if (!disabled) fireUpdate({ percentComplete: e.target.value }); }}
              disabled={disabled}
              data-testid={`input-line-progress-${li.id}`}
            />
            <div className="flex items-center gap-0.5 ml-1">
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "green" ? "bg-emerald-500 border-emerald-600 ring-2 ring-emerald-300" : "border-emerald-400 hover:bg-emerald-50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => toggleStatus("green")}
                disabled={disabled}
                title="Approved"
                data-testid={`button-check-green-${li.id}`}
              >
                {status === "green" && <Check size={12} className="text-white" />}
              </button>
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "amber" ? "bg-amber-400 border-amber-500 ring-2 ring-amber-200" : "border-amber-400 hover:bg-amber-50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => toggleStatus("amber")}
                disabled={disabled}
                title="Questioned"
                data-testid={`button-check-amber-${li.id}`}
              >
                {status === "amber" && <span className="text-white text-[10px] font-bold">?</span>}
              </button>
              <button
                className={`w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${status === "red" ? "bg-rose-500 border-rose-600 ring-2 ring-rose-300" : "border-rose-400 hover:bg-rose-50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => toggleStatus("red")}
                disabled={disabled}
                title="Rejected"
                data-testid={`button-check-red-${li.id}`}
              >
                {status === "red" && <span className="text-white text-[10px] font-bold">✕</span>}
              </button>
            </div>
            <button
              className={`w-6 h-6 rounded-md border transition-all flex items-center justify-center ml-0.5 ${notesOpen ? "bg-[#c1a27b]/10 border-[#c1a27b] text-[#c1a27b]" : notes ? "border-[#c1a27b]/50 text-[#c1a27b]" : "border-gray-200 text-gray-400 hover:text-[#c1a27b] hover:border-[#c1a27b]/50"}`}
              onClick={() => setNotesOpen(!notesOpen)}
              title={notesOpen ? "Hide notes" : "Show notes"}
              data-testid={`button-toggle-notes-${li.id}`}
            >
              <FileText size={11} />
            </button>
          </div>
        </td>
      </tr>
      {notesOpen && (
        <tr className={`border-l-[3px] ${colors.border}`}>
          <td colSpan={6} className="px-2 pb-2 pt-0.5">
            <input
              type="text"
              className="w-full h-7 px-3 text-[11px] rounded-lg border-2 outline-none transition-colors bg-white disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ borderColor: "#c1a27b" }}
              placeholder="Notes"
              defaultValue={notes}
              onBlur={(e) => {
                if (disabled) return;
                if (e.target.value !== notes) {
                  fireUpdate({ checkNotes: e.target.value });
                }
              }}
              disabled={disabled}
              data-testid={`input-line-notes-${li.id}`}
            />
          </td>
        </tr>
      )}
      {!notesOpen && notes && (
        <tr className={`border-l-[3px] ${colors.border}`}>
          <td colSpan={6} className="px-2 pb-1 pt-0">
            <p className="text-[10px] text-[#c1a27b] italic truncate cursor-pointer" onClick={() => setNotesOpen(true)} data-testid={`text-note-preview-${li.id}`}>
              {notes}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

type CheckMessage = { id: number; authorType: "architect" | "contractor" | "system"; authorName: string | null; body: string; createdAt: string | Date };
type CheckWithMessages = { id: number; devisId: number; lineItemId: number | null; status: string; query: string; origin: string; messages: CheckMessage[] };

const CHECK_STATUS_LABEL: Record<string, string> = {
  open: "Brouillon",
  awaiting_contractor: "En attente entreprise",
  awaiting_architect: "Réponse reçue",
  resolved: "Clôturé",
  dropped: "Abandonné",
};

const CHECK_STATUS_COLOR: Record<string, string> = {
  open: "bg-slate-100 text-slate-700 border-slate-300",
  awaiting_contractor: "bg-blue-50 text-blue-700 border-blue-200",
  awaiting_architect: "bg-amber-50 text-amber-700 border-amber-200",
  resolved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  dropped: "bg-slate-50 text-slate-400 border-slate-200",
};

type CheckTokenInfo = {
  id: number;
  createdAt: string | Date;
  lastUsedAt: string | Date | null;
  expiresAt: string | Date | null;
  revokedAt: string | Date | null;
};

function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

/**
 * Yellow non-blocking banner shown above the checks panel when the active
 * portal token's expiresAt falls within the next 7 days. Reuses the same
 * react-query key as TokenPanel so no extra network call is made (React
 * Query dedupes overlapping subscribers). Suppressed when there is no
 * token, the token is revoked (lifecycle revoke handles fully-invoiced
 * devis), the token is already expired, or expiry is further than the
 * 7-day threshold. After a successful extend, the shared query key is
 * invalidated so the banner recalculates and disappears on its own.
 */
export const LAPSING_THRESHOLD_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pure helper — exported for unit tests. Returns the banner copy + days
 * remaining when the active token's expiry falls within the threshold,
 * or null when the banner should be suppressed (no token, revoked,
 * missing/invalid expiry, already expired, or further out than the
 * threshold). Singular "1 jour" vs plural "X jours" is handled here.
 */
export function computeLapsingBannerState(
  token: Pick<CheckTokenInfo, "expiresAt" | "revokedAt"> | null | undefined,
  now: Date = new Date(),
  thresholdDays: number = LAPSING_THRESHOLD_DAYS,
): { daysRemaining: number; copy: string } | null {
  if (!token || token.revokedAt || !token.expiresAt) return null;
  const expiresAt = new Date(token.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return null;
  const msRemaining = expiresAt.getTime() - now.getTime();
  if (msRemaining <= 0) return null;
  if (msRemaining > thresholdDays * MS_PER_DAY) return null;
  const daysRemaining = Math.max(1, Math.ceil(msRemaining / MS_PER_DAY));
  const copy =
    daysRemaining === 1
      ? "Le lien partagé avec l'entreprise expire dans 1 jour."
      : `Le lien partagé avec l'entreprise expire dans ${daysRemaining} jours.`;
  return { daysRemaining, copy };
}

function LapsingTokenBanner({ devisId, isArchived }: { devisId: number; isArchived: boolean }) {
  const { toast } = useToast();
  const { isAuthenticated } = useAuth();
  const { data } = useQuery<{ token: CheckTokenInfo | null }>({
    queryKey: ["/api/devis", devisId, "check-token"],
    enabled: isAuthenticated,
  });

  const extendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/check-token/extend`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "check-token"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "checks"] });
      toast({ title: "Lien prolongé de 90 jours" });
    },
    onError: (error: Error) =>
      toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  // Permission gate: only authenticated architects can extend the token
  // (the backend's /extend route is auth-guarded). If the session is not
  // authenticated we suppress the banner entirely so it never invites a
  // click that will fail.
  if (!isAuthenticated) return null;
  if (isArchived) return null;
  const state = computeLapsingBannerState(data?.token ?? null);
  if (!state) return null;

  return (
    <div
      className="flex items-center justify-between gap-3 flex-wrap rounded-lg border border-amber-300 bg-amber-50 p-2.5"
      data-testid={`banner-token-lapsing-${devisId}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <AlertTriangle size={14} className="text-amber-600 shrink-0" />
        <p
          className="text-[11px] font-medium text-amber-900"
          data-testid={`text-token-lapsing-${devisId}`}
        >
          {state.copy}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-[9px] font-bold uppercase tracking-widest border-amber-400 text-amber-900 hover:bg-amber-100"
        onClick={() => extendMutation.mutate()}
        disabled={extendMutation.isPending}
        data-testid={`button-extend-lapsing-token-${devisId}`}
      >
        {extendMutation.isPending ? "…" : "Prolonger de 90 jours"}
      </Button>
    </div>
  );
}

function TokenPanel({ devisId, projectId, isArchived }: { devisId: number; projectId: string; isArchived: boolean }) {
  const { toast } = useToast();
  const [copyConfirmOpen, setCopyConfirmOpen] = useState(false);
  const { data, isLoading } = useQuery<{ token: CheckTokenInfo | null }>({
    queryKey: ["/api/devis", devisId, "check-token"],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "check-token"] });
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "checks"] });
  };

  const extendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/check-token/extend`, {});
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Lien prolongé" }); },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const revokeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/check-token/revoke`, {});
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Lien révoqué" }); },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  // "Copier le lien" — issues a fresh token and copies the raw URL to the
  // clipboard so the architect can share it via WhatsApp / SMS / etc. Always
  // rotates: previous tokens cannot be recovered (hash-only storage), so the
  // confirm dialog warns the user before invalidating any link already sent.
  const copyMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/check-token/issue-for-copy`, {});
      return res.json() as Promise<{ portalUrl: string }>;
    },
    onSuccess: async (data) => {
      try {
        await navigator.clipboard.writeText(data.portalUrl);
        toast({
          title: "Lien copié",
          description: "Le nouveau lien contractant est dans le presse-papiers.",
        });
      } catch {
        // Clipboard write can fail in non-secure contexts or when the tab is
        // not focused — surface the URL in the toast so the user can copy it
        // manually rather than losing the freshly issued link.
        toast({
          title: "Lien généré (copie manuelle)",
          description: data.portalUrl,
        });
      }
      invalidate();
      setCopyConfirmOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
      setCopyConfirmOpen(false);
    },
  });

  if (isLoading) return null;
  const token = data?.token ?? null;
  const isRevoked = !!token?.revokedAt;
  const isExpired = !!(token?.expiresAt && new Date(token.expiresAt).getTime() <= Date.now());
  const hasActiveLink = !!token && !isRevoked && !isExpired;
  const stateLabel = !token
    ? "Aucun lien émis"
    : isRevoked
      ? "Révoqué"
      : isExpired
        ? "Expiré"
        : "Actif";
  const stateColor = !token || isRevoked || isExpired
    ? "bg-slate-100 text-slate-600 border-slate-300"
    : "bg-emerald-50 text-emerald-700 border-emerald-200";

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-2.5 space-y-2"
      data-testid={`section-token-panel-${devisId}`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-slate-700">Lien contractant</span>
          <span
            className={`px-2 py-0.5 rounded-full border text-[9px] font-bold uppercase tracking-wide ${stateColor}`}
            data-testid={`status-token-${devisId}`}
          >
            {stateLabel}
          </span>
        </div>
        {!isArchived && (
          <div className="flex items-center gap-1.5">
            {/* Copier le lien — always available so the architect can grab a
                share URL even when no link has ever been emailed (e.g. to send
                via WhatsApp before the email round). Always rotates the token
                because raw values aren't recoverable from the hash, so we
                confirm first to make the impact explicit. */}
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[9px] font-bold uppercase tracking-widest gap-1"
              onClick={() => setCopyConfirmOpen(true)}
              disabled={copyMutation.isPending}
              data-testid={`button-copy-token-link-${devisId}`}
            >
              <Copy size={10} />
              {copyMutation.isPending ? "…" : "Copier le lien"}
            </Button>
            {token && !isRevoked && (
              <>
                {/* Prolonger only makes sense on a still-valid token. The backend
                    rejects extending an expired token with 409 (lapsed links must
                    be re-issued via Envoyer), so we hide the button to match. */}
                {!isExpired && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-[9px] font-bold uppercase tracking-widest"
                    onClick={() => extendMutation.mutate()}
                    disabled={extendMutation.isPending}
                    data-testid={`button-extend-token-${devisId}`}
                  >
                    {extendMutation.isPending ? "…" : "Prolonger"}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[9px] font-bold uppercase tracking-widest border-rose-300 text-rose-700 hover:bg-rose-50"
                  onClick={() => revokeMutation.mutate()}
                  disabled={revokeMutation.isPending}
                  data-testid={`button-revoke-token-${devisId}`}
                >
                  {revokeMutation.isPending ? "…" : "Révoquer"}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <AlertDialog open={copyConfirmOpen} onOpenChange={(o) => { if (!copyMutation.isPending) setCopyConfirmOpen(o); }}>
        <AlertDialogContent data-testid={`dialog-confirm-copy-token-${devisId}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {hasActiveLink ? "Régénérer et copier le lien ?" : "Émettre un nouveau lien ?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {hasActiveLink
                ? "Un nouveau lien sera généré et copié dans le presse-papiers. Le lien actif actuel cessera immédiatement de fonctionner — tout email déjà envoyé deviendra inopérant."
                : "Un lien contractant sera généré et copié dans le presse-papiers. Vous pourrez ensuite le partager via WhatsApp, SMS ou tout autre canal."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-copy-token-${devisId}`}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); copyMutation.mutate(); }}
              disabled={copyMutation.isPending}
              data-testid={`button-confirm-copy-token-${devisId}`}
            >
              {copyMutation.isPending ? "Génération…" : hasActiveLink ? "Régénérer et copier" : "Émettre et copier"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {token && (
        <div className="grid grid-cols-3 gap-2 text-[10px] text-slate-600">
          <div>
            <div className="text-slate-400 uppercase tracking-wide text-[9px]">Émis</div>
            <div data-testid={`text-token-created-${devisId}`}>{formatDateTime(token.createdAt)}</div>
          </div>
          <div>
            <div className="text-slate-400 uppercase tracking-wide text-[9px]">Dernier accès</div>
            <div data-testid={`text-token-last-used-${devisId}`}>{formatDateTime(token.lastUsedAt)}</div>
          </div>
          <div>
            <div className="text-slate-400 uppercase tracking-wide text-[9px]">
              {isRevoked ? "Révoqué" : "Expire"}
            </div>
            <div data-testid={`text-token-expires-${devisId}`}>
              {isRevoked
                ? formatDateTime(token.revokedAt)
                : token.expiresAt
                  ? formatDateTime(token.expiresAt)
                  : "Jamais"}
            </div>
          </div>
        </div>
      )}
      {!token && (
        <p className="text-[10px] text-slate-500" data-testid={`text-no-token-${devisId}`}>
          Aucun lien n'a encore été émis pour ce devis. Envoyez les questions à l'entreprise pour générer un lien.
        </p>
      )}
    </div>
  );
}

/**
 * AT2 client review portal panel — counterpart to TokenPanel for the
 * client side. The architect uses this to issue/rotate the client portal
 * token and obtain a shareable URL (copied to the clipboard) that they can
 * forward to the client by their preferred channel. v1 deliberately does
 * NOT auto-send an email; outbound webhooks are AT5 scope.
 */
type ClientCheckTokenInfo = {
  id: number;
  clientEmail: string;
  clientName: string | null;
  createdAt: string | Date | null;
  lastUsedAt: string | Date | null;
  expiresAt: string | Date | null;
  revokedAt: string | Date | null;
};

type ProjectClientContact = {
  id: number;
  clientName: string;
  clientContactName: string | null;
  clientContactEmail: string | null;
};

function ClientPortalPanel({
  devisId,
  projectId,
  isArchived,
}: {
  devisId: number;
  projectId: string;
  isArchived: boolean;
}) {
  const { toast } = useToast();
  const [issueOpen, setIssueOpen] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [emailErr, setEmailErr] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ token: ClientCheckTokenInfo | null }>({
    queryKey: ["/api/devis", devisId, "client-check-token"],
  });

  // Project lookup just to seed the dialog defaults from the AT1 sign-off
  // contact fields. Cached centrally so this doesn't fan out per-devis on
  // pages that already query the project.
  const { data: project } = useQuery<ProjectClientContact>({
    queryKey: ["/api/projects", projectId],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "client-check-token"] });
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "client-checks"] });
  };

  const issueMutation = useMutation({
    mutationFn: async (payload: { clientEmail: string; clientName?: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/devis/${devisId}/client-check-token/issue`,
        payload,
      );
      return res.json() as Promise<{ portalUrl: string; clientEmail: string; clientName: string | null }>;
    },
    onSuccess: async (resp) => {
      try {
        await navigator.clipboard.writeText(resp.portalUrl);
        toast({
          title: "Lien client copié",
          description: `Le lien pour ${resp.clientName ? resp.clientName + " " : ""}<${resp.clientEmail}> est dans le presse-papiers.`,
        });
      } catch {
        toast({
          title: "Lien client généré (copie manuelle)",
          description: resp.portalUrl,
        });
      }
      invalidate();
      setIssueOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const extendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/client-check-token/extend`, {});
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Lien client prolongé" }); },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const revokeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/client-check-token/revoke`, {});
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Lien client révoqué" }); },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  if (isLoading) return null;
  const token = data?.token ?? null;
  const isRevoked = !!token?.revokedAt;
  const isExpired = !!(token?.expiresAt && new Date(token.expiresAt).getTime() <= Date.now());
  const hasActiveLink = !!token && !isRevoked && !isExpired;
  const stateLabel = !token
    ? "Aucun lien émis"
    : isRevoked
      ? "Révoqué"
      : isExpired
        ? "Expiré"
        : "Actif";
  const stateColor = !token || isRevoked || isExpired
    ? "bg-slate-100 text-slate-600 border-slate-300"
    : "bg-emerald-50 text-emerald-700 border-emerald-200";

  function openIssueDialog() {
    setEmailDraft(token?.clientEmail ?? project?.clientContactEmail ?? "");
    setNameDraft(token?.clientName ?? project?.clientContactName ?? project?.clientName ?? "");
    setEmailErr(null);
    setIssueOpen(true);
  }

  function submitIssue() {
    const email = emailDraft.trim();
    const name = nameDraft.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setEmailErr("Adresse e-mail invalide");
      return;
    }
    setEmailErr(null);
    issueMutation.mutate({ clientEmail: email, clientName: name || undefined });
  }

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-2.5 space-y-2"
      data-testid={`section-client-portal-panel-${devisId}`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-slate-700">Lien client</span>
          <span
            className={`px-2 py-0.5 rounded-full border text-[9px] font-bold uppercase tracking-wide ${stateColor}`}
            data-testid={`status-client-token-${devisId}`}
          >
            {stateLabel}
          </span>
        </div>
        {!isArchived && (
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[9px] font-bold uppercase tracking-widest gap-1"
              onClick={() => {
                window.open(
                  `/api/devis/${devisId}/client-checks/portal-preview/shell`,
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
              data-testid={`button-preview-client-portal-${devisId}`}
            >
              <Eye size={10} />
              Aperçu côté client
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[9px] font-bold uppercase tracking-widest gap-1"
              onClick={openIssueDialog}
              disabled={issueMutation.isPending}
              data-testid={`button-send-to-client-${devisId}`}
            >
              <Send size={10} />
              {issueMutation.isPending ? "…" : "Envoyer au client"}
            </Button>
            {token && !isRevoked && !isExpired && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[9px] font-bold uppercase tracking-widest"
                onClick={() => extendMutation.mutate()}
                disabled={extendMutation.isPending}
                data-testid={`button-extend-client-token-${devisId}`}
              >
                {extendMutation.isPending ? "…" : "Prolonger"}
              </Button>
            )}
            {token && !isRevoked && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[9px] font-bold uppercase tracking-widest border-rose-300 text-rose-700 hover:bg-rose-50"
                onClick={() => revokeMutation.mutate()}
                disabled={revokeMutation.isPending}
                data-testid={`button-revoke-client-token-${devisId}`}
              >
                {revokeMutation.isPending ? "…" : "Révoquer"}
              </Button>
            )}
          </div>
        )}
      </div>

      {token && (
        <div className="grid grid-cols-3 gap-2 text-[10px] text-slate-600">
          <div>
            <div className="text-slate-400 uppercase tracking-wide text-[9px]">Destinataire</div>
            <div data-testid={`text-client-token-recipient-${devisId}`}>
              {token.clientName ? `${token.clientName} ` : ""}&lt;{token.clientEmail}&gt;
            </div>
          </div>
          <div>
            <div className="text-slate-400 uppercase tracking-wide text-[9px]">Dernier accès</div>
            <div data-testid={`text-client-token-last-used-${devisId}`}>{formatDateTime(token.lastUsedAt)}</div>
          </div>
          <div>
            <div className="text-slate-400 uppercase tracking-wide text-[9px]">
              {isRevoked ? "Révoqué" : "Expire"}
            </div>
            <div data-testid={`text-client-token-expires-${devisId}`}>
              {isRevoked
                ? formatDateTime(token.revokedAt)
                : token.expiresAt
                  ? formatDateTime(token.expiresAt)
                  : "Jamais"}
            </div>
          </div>
        </div>
      )}
      {!token && (
        <p className="text-[10px] text-slate-500" data-testid={`text-no-client-token-${devisId}`}>
          Aucun lien client n'a encore été émis pour ce devis. Cliquez sur « Envoyer au client » pour générer un lien à partager (e-mail / WhatsApp / SMS).
        </p>
      )}

      <Dialog open={issueOpen} onOpenChange={(o) => { if (!issueMutation.isPending) setIssueOpen(o); }}>
        <DialogContent data-testid={`dialog-send-to-client-${devisId}`}>
          <DialogHeader>
            <DialogTitle>
              {hasActiveLink ? "Régénérer et copier le lien client" : "Émettre un lien pour le client"}
            </DialogTitle>
            <DialogDescription>
              {hasActiveLink
                ? "Un nouveau lien sera généré et copié dans le presse-papiers. Le lien actif actuel cessera immédiatement de fonctionner."
                : "Renseignez l'adresse e-mail du client. Le lien sera copié dans votre presse-papiers — vous pourrez le partager via votre canal préféré (e-mail, WhatsApp, SMS)."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                Adresse e-mail du client
              </label>
              <Input
                type="email"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                placeholder="client@exemple.fr"
                data-testid={`input-client-email-${devisId}`}
                disabled={issueMutation.isPending}
                autoFocus
              />
              {emailErr && (
                <p className="text-[10px] text-rose-700" data-testid={`text-client-email-error-${devisId}`}>
                  {emailErr}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                Nom du client (optionnel)
              </label>
              <Input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Mme / M. Dupont"
                data-testid={`input-client-name-${devisId}`}
                disabled={issueMutation.isPending}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setIssueOpen(false)}
              disabled={issueMutation.isPending}
              data-testid={`button-cancel-send-to-client-${devisId}`}
            >
              Annuler
            </Button>
            <Button
              onClick={submitIssue}
              disabled={issueMutation.isPending}
              data-testid={`button-confirm-send-to-client-${devisId}`}
            >
              {issueMutation.isPending
                ? "Génération…"
                : hasActiveLink
                  ? "Régénérer et copier"
                  : "Émettre et copier"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =============================================================================
// Insurance gate panel (AT3, contract §1.3 + §2.1.4)
// =============================================================================

type InsuranceVerdictWire = {
  arm:
    | "live_ok"
    | "live_blocked"
    | "live_not_found"
    | "live_auth_error"
    | "live_transient"
    | "mirror_ok"
    | "mirror_blocked"
    | "mirror_unknown";
  proceed: boolean;
  overridable: boolean;
  reason: string;
  liveVerdictHttpStatus: number;
  liveVerdictCanProceed: boolean | null;
  liveVerdictResponse: unknown | null;
  mirrorStatus: string;
  mirrorSyncedAt: string;
  liveAttempted: boolean;
};

type InsuranceOverrideWire = {
  id: number;
  devisId: number;
  userId: number;
  overrideReason: string;
  mirrorStatusAtOverride: string;
  mirrorSyncedAtAtOverride: string;
  liveVerdictHttpStatus: number;
  liveVerdictCanProceed: boolean | null;
  liveVerdictResponse: unknown | null;
  overriddenByUserEmail: string;
  createdAt: string;
};

function InsurancePanel({
  devisId,
  isArchived,
}: {
  devisId: number;
  isArchived: boolean;
}) {
  const { toast } = useToast();
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");
  const [reasonErr, setReasonErr] = useState<string | null>(null);

  const verdictQuery = useQuery<InsuranceVerdictWire>({
    queryKey: ["/api/devis", devisId, "insurance-verdict"],
  });

  const overridesQuery = useQuery<InsuranceOverrideWire[]>({
    queryKey: ["/api/devis", devisId, "insurance-overrides"],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "insurance-verdict"] });
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "insurance-overrides"] });
  };

  const overrideMutation = useMutation({
    mutationFn: async () => {
      const v = verdictQuery.data;
      if (!v) throw new Error("Verdict indisponible");
      const res = await apiRequest("POST", `/api/devis/${devisId}/insurance-overrides`, {
        overrideReason: reasonDraft.trim(),
        liveVerdictHttpStatus: v.liveVerdictHttpStatus,
        liveVerdictCanProceed: v.liveVerdictCanProceed,
        liveVerdictResponse: v.liveVerdictResponse,
        mirrorStatusAtOverride: v.mirrorStatus,
        mirrorSyncedAtAtOverride: v.mirrorSyncedAt,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Override enregistré", description: "Le devis peut maintenant être envoyé au client." });
      setOverrideOpen(false);
      setReasonDraft("");
      invalidate();
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "insurance-verdict"] });
      // Wait for the refetch to land so the button visibly hands back control.
      await queryClient.refetchQueries({ queryKey: ["/api/devis", devisId, "insurance-verdict"] });
      return null;
    },
  });

  const verdict = verdictQuery.data;
  const overrides = overridesQuery.data ?? [];
  const latestOverride = overrides[0] ?? null;

  function openOverride() {
    setReasonDraft("");
    setReasonErr(null);
    setOverrideOpen(true);
  }

  function submitOverride() {
    const r = reasonDraft.trim();
    if (r.length < 10) {
      setReasonErr("Le motif doit comporter au moins 10 caractères.");
      return;
    }
    setReasonErr(null);
    overrideMutation.mutate();
  }

  const tone =
    !verdict
      ? { color: "bg-slate-100 text-slate-600 border-slate-300", label: "—" }
      : verdict.proceed
        ? { color: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "OK" }
        : verdict.overridable
          ? { color: "bg-amber-50 text-amber-700 border-amber-200", label: "Override possible" }
          : { color: "bg-rose-50 text-rose-700 border-rose-200", label: "Bloqué" };

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-2.5 space-y-2"
      data-testid={`section-insurance-panel-${devisId}`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <ShieldCheck size={12} className="text-slate-500" />
          <span className="text-[11px] font-semibold text-slate-700">Assurance contractant</span>
          <span
            className={`px-2 py-0.5 rounded-full border text-[9px] font-bold uppercase tracking-wide ${tone.color}`}
            data-testid={`status-insurance-verdict-${devisId}`}
          >
            {verdictQuery.isLoading ? "…" : tone.label}
          </span>
          {latestOverride && (
            <span
              className="px-2 py-0.5 rounded-full border text-[9px] font-bold uppercase tracking-wide bg-slate-100 text-slate-700 border-slate-300"
              data-testid={`status-insurance-override-${devisId}`}
              title={`Override par ${latestOverride.overriddenByUserEmail} le ${formatDateTime(latestOverride.createdAt)}`}
            >
              Override actif
            </span>
          )}
        </div>
        {!isArchived && (
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[9px] font-bold uppercase tracking-widest gap-1"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending || verdictQuery.isFetching}
              data-testid={`button-refresh-insurance-verdict-${devisId}`}
            >
              {refreshMutation.isPending || verdictQuery.isFetching ? "…" : "Vérifier"}
            </Button>
            {verdict && verdict.overridable && !latestOverride && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[9px] font-bold uppercase tracking-widest gap-1 border-amber-300 text-amber-800 hover:bg-amber-50"
                onClick={openOverride}
                data-testid={`button-open-insurance-override-${devisId}`}
              >
                <ShieldAlert size={10} />
                Forcer (override)
              </Button>
            )}
          </div>
        )}
      </div>

      {verdict && (
        <div className="grid grid-cols-3 gap-2 text-[10px] text-slate-600">
          <div>
            <div className="text-slate-400 uppercase tracking-wide text-[9px]">Verdict</div>
            <div data-testid={`text-insurance-verdict-reason-${devisId}`}>{verdict.reason}</div>
          </div>
          <div>
            <div className="text-slate-400 uppercase tracking-wide text-[9px]">Live HTTP</div>
            <div data-testid={`text-insurance-live-status-${devisId}`}>
              {verdict.liveAttempted
                ? `${verdict.liveVerdictHttpStatus || "—"}${
                    verdict.liveVerdictCanProceed === null ? "" : verdict.liveVerdictCanProceed ? " · OK" : " · refus"
                  }`
                : "non tenté"}
            </div>
          </div>
          <div>
            <div className="text-slate-400 uppercase tracking-wide text-[9px]">Mirror</div>
            <div data-testid={`text-insurance-mirror-status-${devisId}`}>{verdict.mirrorStatus}</div>
          </div>
        </div>
      )}

      {latestOverride && (
        <div className="rounded border border-slate-200 bg-slate-50 p-2 text-[10px] text-slate-600 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-700">Override</span>
            <span data-testid={`text-insurance-override-author-${devisId}`}>
              {latestOverride.overriddenByUserEmail}
            </span>
            <span className="text-slate-400">·</span>
            <span data-testid={`text-insurance-override-time-${devisId}`}>
              {formatDateTime(latestOverride.createdAt)}
            </span>
          </div>
          <div data-testid={`text-insurance-override-reason-${devisId}`}>{latestOverride.overrideReason}</div>
        </div>
      )}

      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
        <DialogContent className="max-w-lg" data-testid={`dialog-insurance-override-${devisId}`}>
          <DialogHeader>
            <DialogTitle>Forcer l'envoi malgré le verdict d'assurance</DialogTitle>
            <DialogDescription>
              Cet override sera enregistré au journal d'audit (immuable) avec l'instantané du verdict en cours et
              transmis tel quel au moment de la signature à Archidoc.
            </DialogDescription>
          </DialogHeader>
          {verdict && (
            <div className="space-y-2 text-[11px] text-slate-600">
              <div className="rounded border border-slate-200 bg-slate-50 p-2 space-y-1">
                <div className="flex justify-between gap-2">
                  <span className="text-slate-400 uppercase tracking-wide text-[9px]">Verdict live</span>
                  <span>
                    HTTP {verdict.liveVerdictHttpStatus} ·{" "}
                    {verdict.liveVerdictCanProceed === null
                      ? "—"
                      : verdict.liveVerdictCanProceed
                        ? "OK"
                        : "refus"}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-400 uppercase tracking-wide text-[9px]">Mirror local</span>
                  <span>
                    {verdict.mirrorStatus} · {formatDateTime(verdict.mirrorSyncedAt)}
                  </span>
                </div>
                <div className="text-slate-700">{verdict.reason}</div>
              </div>
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                  Motif d'override (obligatoire, ≥ 10 caractères)
                </span>
                <Textarea
                  value={reasonDraft}
                  onChange={(e) => setReasonDraft(e.target.value)}
                  rows={4}
                  placeholder="Ex. Contractant pré-validé hors workflow, attestation reçue ce matin par e-mail."
                  data-testid={`input-insurance-override-reason-${devisId}`}
                />
                {reasonErr && <div className="text-rose-600 text-[10px] mt-1">{reasonErr}</div>}
              </label>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setOverrideOpen(false)}
              data-testid={`button-cancel-insurance-override-${devisId}`}
            >
              Annuler
            </Button>
            <Button
              onClick={submitOverride}
              disabled={overrideMutation.isPending}
              data-testid={`button-submit-insurance-override-${devisId}`}
            >
              {overrideMutation.isPending ? "…" : "Enregistrer l'override"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * AT4 Signing panel — orchestrates the §1.2 transition
 * `approved_for_signing → sent_to_client` via the Archisign envelope flow.
 *
 * Visible at every stage from `approved_for_signing` onwards so the
 * architect can see envelope status, the access URL the client will use,
 * the OTP delivery target, and the envelope's expiry.
 *
 * The "Send to signer" button is only enabled when signOffStage is
 * exactly `approved_for_signing`. Once an envelope exists we show a
 * status badge instead. Soft-invalidated access URLs (after expiry) are
 * rendered struck-through with a "resend supported in a future update"
 * note — the resend-after-expiry orchestration is intentionally out of
 * scope for AT4 itself.
 */
function SigningPanel({
  devisId,
  isArchived,
}: {
  devisId: number;
  isArchived: boolean;
}) {
  const { toast } = useToast();
  const devisQuery = useQuery<Devis>({
    queryKey: ["/api/devis", devisId],
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/send-to-signer`);
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Envoyé à la signature",
        description: "L'enveloppe Archisign a été créée et envoyée au signataire.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur d'envoi", description: error.message, variant: "destructive" });
    },
  });

  const d = devisQuery.data as (Devis & {
    archisignEnvelopeId?: string | null;
    archisignAccessUrl?: string | null;
    archisignAccessUrlInvalidatedAt?: string | null;
    archisignEnvelopeStatus?: string | null;
    archisignEnvelopeExpiresAt?: string | null;
    archisignOtpDestination?: string | null;
  }) | undefined;

  if (devisQuery.isLoading || !d) {
    return (
      <LuxuryCard className="p-3" data-testid={`panel-signing-${devisId}`}>
        <Skeleton className="h-5 w-40 mb-2" />
        <Skeleton className="h-4 w-full" />
      </LuxuryCard>
    );
  }

  // Hide the panel entirely until the devis has been approved for
  // signing — earlier stages have nothing meaningful to show.
  const stage = d.signOffStage as string | null | undefined;
  const stagesShowingPanel = new Set([
    "approved_for_signing",
    "sent_to_client",
    "client_signed_off",
    "void",
  ]);
  if (!stage || !stagesShowingPanel.has(stage)) return null;

  const envelopeStatus = d.archisignEnvelopeStatus ?? null;
  const accessUrl = d.archisignAccessUrl ?? null;
  const accessUrlInvalidated = Boolean(d.archisignAccessUrlInvalidatedAt);
  const expiresAt = d.archisignEnvelopeExpiresAt ? new Date(d.archisignEnvelopeExpiresAt) : null;
  const otpDestination = d.archisignOtpDestination ?? null;

  // Gate logic — the CTA is available whenever the devis is in
  // `approved_for_signing` and not archived. This single condition naturally
  // covers all three reachable scenarios:
  //
  //   (a) FIRST SEND: no envelopeId, no accessUrl → /create + /send.
  //   (b) RESUME after a /send failure: POST /api/devis/:id/send-to-signer
  //       persists archisignEnvelopeId immediately after /create and BEFORE
  //       /send. If /send fails, the devis stays at stage
  //       `approved_for_signing` with envelopeId set; the endpoint is
  //       idempotent and resumes by re-calling /send. Gating on
  //       `!archisignEnvelopeId` would dead-end this recovery path.
  //   (c) POST-EXPIRY: handleExpired (§1.2) transitions the devis back to
  //       `approved_for_signing` and clears archisignEnvelopeId, so a click
  //       fires a fresh /create+/send. The historical accessUrl is kept
  //       struck-through alongside an "Lien expiré" note for audit context;
  //       AT4's brief excludes any *additional* resend-after-expiry
  //       orchestration (no new endpoints, no reminders), so the CTA
  //       reappearing IS the entire post-expiry surface.
  const canSend = stage === "approved_for_signing" && !isArchived;
  const isResume = canSend && !!d.archisignEnvelopeId;

  const statusLabel: Record<string, { label: string; tone: "default" | "secondary" | "destructive" }> = {
    sent: { label: "Envoyée", tone: "default" },
    viewed: { label: "Consultée", tone: "default" },
    queried: { label: "Question ouverte", tone: "secondary" },
    signed: { label: "Signée", tone: "default" },
    declined: { label: "Refusée", tone: "destructive" },
    expired: { label: "Expirée", tone: "destructive" },
  };
  const badge = envelopeStatus ? statusLabel[envelopeStatus] ?? { label: envelopeStatus, tone: "secondary" as const } : null;

  return (
    <LuxuryCard className="p-3 space-y-3" data-testid={`panel-signing-${devisId}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 text-[#0B2545]" />
          <TechnicalLabel className="text-sm">Signature électronique</TechnicalLabel>
          {badge && (
            <Badge
              variant={badge.tone === "destructive" ? "destructive" : badge.tone === "secondary" ? "secondary" : "default"}
              data-testid={`badge-archisign-status-${devisId}`}
            >
              {badge.label}
            </Badge>
          )}
        </div>
        {canSend && (
          <Button
            size="sm"
            onClick={() => sendMutation.mutate()}
            disabled={sendMutation.isPending}
            data-testid={`button-send-to-signer-${devisId}`}
          >
            {sendMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                {isResume ? "Reprise…" : "Envoi…"}
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-1.5" />
                {isResume ? "Réessayer l'envoi" : "Envoyer à la signature"}
              </>
            )}
          </Button>
        )}
      </div>

      {!d.archisignEnvelopeId && !accessUrl && stage === "approved_for_signing" && (
        <p className="text-xs text-muted-foreground" data-testid={`text-signing-empty-${devisId}`}>
          Aucune enveloppe Archisign créée. Le client recevra un lien de signature après envoi.
        </p>
      )}

      {/*
        Render the URL/envelope details block whenever EITHER an envelope is
        currently active OR a historical accessUrl is preserved. After an
        envelope.expired webhook, archisignEnvelopeId is nulled (so the
        Send-to-signer CTA re-arms) but archisignAccessUrl + invalidatedAt
        remain so the architect still sees the crossed-out link with the
        expiry note. Without this OR-gate, the historical link would
        disappear silently and the architect would lose context.
      */}
      {(d.archisignEnvelopeId || accessUrl) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div>
            <span className="font-semibold text-muted-foreground">Lien client :</span>{" "}
            {accessUrl ? (
              <a
                href={accessUrl}
                target="_blank"
                rel="noreferrer noopener"
                className={
                  accessUrlInvalidated
                    ? "line-through text-muted-foreground"
                    : "text-[#0B2545] underline hover:no-underline inline-flex items-center gap-1"
                }
                data-testid={`link-archisign-access-${devisId}`}
              >
                Ouvrir
                {!accessUrlInvalidated && <ExternalLink className="h-3 w-3" />}
              </a>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
            {accessUrlInvalidated && (
              <div
                className="mt-1 text-[11px] text-amber-700"
                data-testid={`text-archisign-expired-note-${devisId}`}
              >
                Lien expiré — la fonction de renvoi sera disponible dans une prochaine mise à jour.
              </div>
            )}
          </div>
          <div>
            <span className="font-semibold text-muted-foreground">Destination OTP :</span>{" "}
            <span data-testid={`text-archisign-otp-${devisId}`}>{otpDestination ?? "—"}</span>
          </div>
          <div>
            <span className="font-semibold text-muted-foreground">Expire le :</span>{" "}
            <span data-testid={`text-archisign-expires-${devisId}`}>
              {expiresAt ? expiresAt.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
            </span>
          </div>
          <div>
            <span className="font-semibold text-muted-foreground">Enveloppe :</span>{" "}
            <span
              className="font-mono text-[11px]"
              data-testid={`text-archisign-envelope-${devisId}`}
            >
              {d.archisignEnvelopeId ?? "—"}
            </span>
          </div>
        </div>
      )}
    </LuxuryCard>
  );
}

function ChecksPanel({
  devisId,
  projectId,
  isArchived,
  contractorEmail,
  lineItems,
}: {
  devisId: number;
  projectId: string;
  isArchived: boolean;
  contractorEmail: string | null;
  lineItems: DevisLineItem[];
}) {
  const { toast } = useToast();
  const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({});

  const { data: checks = [], isLoading } = useQuery<CheckWithMessages[]>({
    queryKey: ["/api/devis", devisId, "checks"],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "checks"] });
    queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis-checks", "open-counts"] });
  };

  // Variant B models a single editable general question. Multiple historical
  // general checks may exist (older or post-conversation), but only ONE 'open'
  // general draft is editable in the bottom mirror at a time. We persist the
  // textarea by debounced blur: PATCH if a draft already exists, POST to
  // create one if not, drop it if cleared.
  const openGeneralCheck = checks.find((c) => c.status === "open" && c.origin === "general") ?? null;
  const [generalDraft, setGeneralDraft] = useState<string>(openGeneralCheck?.query ?? "");
  const [generalDirty, setGeneralDirty] = useState(false);
  // Resync the editor when the server's open general check changes (e.g.
  // after send → status becomes awaiting_contractor → openGeneralCheck flips
  // to null → editor should clear). Skip while user is mid-edit.
  useEffect(() => {
    if (!generalDirty) {
      setGeneralDraft(openGeneralCheck?.query ?? "");
    }
  }, [openGeneralCheck?.id, openGeneralCheck?.query, generalDirty]);

  const createGeneralMutation = useMutation({
    mutationFn: async (query: string) => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/checks`, { query });
      return res.json();
    },
    onSuccess: () => { invalidate(); setGeneralDirty(false); },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const updateGeneralMutation = useMutation({
    mutationFn: async ({ checkId, query }: { checkId: number; query: string }) => {
      const res = await apiRequest("PATCH", `/api/devis-checks/${checkId}`, { query });
      return res.json();
    },
    onSuccess: () => { invalidate(); setGeneralDirty(false); },
    onError: (error: Error) => toast({ title: "Impossible d'enregistrer la question", description: error.message, variant: "destructive" }),
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/checks/send`, {});
      return res.json();
    },
    onSuccess: (data: { checksSent: number; reused: boolean }) => {
      invalidate();
      toast({
        title: data.reused ? "Email déjà envoyé" : "Email envoyé",
        description: `${data.checksSent} question(s) — l'entreprise reçoit le lien portail.`,
      });
    },
    onError: (error: Error) => toast({ title: "Erreur d'envoi", description: error.message, variant: "destructive" }),
  });

  const replyMutation = useMutation({
    mutationFn: async ({ checkId, body }: { checkId: number; body: string }) => {
      const res = await apiRequest("POST", `/api/devis-checks/${checkId}/messages`, { body });
      return res.json();
    },
    onSuccess: (_d, vars) => {
      setReplyDrafts((p) => ({ ...p, [vars.checkId]: "" }));
      invalidate();
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const resolveMutation = useMutation({
    mutationFn: async (checkId: number) => {
      const res = await apiRequest("POST", `/api/devis-checks/${checkId}/resolve`, {});
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Question clôturée" }); },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const dropMutation = useMutation({
    mutationFn: async (checkId: number) => {
      const res = await apiRequest("POST", `/api/devis-checks/${checkId}/drop`, {});
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Question abandonnée" }); },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  if (isLoading) return null;

  // Variant B partitions checks into the "drafts going out next" set
  // (status='open' — included in the bottom-mirror digest) and the
  // "post-send conversations" set (awaiting_*/resolved — rendered as
  // chronological cards beneath the mirror). 'dropped' is hidden entirely.
  const openLineChecks = checks.filter((c) => c.status === "open" && c.origin === "line_item");
  const conversationChecks = checks.filter((c) => c.status === "awaiting_contractor" || c.status === "awaiting_architect" || c.status === "resolved");
  // Drafts shown in the bottom-mirror digest = strictly status='open'.
  const openCount = openLineChecks.length + (openGeneralCheck ? 1 : 0);
  // Sendable mirrors the backend bundle filter: every unresolved check
  // participates in a follow-up email round, including awaiting_contractor
  // (which the architect's follow-up message still needs to push back out)
  // and awaiting_architect (renotification scenarios). Computing this from
  // 'open' alone would silently disable the CTA for follow-up rounds.
  const sendableCount = checks.filter((c) => c.status === "open" || c.status === "awaiting_contractor" || c.status === "awaiting_architect").length;

  const lineByItemId = new Map<number, DevisLineItem>();
  for (const li of lineItems) lineByItemId.set(li.id, li);

  // Persist the general-question textarea on blur. Empty + existing draft →
  // drop the check. Non-empty + no draft → create. Non-empty + existing draft →
  // PATCH only if changed.
  const commitGeneralDraft = () => {
    const trimmed = generalDraft.trim();
    if (openGeneralCheck) {
      if (!trimmed) {
        dropMutation.mutate(openGeneralCheck.id);
      } else if (trimmed !== openGeneralCheck.query) {
        updateGeneralMutation.mutate({ checkId: openGeneralCheck.id, query: trimmed });
      } else {
        setGeneralDirty(false);
      }
    } else if (trimmed) {
      createGeneralMutation.mutate(trimmed);
    } else {
      setGeneralDirty(false);
    }
  };

  return (
    <div className="space-y-3">
      <LapsingTokenBanner devisId={devisId} isArchived={isArchived} />
      <TokenPanel devisId={devisId} projectId={projectId} isArchived={isArchived} />
      <ClientPortalPanel devisId={devisId} projectId={projectId} isArchived={isArchived} />
      <InsurancePanel devisId={devisId} isArchived={isArchived} />
      <SigningPanel devisId={devisId} isArchived={isArchived} />

      {/* Bottom mirror — variant B "Inline composer + bottom mirror".
          Navy-bordered card showing the architect exactly what will be
          packaged and sent to the contractor in the next email round. */}
      <div
        className="rounded-xl border-2 p-3 space-y-3 bg-white"
        style={{ borderColor: "#0B2545" }}
        data-testid={`section-checks-${devisId}`}
      >
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {openCount > 0 ? (
              <span
                className="px-2 py-0.5 rounded-full text-white text-[9px] font-bold uppercase tracking-widest"
                style={{ backgroundColor: "#0B2545" }}
                data-testid={`pill-pret-a-envoyer-${devisId}`}
              >
                Prêt à envoyer
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[9px] font-bold uppercase tracking-widest">
                Aucune question en cours
              </span>
            )}
            <h3
              className="text-[12px] font-bold uppercase tracking-widest"
              style={{ color: "#0B2545" }}
              data-testid={`heading-checks-${devisId}`}
            >
              Communications avec l'entreprise
            </h3>
            <span className="text-[11px] font-semibold text-slate-600" data-testid={`text-open-checks-count-${devisId}`}>
              {openCount === 0 ? "" : `· ${openCount} question(s)`}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[9px] font-bold uppercase tracking-widest gap-1"
                    disabled={openCount === 0}
                    onClick={() => {
                      window.open(
                        `/api/devis/${devisId}/checks/portal-preview/shell`,
                        "_blank",
                        "noopener,noreferrer",
                      );
                    }}
                    data-testid={`button-preview-portal-${devisId}`}
                  >
                    <Eye size={12} />
                    Aperçu côté entreprise
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                {openCount === 0
                  ? "Ajoutez une question pour prévisualiser le portail"
                  : "Voir exactement ce que l'entreprise verra (lecture seule)"}
              </TooltipContent>
            </Tooltip>
            <Button
              size="sm"
              className="h-7 text-[9px] font-bold uppercase tracking-widest gap-1 text-white"
              style={{ backgroundColor: "#0B2545" }}
              disabled={isArchived || sendableCount === 0 || sendMutation.isPending}
              onClick={() => sendMutation.mutate()}
              data-testid={`button-send-checks-${devisId}`}
            >
              <Send size={11} />
              {sendMutation.isPending ? "Envoi…" : `Envoyer à l'entreprise (${sendableCount})`}
            </Button>
          </div>
        </div>

        {openCount > 0 && (
          <p className="text-[10px] text-slate-500" data-testid={`text-send-target-${devisId}`}>
            Voici ce qui partira à{" "}
            <span className="font-semibold text-slate-700">
              {contractorEmail || "(adresse entreprise manquante)"}
            </span>
            {" "}:
          </p>
        )}

        {/* Line questions — rose bullets (variant B style). Read-only digest
            of each draft; the editable composer lives inline next to the
            line item itself (see LineItemWithCheck popover). */}
        {openLineChecks.length > 0 && (
          <ul className="space-y-1.5" data-testid={`list-open-line-checks-${devisId}`}>
            {openLineChecks.map((c) => {
              const li = c.lineItemId != null ? lineByItemId.get(c.lineItemId) : undefined;
              const lineLabel = li ? `Ligne ${li.lineNumber} · ${li.description.slice(0, 40)}${li.description.length > 40 ? "…" : ""}` : "Ligne supprimée";
              return (
                <li key={c.id} className="flex items-start gap-2 text-[11px]" data-testid={`mirror-line-check-${c.id}`}>
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[9px] font-bold uppercase tracking-widest text-rose-700">{lineLabel}</div>
                    <div className="text-slate-700 whitespace-pre-wrap">{c.query}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* General question — single editable textarea. PATCH if existing
            open draft, POST to create, drop if cleared. */}
        {!isArchived && (
          <div className="flex items-start gap-2" data-testid={`section-general-check-${devisId}`}>
            <span className="mt-2.5 w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
            <div className="flex-1">
              <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-0.5">
                Question générale (non liée à une ligne)
              </div>
              <Textarea
                className="text-[11px] min-h-[36px] bg-white"
                placeholder="Ajouter une question générale…"
                value={generalDraft}
                onChange={(e) => { setGeneralDraft(e.target.value); setGeneralDirty(true); }}
                onBlur={commitGeneralDraft}
                disabled={createGeneralMutation.isPending || updateGeneralMutation.isPending}
                data-testid={`textarea-general-check-${devisId}`}
              />
            </div>
          </div>
        )}
        {isArchived && openGeneralCheck && (
          <div className="flex items-start gap-2 text-[11px]" data-testid={`mirror-general-check-${openGeneralCheck.id}`}>
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
            <div className="flex-1">
              <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Question générale</div>
              <div className="text-slate-700 whitespace-pre-wrap">{openGeneralCheck.query}</div>
            </div>
          </div>
        )}
      </div>

      {/* Conversation threads — checks already sent to (or replied by) the
          contractor. Less visually prominent than the bottom mirror; this is
          where ongoing back-and-forth lives. */}
      {conversationChecks.length > 0 && (
        <div className="space-y-2" data-testid={`section-conversations-${devisId}`}>
          <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500 px-1">
            Conversations en cours
          </div>
          {conversationChecks.map((c) => (
            <div key={c.id} className="rounded-lg border border-slate-200 bg-white p-2.5 space-y-2" data-testid={`check-${c.id}`}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-[12px] text-slate-800 flex-1">{c.query}</p>
                <span className={`px-2 py-0.5 rounded-full border text-[9px] font-bold uppercase tracking-wide ${CHECK_STATUS_COLOR[c.status] || "bg-slate-100"}`} data-testid={`status-check-${c.id}`}>
                  {CHECK_STATUS_LABEL[c.status] || c.status}
                </span>
              </div>
              {c.messages.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {c.messages.map((m) => (
                    <div key={m.id} className={`text-[11px] rounded p-1.5 ${m.authorType === "contractor" ? "bg-emerald-50 border border-emerald-200" : "bg-slate-50 border border-slate-200"}`}>
                      <div className="text-[9px] font-semibold text-slate-500 mb-0.5">{m.authorType === "contractor" ? (m.authorName || "Entreprise") : "Vous"}</div>
                      <div className="whitespace-pre-wrap">{m.body}</div>
                    </div>
                  ))}
                </div>
              )}
              {c.status !== "resolved" && !isArchived && (
                <div className="flex flex-col gap-1.5">
                  <Textarea
                    className="text-[11px] min-h-[50px]"
                    placeholder="Ajouter un message…"
                    value={replyDrafts[c.id] ?? ""}
                    onChange={(e) => setReplyDrafts((p) => ({ ...p, [c.id]: e.target.value }))}
                    data-testid={`textarea-architect-reply-${c.id}`}
                  />
                  <div className="flex items-center justify-between gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[9px] text-slate-500 hover:text-rose-600"
                      onClick={() => dropMutation.mutate(c.id)}
                      disabled={dropMutation.isPending}
                      data-testid={`button-drop-check-${c.id}`}
                    >
                      Abandonner
                    </Button>
                    <div className="flex items-center gap-1.5">
                      {c.status === "awaiting_architect" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[9px] border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                          onClick={() => resolveMutation.mutate(c.id)}
                          disabled={resolveMutation.isPending}
                          data-testid={`button-resolve-check-${c.id}`}
                        >
                          Clôturer
                        </Button>
                      )}
                      <Button
                        size="sm"
                        className="h-6 text-[9px]"
                        onClick={() => {
                          const body = (replyDrafts[c.id] ?? "").trim();
                          if (!body) return;
                          replyMutation.mutate({ checkId: c.id, body });
                        }}
                        disabled={!((replyDrafts[c.id] ?? "").trim()) || replyMutation.isPending}
                        data-testid={`button-architect-reply-${c.id}`}
                      >
                        Répondre
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DevisDetailTabs({
  devis,
  lineItems,
  translationLineItems,
  avenants,
  invoices,
  isArchived,
  onOpenAvenantDialog,
  onOpenInvoiceUpload,
  onAddLineItem,
  onUpdateLineItem,
}: {
  devis: Devis;
  lineItems: DevisLineItem[] | undefined;
  translationLineItems: DevisLineItem[] | undefined;
  avenants: Avenant[] | undefined;
  invoices: Invoice[] | undefined;
  isArchived: boolean;
  onOpenAvenantDialog: () => void;
  onOpenInvoiceUpload: () => void;
  onAddLineItem: () => void;
  onUpdateLineItem: (id: number, data: Record<string, string>) => Promise<unknown>;
}) {
  const isModeB = devis.invoicingMode === "mode_b";
  const lineCount = lineItems?.length ?? 0;
  const avenantCount = avenants?.length ?? 0;
  const invoiceCount = invoices?.length ?? 0;

  const { data: translation } = useQuery<{ status: string }>({
    queryKey: ["/api/devis", devis.id, "translation"],
  });
  const translationStatus = translation?.status ?? "missing";

  // Fetch open checks once at this level so each LineItemWithCheck can render
  // its rose "Question rédigée" pill and pre-seed the inline-popover editor
  // with the server's auto-suggested text. Single query + per-row Map lookup
  // avoids N requests when there are many flagged lines.
  const { data: checksForLines = [] } = useQuery<CheckWithMessages[]>({
    queryKey: ["/api/devis", devis.id, "checks"],
  });
  const openLineCheckMap = new Map<number, { id: number; query: string }>();
  for (const c of checksForLines) {
    if (c.status === "open" && c.origin === "line_item" && c.lineItemId != null) {
      openLineCheckMap.set(c.lineItemId, { id: c.id, query: c.query });
    }
  }

  // PATCH the editable draft text from the inline popover. 409 (already sent
  // to contractor) and 404 (drop race) surface as toasts; the row component
  // handles user-facing errors.
  const saveCheckQueryMutation = useMutation({
    mutationFn: async ({ checkId, query }: { checkId: number; query: string }) => {
      const res = await apiRequest("PATCH", `/api/devis-checks/${checkId}`, { query });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "checks"] });
    },
  });

  const defaultTab = isModeB ? "lines" : "avenants";

  return (
    <Tabs defaultValue={defaultTab} className="rounded-2xl border border-[#0B2545]/15 bg-white/60 overflow-hidden" data-testid={`tabs-devis-detail-${devis.id}`}>
      <TabsList className="w-full justify-start rounded-none border-b border-black/5 bg-[#0B2545]/[0.03] px-2 h-auto p-0">
        {isModeB && (
          <TabsTrigger
            value="lines"
            className="gap-2 px-3 py-2.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground data-[state=active]:text-[#0B2545] data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-[#0B2545] rounded-none"
            data-testid={`tab-lines-${devis.id}`}
          >
            <ListOrdered size={13} />
            Line Items
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-700 data-[state=active]:bg-[#0B2545] data-[state=active]:text-white">{lineCount}</span>
          </TabsTrigger>
        )}
        <TabsTrigger
          value="translation"
          className="gap-2 px-3 py-2.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground data-[state=active]:text-[#0B2545] data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-[#0B2545] rounded-none"
          data-testid={`tab-translation-${devis.id}`}
        >
          <Languages size={13} />
          Translation
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-700">{translationStatus.toUpperCase()}</span>
        </TabsTrigger>
        <TabsTrigger
          value="avenants"
          className="gap-2 px-3 py-2.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground data-[state=active]:text-[#0B2545] data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-[#0B2545] rounded-none"
          data-testid={`tab-avenants-${devis.id}`}
        >
          <FilePlus2 size={13} />
          Avenants
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-700">{avenantCount}</span>
        </TabsTrigger>
        <TabsTrigger
          value="invoices"
          className="gap-2 px-3 py-2.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground data-[state=active]:text-[#0B2545] data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-[#0B2545] rounded-none"
          data-testid={`tab-invoices-${devis.id}`}
        >
          <Receipt size={13} />
          Invoices
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-700">{invoiceCount}</span>
        </TabsTrigger>
      </TabsList>

      {isModeB && (
        <TabsContent value="lines" className="p-4 mt-0">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[12px] font-black uppercase tracking-tight text-foreground">
              Devis Line Items ({lineCount})
            </h4>
            <Button variant="outline" size="sm" onClick={onAddLineItem} disabled={isArchived} data-testid={`button-add-line-${devis.id}`}>
              <Plus size={12} />
              <span className="text-[8px] font-bold uppercase tracking-widest">Line Item</span>
            </Button>
          </div>
          {lineItems && lineItems.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-[rgba(0,0,0,0.08)]">
                    <th className="text-left py-1 px-2 font-black uppercase tracking-widest text-[8px]">#</th>
                    <th className="text-left py-1 px-2 font-black uppercase tracking-widest text-[8px]">Description</th>
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Qty</th>
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Unit Price</th>
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Total HT</th>
                    <th className="text-right py-1 px-2 font-black uppercase tracking-widest text-[8px]">Progress %</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li) => (
                    <LineItemWithCheck
                      key={li.id}
                      li={li}
                      devisId={devis.id}
                      openCheck={openLineCheckMap.get(li.id) ?? null}
                      onSaveCheckQuery={(checkId, query) => saveCheckQueryMutation.mutateAsync({ checkId, query })}
                      onUpdate={(data) => onUpdateLineItem(li.id, data)}
                      disabled={isArchived}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground text-center py-4">No line items yet.</p>
          )}
        </TabsContent>
      )}

      <TabsContent value="translation" className="p-4 mt-0">
        <DevisTranslationSection
          devisId={devis.id}
          devisCode={devis.devisCode}
          lineItems={translationLineItems ?? []}
        />
      </TabsContent>

      <TabsContent value="avenants" className="p-4 mt-0">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[12px] font-black uppercase tracking-tight text-foreground">
            Avenants ({avenantCount})
          </h4>
          <Button variant="outline" size="sm" onClick={onOpenAvenantDialog} disabled={isArchived} data-testid={`button-add-avenant-${devis.id}`}>
            <Plus size={12} />
            <span className="text-[8px] font-bold uppercase tracking-widest">Avenant</span>
          </Button>
        </div>
        {avenants && avenants.length > 0 ? (
          <div className="space-y-2">
            {avenants.map((a) => (
              <div key={a.id} className="flex items-center justify-between p-2 rounded-xl border border-[rgba(0,0,0,0.06)] bg-white/30" data-testid={`row-avenant-${a.id}`}>
                <div className="flex items-center gap-2">
                  {a.type === "pv" ? <ArrowUpRight size={12} className="text-emerald-600" /> : <ArrowDownRight size={12} className="text-rose-500" />}
                  <span className="text-[11px]">{a.descriptionFr}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[12px] font-semibold ${a.type === "pv" ? "text-emerald-600" : "text-rose-500"}`}>
                    {a.type === "pv" ? "+" : "-"}{formatCurrency(parseFloat(a.amountHt))}
                  </span>
                  <StatusBadge status={a.status} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground text-center py-2">No avenants.</p>
        )}
      </TabsContent>

      <TabsContent value="invoices" className="p-4 mt-0">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[12px] font-black uppercase tracking-tight text-foreground">
            Invoices ({invoiceCount})
          </h4>
          <Button variant="outline" size="sm" onClick={onOpenInvoiceUpload} disabled={isArchived} data-testid={`button-upload-invoice-${devis.id}`}>
            <Upload size={12} />
            <span className="text-[8px] font-bold uppercase tracking-widest">Upload Invoice</span>
          </Button>
        </div>
        {invoices && invoices.length > 0 ? (
          <div className="space-y-2">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between p-2 rounded-xl border border-[rgba(0,0,0,0.06)] bg-white/30" data-testid={`row-invoice-${inv.id}`}>
                <div className="flex items-center gap-2">
                  <FileText size={12} className="text-muted-foreground" />
                  <span className="text-[11px]">Invoice #{inv.invoiceNumber}</span>
                  {inv.certificateNumber && <TechnicalLabel>Cert: {inv.certificateNumber}</TechnicalLabel>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold text-foreground">{formatCurrency(parseFloat(inv.amountHt))}</span>
                  <StatusBadge status={inv.status} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground text-center py-2">No invoices.</p>
        )}
      </TabsContent>
    </Tabs>
  );
}

function DevisDetailInline({ devis, projectId, contractors, lots, isArchived = false, onOpenInvoiceUpload, onOpenAvenantDialog, onOpenPdfPopout, hasPdf }: { devis: Devis; projectId: string; contractors: Contractor[]; lots: Lot[]; isArchived?: boolean; onOpenInvoiceUpload: () => void; onOpenAvenantDialog: () => void; onOpenPdfPopout: () => void; hasPdf: boolean }) {
  const { toast } = useToast();
  const [lineItemDialogOpen, setLineItemDialogOpen] = useState(false);
  const [addingNewLot, setAddingNewLot] = useState(false);
  const [newLotNumber, setNewLotNumber] = useState("");
  const [newLotDescription, setNewLotDescription] = useState("");
  const [newLotDescriptionUk, setNewLotDescriptionUk] = useState("");
  const [suggestingLotUk, setSuggestingLotUk] = useState(false);
  const [descriptionUkLocal, setDescriptionUkLocal] = useState(devis.descriptionUk || "");
  const [rescrapeConfirmOpen, setRescrapeConfirmOpen] = useState(false);

  const rescrapeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devis.id}/rescrape`, {});
      return res.json();
    },
    onSuccess: (data: { extraction?: { lineItemsExtracted?: number; lineItemsCreated?: number } }) => {
      setRescrapeConfirmOpen(false);
      const created = data?.extraction?.lineItemsCreated ?? 0;
      const extracted = data?.extraction?.lineItemsExtracted ?? 0;
      toast({
        title: "Devis re-scraped",
        description:
          extracted > 0
            ? `Refreshed ${created} of ${extracted} line item${extracted === 1 ? "" : "s"} from the PDF.`
            : "Re-scraped, but the AI did not return any line items.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "line-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "translation"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Re-scrape failed",
        description: err instanceof ApiError ? (err.data as { message?: string } | null)?.message ?? err.message : err.message,
        variant: "destructive",
      });
    },
  });

  const { data: invoices } = useQuery<Invoice[]>({
    queryKey: ["/api/devis", devis.id, "invoices"],
  });
  const { data: avenants } = useQuery<Avenant[]>({
    queryKey: ["/api/devis", devis.id, "avenants"],
  });
  const { data: lineItems } = useQuery<DevisLineItem[]>({
    queryKey: ["/api/devis", devis.id, "line-items"],
    enabled: devis.invoicingMode === "mode_b",
  });
  const { data: translationLineItems } = useQuery<DevisLineItem[]>({
    queryKey: ["/api/devis", devis.id, "line-items"],
  });

  const originalHt = parseFloat(devis.amountHt);
  const originalTtc = parseFloat(devis.amountTtc);
  const approvedAvenants = (avenants ?? []).filter((a) => a.status === "approved");
  const pvTotal = approvedAvenants.filter((a) => a.type === "pv").reduce((s, a) => s + parseFloat(a.amountHt), 0);
  const mvTotal = approvedAvenants.filter((a) => a.type === "mv").reduce((s, a) => s + parseFloat(a.amountHt), 0);
  const pvTotalTtc = approvedAvenants.filter((a) => a.type === "pv").reduce((s, a) => s + parseFloat(a.amountTtc), 0);
  const mvTotalTtc = approvedAvenants.filter((a) => a.type === "mv").reduce((s, a) => s + parseFloat(a.amountTtc), 0);
  const adjustedHt = originalHt + pvTotal - mvTotal;
  const adjustedTtc = originalTtc + pvTotalTtc - mvTotalTtc;
  const invoicedHt = (invoices ?? []).reduce((s, i) => s + parseFloat(i.amountHt), 0);
  const invoicedTtc = (invoices ?? []).reduce((s, i) => s + parseFloat(i.amountTtc), 0);
  const remainingHt = adjustedHt - invoicedHt;
  const remainingTtc = adjustedTtc - invoicedTtc;
  const progress = adjustedHt > 0 ? Math.min((invoicedHt / adjustedHt) * 100, 100) : 0;

  const lineItemForm = useForm<z.infer<typeof lineItemFormSchema>>({
    resolver: zodResolver(lineItemFormSchema),
    defaultValues: {
      devisId: devis.id,
      lineNumber: (lineItems?.length ?? 0) + 1,
      description: "",
      quantity: "1",
      unit: "u",
      unitPriceHt: "0.00",
      totalHt: "0.00",
      percentComplete: "0",
    },
  });

  const createLineItemMutation = useMutation({
    mutationFn: async (data: z.infer<typeof lineItemFormSchema>) => {
      const res = await apiRequest("POST", `/api/devis/${devis.id}/line-items`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "line-items"] });
      setLineItemDialogOpen(false);
      lineItemForm.reset();
      toast({ title: "Line item added" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateLineItemMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number; [key: string]: any }) => {
      const res = await apiRequest("PATCH", `/api/line-items/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id, "line-items"] });
    },
  });

  const updateDevisMutation = useMutation({
    mutationFn: async (data: Record<string, string | null>) => {
      const res = await apiRequest("PATCH", `/api/devis/${devis.id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devis.id] });
    },
  });

  const { data: lotCatalog = [] } = useQuery<LotCatalog[]>({
    queryKey: ["/api/lot-catalog"],
  });

  const assignFromCatalogMutation = useMutation({
    mutationFn: async (catalogCode: string) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/lots/assign-from-catalog`, {
        catalogCode,
        devisId: devis.id,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "lots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "financial-summary"] });
      toast({ title: "Lot assigned" });
    },
    onError: (error: Error) => {
      toast({ title: "Error assigning lot", description: error.message, variant: "destructive" });
    },
  });

  const createCatalogLotMutation = useMutation({
    mutationFn: async (data: { code: string; descriptionFr: string; descriptionUk?: string | null }) => {
      const res = await apiRequest("POST", `/api/lot-catalog`, data);
      return res.json();
    },
    onSuccess: (newEntry: LotCatalog) => {
      queryClient.invalidateQueries({ queryKey: ["/api/lot-catalog"] });
      assignFromCatalogMutation.mutate(newEntry.code);
      setAddingNewLot(false);
      setNewLotNumber("");
      setNewLotDescription("");
      setNewLotDescriptionUk("");
      toast({ title: "Lot added to master list and assigned" });
    },
    onError: (error: Error) => {
      toast({ title: "Error creating lot", description: error.message, variant: "destructive" });
    },
  });

  const suggestLotUkMutation = useMutation({
    mutationFn: async (data: { descriptionFr: string; code?: string }) => {
      const res = await apiRequest("POST", "/api/lot-catalog/translate", data);
      return (await res.json()) as { translation: string };
    },
    onError: (error: Error) => {
      toast({ title: "Could not suggest translation", description: error.message, variant: "destructive" });
    },
  });

  const handleSuggestNewLotUk = async () => {
    const fr = newLotDescription.trim();
    if (!fr) return;
    setSuggestingLotUk(true);
    try {
      const result = await suggestLotUkMutation.mutateAsync({ descriptionFr: fr, code: newLotNumber.trim() || undefined });
      if (result?.translation) setNewLotDescriptionUk(result.translation);
    } catch {
      // handled in onError
    } finally {
      setSuggestingLotUk(false);
    }
  };

  const currentLot = devis.lotId ? lots.find(l => l.id === devis.lotId) : undefined;
  const currentCatalogCode = currentLot?.lotNumber ?? "";

  const [voidDialogOpen, setVoidDialogOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");

  const recalcLineTotal = () => {
    const qty = parseFloat(lineItemForm.watch("quantity") || "0");
    const price = parseFloat(lineItemForm.watch("unitPriceHt") || "0");
    lineItemForm.setValue("totalHt", (qty * price).toFixed(2));
  };

  const isVoid = devis.status === "void";
  const missingLot = !devis.lotId;
  const missingDescriptionUk = !devis.descriptionUk || devis.descriptionUk.trim() === "";
  const signOffBlocked = missingLot || missingDescriptionUk;

  const SIGN_OFF_STAGES = [
    { key: "received", label: "Received" },
    { key: "checked_internal", label: "Checked Internally" },
    { key: "approved_for_signing", label: "Approved for Signing" },
    { key: "sent_to_client", label: "Sent to Client" },
    { key: "client_signed_off", label: "Client Signed Off" },
  ];
  const currentStageIndex = SIGN_OFF_STAGES.findIndex(s => s.key === devis.signOffStage);
  const SENT_TO_CLIENT_INDEX = SIGN_OFF_STAGES.findIndex(s => s.key === "sent_to_client");
  // Open checks must be cleared before the architect can advance the devis to
  // 'sent_to_client' or beyond. The server enforces this with a 409, but we
  // also surface the lock visually on the stepper button.
  const { data: openChecksCountForDevis = 0 } = useQuery<number>({
    queryKey: ["/api/devis", devis.id, "checks", "open-count"],
    queryFn: async () => {
      const res = await fetch(`/api/devis/${devis.id}/checks`);
      if (!res.ok) return 0;
      const list: Array<{ status: string }> = await res.json();
      return list.filter(c => c.status === "open" || c.status === "awaiting_contractor" || c.status === "awaiting_architect").length;
    },
  });
  const checksLocked = openChecksCountForDevis > 0;

  return (
    <div className={`ml-4 mt-1 mb-3 border-l-2 border-[rgba(0,0,0,0.08)] pl-4 space-y-4 ${isVoid ? "opacity-50" : ""}`} data-testid={`detail-devis-${devis.id}`}>
      <div className="flex items-center justify-between gap-2 pt-1" data-testid={`header-devis-detail-${devis.id}`}>
        <TechnicalLabel>Devis Document</TechnicalLabel>
        <TooltipProvider delayDuration={200}>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 text-[11px] font-bold uppercase tracking-widest"
                    disabled={!hasPdf || rescrapeMutation.isPending}
                    onClick={() => setRescrapeConfirmOpen(true)}
                    data-testid={`button-rescrape-pdf-${devis.id}`}
                  >
                    {rescrapeMutation.isPending ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    Re-scrape
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[10px] max-w-[240px]">
                {hasPdf
                  ? "Re-run AI extraction on the stored PDF. Replaces line items and amounts; keeps your manual edits to the devis code, contractor, lot and status."
                  : "No PDF on file"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    className="h-8 gap-1.5 bg-[#0B2545] hover:bg-[#0B2545]/90 text-white text-[11px] font-bold uppercase tracking-widest"
                    disabled={!hasPdf}
                    onClick={onOpenPdfPopout}
                    data-testid={`button-view-pdf-prominent-${devis.id}`}
                  >
                    <FileText size={13} />
                    View PDF
                  </Button>
                </span>
              </TooltipTrigger>
              {!hasPdf && (
                <TooltipContent side="top" className="text-[10px]">No PDF on file</TooltipContent>
              )}
            </Tooltip>
            {/* Task #198 — only rendered when the auto-upload to the
                 Renosud shared Drive has succeeded for this devis. */}
            {devis.driveWebViewLink && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={devis.driveWebViewLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-[11px] font-bold uppercase tracking-widest hover:bg-accent hover:text-accent-foreground"
                    data-testid={`link-view-on-drive-${devis.id}`}
                  >
                    <FileText size={13} />
                    Drive
                  </a>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[10px]">Open in Renosud shared Drive</TooltipContent>
              </Tooltip>
            )}
          </div>
        </TooltipProvider>
      </div>
      <AlertDialog
        open={rescrapeConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !rescrapeMutation.isPending) setRescrapeConfirmOpen(false);
        }}
      >
        <AlertDialogContent data-testid={`dialog-confirm-rescrape-${devis.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-scrape this devis?</AlertDialogTitle>
            <AlertDialogDescription>
              The AI will read <span className="font-semibold">{devis.devisCode}</span> again and
              replace its current line items and totals with whatever it
              extracts. Your manual edits to the devis code, contractor, lot
              and status will be kept. This usually takes a few seconds.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rescrapeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={rescrapeMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                rescrapeMutation.mutate();
              }}
              data-testid={`button-confirm-rescrape-${devis.id}`}
            >
              {rescrapeMutation.isPending ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" />
                  Re-scraping…
                </span>
              ) : (
                "Re-scrape"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {!isVoid && (() => {
        const lotRefWarnings = ((devis.validationWarnings as any[]) || []).filter(
          (w: any) => w?.field === "lotReferences",
        );
        if (lotRefWarnings.length === 0) return null;
        return (
          <LotReferenceWarningBanner
            warnings={lotRefWarnings}
            projectId={projectId}
            devisId={devis.id}
            isArchived={isArchived}
          />
        );
      })()}
      <div className="space-y-1.5" data-testid={`section-advisories-${devis.id}`}>
        <TechnicalLabel>Extraction Advisories</TechnicalLabel>
        <AdvisoriesList subject={{ type: "devis", id: devis.id }} />
      </div>
      <DevisRefEditsHistory devisId={devis.id} projectId={projectId} />
      {isVoid && (
        <div className="flex items-center gap-3 p-3 rounded-xl bg-red-50 border border-red-200">
          <Ban size={16} className="text-red-500 shrink-0" />
          <div>
            <p className="text-[12px] font-bold text-red-700">This quotation is void</p>
            {devis.voidReason && <p className="text-[10px] text-red-600 mt-0.5">{devis.voidReason}</p>}
            <p className="text-[9px] text-red-500 mt-0.5">Excluded from all financial calculations</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 text-[9px] font-bold uppercase tracking-widest border-red-300 text-red-600 hover:bg-red-100"
            onClick={() => {
              updateDevisMutation.mutate({ status: "pending", voidReason: null });
              toast({ title: "Quotation restored", description: "Devis is no longer void" });
            }}
            disabled={isArchived}
            data-testid={`button-unvoid-${devis.id}`}
          >
            Restore
          </Button>
        </div>
      )}

      {!isVoid && (
        <div className="space-y-3" data-testid={`section-signoff-requirements-${devis.id}`}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <TechnicalLabel>Lot Assignment</TechnicalLabel>
              <p className="text-[9px] text-muted-foreground">Required for Certificat de Paiement</p>
              {!addingNewLot ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <Select
                    value={currentCatalogCode}
                    onValueChange={(val) => {
                      if (val === "__new__") {
                        setAddingNewLot(true);
                      } else {
                        assignFromCatalogMutation.mutate(val);
                      }
                    }}
                    disabled={isArchived || assignFromCatalogMutation.isPending}
                  >
                    <SelectTrigger className="flex-1" data-testid={`select-lot-${devis.id}`}>
                      <SelectValue placeholder="Select a lot..." />
                    </SelectTrigger>
                    <SelectContent>
                      {lotCatalog.map((entry) => (
                        <SelectItem key={entry.id} value={entry.code} data-testid={`option-lot-${entry.code}`}>
                          {entry.code} — {formatLotDescription(entry)}
                        </SelectItem>
                      ))}
                      <SelectItem value="__new__">+ Add new lot</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-2 p-2 rounded-lg border border-[rgba(0,0,0,0.08)] bg-white/50">
                  <p className="text-[9px] text-muted-foreground">Adds to the master list — available across all projects.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="Code (e.g. LOT3)"
                      value={newLotNumber}
                      onChange={(e) => setNewLotNumber(e.target.value)}
                      className="text-[11px]"
                      data-testid={`input-new-lot-number-${devis.id}`}
                    />
                    <Input
                      placeholder="French description"
                      value={newLotDescription}
                      onChange={(e) => setNewLotDescription(e.target.value)}
                      className="text-[11px]"
                      data-testid={`input-new-lot-desc-${devis.id}`}
                    />
                  </div>
                  <div className="relative">
                    <Input
                      placeholder="English description (optional)"
                      value={newLotDescriptionUk}
                      onChange={(e) => setNewLotDescriptionUk(e.target.value)}
                      className="text-[11px] pr-8"
                      data-testid={`input-new-lot-desc-uk-${devis.id}`}
                    />
                    <button
                      type="button"
                      onClick={handleSuggestNewLotUk}
                      disabled={suggestingLotUk || newLotDescription.trim().length === 0 || isArchived}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Suggest English translation"
                      data-testid={`button-suggest-new-lot-uk-${devis.id}`}
                    >
                      {suggestingLotUk ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!newLotNumber.trim() || !newLotDescription.trim() || createCatalogLotMutation.isPending || assignFromCatalogMutation.isPending || isArchived}
                      onClick={() => createCatalogLotMutation.mutate({ code: newLotNumber.trim(), descriptionFr: newLotDescription.trim(), descriptionUk: newLotDescriptionUk.trim() || null })}
                      data-testid={`button-save-new-lot-${devis.id}`}
                    >
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {createCatalogLotMutation.isPending ? "Saving..." : "Save & Assign"}
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setAddingNewLot(false); setNewLotNumber(""); setNewLotDescription(""); setNewLotDescriptionUk(""); }}
                      data-testid={`button-cancel-new-lot-${devis.id}`}
                    >
                      <span className="text-[9px] font-bold uppercase tracking-widest">Cancel</span>
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <TechnicalLabel>Works Description (English)</TechnicalLabel>
              <p className="text-[9px] text-muted-foreground">Required for Certificat de Paiement</p>
              <div className="relative">
                <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-md" style={{ backgroundColor: "#c1a27b" }} />
                <Input
                  className="pl-4 text-[11px]"
                  placeholder="Enter works description in English..."
                  value={descriptionUkLocal}
                  onChange={(e) => setDescriptionUkLocal(e.target.value)}
                  onBlur={(e) => {
                    const val = e.target.value.trim();
                    if (val !== (devis.descriptionUk || "")) {
                      updateDevisMutation.mutate({ descriptionUk: val || null });
                      toast({ title: "Works description updated" });
                    }
                  }}
                  disabled={isArchived}
                  data-testid={`input-description-uk-${devis.id}`}
                />
              </div>
            </div>
          </div>

          {signOffBlocked && (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200" data-testid={`warning-signoff-blocked-${devis.id}`}>
              <AlertTriangle size={14} className="text-amber-500 shrink-0" />
              <p className="text-[10px] text-amber-700 font-medium">
                Lot assignment and English works description are required before sign-off can proceed
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5 py-2" data-testid={`stepper-signoff-${devis.id}`}>
        {SIGN_OFF_STAGES.map((stage, idx) => {
          const isCompleted = idx <= currentStageIndex && !isVoid;
          const isCurrent = idx === currentStageIndex && !isVoid;
          // Checks gate: we cannot advance to 'sent_to_client' (or any later
          // stage) while there are open contractor questions.
          const lockedByChecks = checksLocked && idx >= SENT_TO_CLIENT_INDEX && currentStageIndex < SENT_TO_CLIENT_INDEX;
          const lockTitle = lockedByChecks
            ? `Résolvez d'abord les ${openChecksCountForDevis} question(s) en cours avec l'entreprise avant l'envoi au client.`
            : undefined;
          return (
            <div key={stage.key} className="flex items-center gap-1.5 flex-1">
              <button
                type="button"
                title={lockTitle}
                aria-disabled={lockedByChecks ? "true" : undefined}
                className={`flex-1 px-2 py-1.5 rounded-lg border text-[9px] font-bold uppercase tracking-wide text-center transition-all flex items-center justify-center gap-1
                  ${isVoid
                    ? "border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed"
                    : lockedByChecks
                      ? "border-amber-300 bg-amber-50 text-amber-600 cursor-not-allowed"
                      : isCurrent
                        ? "border-[#0B2545] bg-[#0B2545] text-white shadow-sm"
                        : isCompleted
                          ? "border-emerald-300 bg-emerald-50 text-emerald-700 cursor-pointer hover:bg-emerald-100"
                          : "border-slate-200 bg-white text-slate-400 cursor-pointer hover:border-slate-300 hover:text-slate-600"
                  }`}
                onClick={() => {
                  if (isVoid || isArchived) return;
                  // IMPORTANT: do not use `disabled` for the locked-by-checks
                  // case — disabled buttons swallow the click and we lose the
                  // chance to explain why to the user via toast.
                  if (lockedByChecks) {
                    toast({ title: "Sign-off bloqué", description: lockTitle!, variant: "destructive" });
                    return;
                  }
                  if (signOffBlocked && idx > 0) {
                    toast({ title: "Sign-off blocked", description: "Lot assignment and English works description are required before advancing", variant: "destructive" });
                    return;
                  }
                  updateDevisMutation.mutate({ signOffStage: stage.key });
                  toast({ title: `Stage: ${stage.label}` });
                }}
                disabled={isVoid || isArchived || (signOffBlocked && idx > 0)}
                data-testid={`button-stage-${stage.key}-${devis.id}`}
              >
                {lockedByChecks && <Ban size={9} />}
                {stage.label}
              </button>
              {idx < SIGN_OFF_STAGES.length - 1 && (
                <ChevronRight size={10} className={isCompleted && idx < currentStageIndex ? "text-emerald-400" : "text-slate-300"} />
              )}
            </div>
          );
        })}
        {!isVoid && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 gap-1 ml-2 border-red-200 text-red-500 hover:bg-red-50 hover:text-red-700 shrink-0"
            onClick={() => setVoidDialogOpen(true)}
            disabled={isArchived}
            data-testid={`button-void-${devis.id}`}
          >
            <Ban size={10} />
            <span className="text-[8px] font-bold uppercase tracking-widest">Void</span>
          </Button>
        )}
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Original Contracted</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1">{formatCurrency(originalTtc)} <span className="text-[9px] text-muted-foreground">TTC</span></p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(originalHt)} HT</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Adjusted (+ PV/MV)</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1">{formatCurrency(adjustedTtc)} <span className="text-[9px] text-muted-foreground">TTC</span></p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(adjustedHt)} HT</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Invoiced</TechnicalLabel>
          <p className="text-[13px] font-semibold text-emerald-600 mt-1">{formatCurrency(invoicedTtc)} <span className="text-[9px] text-muted-foreground">TTC</span></p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(invoicedHt)} HT</p>
        </div>
        <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] bg-white/50">
          <TechnicalLabel>Reste à Réaliser</TechnicalLabel>
          <p className={`text-[13px] font-semibold mt-1 ${remainingHt < 0 ? "text-red-600" : "text-amber-600"}`}>
            {formatCurrency(remainingTtc)} <span className="text-[9px] text-muted-foreground">TTC</span>
          </p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(remainingHt)} HT</p>
        </div>
      </div>
      <TvaDerivedHint
        amountHt={adjustedHt}
        amountTtc={adjustedTtc}
        testId={`text-devis-detail-tva-derived-${devis.id}`}
      />
      <div className="h-1.5 w-full rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
      </div>

      <DevisDetailTabs
        devis={devis}
        lineItems={lineItems}
        translationLineItems={translationLineItems}
        avenants={avenants}
        invoices={invoices}
        isArchived={isArchived}
        onOpenAvenantDialog={onOpenAvenantDialog}
        onOpenInvoiceUpload={onOpenInvoiceUpload}
        onAddLineItem={() => {
          lineItemForm.reset({ devisId: devis.id, lineNumber: (lineItems?.length ?? 0) + 1, description: "", quantity: "1", unit: "u", unitPriceHt: "0.00", totalHt: "0.00", percentComplete: "0" });
          setLineItemDialogOpen(true);
        }}
        onUpdateLineItem={(id, data) => updateLineItemMutation.mutateAsync({ id, ...data })}
      />

      {/* Bottom-mirror digest of contractor questions sits BELOW the line-items
          table (Variant B layout from the canvas). Architects flag rows red in
          the table above, the popover seeds the question, and this panel
          summarises what will go out in the next email round. Kept above the
          sign-off stepper so checksLocked gating stays visually adjacent to
          the gated SENT_TO_CLIENT button. */}
      {!isVoid && (
        <ChecksPanel
          devisId={devis.id}
          projectId={projectId}
          isArchived={isArchived}
          contractorEmail={contractors.find((c) => c.id === devis.contractorId)?.email ?? null}
          lineItems={lineItems ?? []}
        />
      )}

      <Dialog open={voidDialogOpen} onOpenChange={setVoidDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight text-red-700">Mark Quotation as Void</DialogTitle>
            <DialogDescription className="text-[11px]">
              This quotation will be excluded from all financial calculations and tracking. You can restore it later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <TechnicalLabel>Reason for voiding</TechnicalLabel>
              <Textarea
                className="mt-1 resize-none text-[11px]"
                placeholder="e.g. Mistake, change of contractor, budget revision..."
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                data-testid="input-void-reason"
              />
            </div>
            <Button
              className="w-full bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                updateDevisMutation.mutate({ status: "void", voidReason: voidReason || null });
                toast({ title: "Quotation voided", description: "Excluded from all calculations" });
                setVoidDialogOpen(false);
                setVoidReason("");
              }}
              disabled={updateDevisMutation.isPending}
              data-testid="button-confirm-void"
            >
              <Ban size={14} />
              <span className="text-[9px] font-bold uppercase tracking-widest">
                {updateDevisMutation.isPending ? "Voiding..." : "Confirm Void"}
              </span>
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={lineItemDialogOpen} onOpenChange={setLineItemDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight">Add Line Item</DialogTitle>
            <DialogDescription className="text-[11px]">Add a line item to this devis for progress tracking</DialogDescription>
          </DialogHeader>
          <Form {...lineItemForm}>
            <form onSubmit={lineItemForm.handleSubmit((d) => createLineItemMutation.mutate(d))} className="space-y-4">
              <FormField control={lineItemForm.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel><TechnicalLabel>Description</TechnicalLabel></FormLabel>
                  <FormControl><Input {...field} data-testid="input-line-desc" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-3 gap-4">
                <FormField control={lineItemForm.control} name="quantity" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Qty</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.001" onBlur={() => recalcLineTotal()} data-testid="input-line-qty" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={lineItemForm.control} name="unitPriceHt" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Unit Price</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcLineTotal()} data-testid="input-line-price" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={lineItemForm.control} name="totalHt" render={({ field }) => (
                  <FormItem>
                    <FormLabel><TechnicalLabel>Total HT</TechnicalLabel></FormLabel>
                    <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-line-total" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <Button type="submit" className="w-full" disabled={createLineItemMutation.isPending} data-testid="button-submit-line">
                <span className="text-[9px] font-bold uppercase tracking-widest">
                  {createLineItemMutation.isPending ? "Adding..." : "Add Line Item"}
                </span>
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
