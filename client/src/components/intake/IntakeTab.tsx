import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Upload, FileText, Download, Mail, HardDriveUpload, Inbox, ArrowRight, RotateCw, Trash2, Eye, EyeOff, Paperclip } from "lucide-react";
import { Link } from "wouter";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Devis, ProjectIntakeDocument, Situation } from "@shared/schema";

type IntakeListItem = ProjectIntakeDocument & { isVoid?: boolean };

interface IntakeTabProps {
  projectId: string;
  isArchived?: boolean;
}

/**
 * Unified intake list (Task #229). The single per-project "front door": every
 * uploaded file — manual upload or email attachment matched to this project —
 * appears here with a status badge. AI classification / extraction / routing
 * into typed records (devis, factures, …) is a later task; for now items are
 * parked in a "Pending analysis" state.
 */
function analysisLabel(state: string): { label: string; className: string } {
  switch (state) {
    case "analyzing":
      return { label: "Analyzing", className: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300" };
    case "analyzed":
      return { label: "Analyzed", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" };
    case "failed":
      return { label: "Analysis failed", className: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300" };
    case "pending":
    default:
      return { label: "Pending analysis", className: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" };
  }
}

function routingLabel(state: string): { label: string; className: string } | null {
  switch (state) {
    case "routed":
      return { label: "Routed", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" };
    case "duplicate":
      return { label: "Duplicate", className: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300" };
    case "parked":
      return { label: "Parked", className: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" };
    case "failed":
      return { label: "Routing failed", className: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300" };
    case "unrouted":
    default:
      return null;
  }
}

function promotedHref(projectId: string, doc: ProjectIntakeDocument): string | null {
  if (!doc.promotedId) return null;
  // NOTE: project detail is registered under the FRENCH path `/projets/:id`
  // (client/src/App.tsx) — an English `/projects/...` href 404s.
  if (doc.promotedKind === "devis") return `/projets/${projectId}?devis=${doc.promotedId}`;
  if (doc.promotedKind === "invoice") return `/projets/${projectId}?tab=factures&invoice=${doc.promotedId}`;
  // Task #450 — situations are reviewed on their devis card (Situations tab).
  if (doc.promotedKind === "situation") return `/projets/${projectId}?tab=devis`;
  return null;
}

// Task #449 — parked evidence documents (signed Situation de travaux / Bon de
// commande) get a one-click reviewed attach flow instead of only "retry".
function evidenceKind(doc: ProjectIntakeDocument): "situation" | "commande" | null {
  if (doc.routingState !== "parked" || doc.promotedId) return null;
  const type = (doc.extractedData as { documentType?: string } | null)?.documentType;
  return type === "situation" || type === "commande" ? type : null;
}

function AttachEvidenceDialog({
  projectId,
  doc,
  onClose,
}: {
  projectId: string;
  doc: ProjectIntakeDocument;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const kind = evidenceKind(doc) ?? "situation";
  const [devisId, setDevisId] = useState<string>("");
  const [situationId, setSituationId] = useState<string>("");

  const { data: devisList } = useQuery<Devis[]>({
    queryKey: ["/api/projects", String(projectId), "devis"],
  });
  const { data: situationsList } = useQuery<Situation[]>({
    queryKey: ["/api/devis", devisId, "situations"],
    enabled: kind === "situation" && devisId !== "",
  });

  const extractedNumber = (doc.extractedData as { situationNumber?: number } | null)?.situationNumber;

  const attachMutation = useMutation({
    mutationFn: async () => {
      if (kind === "situation") {
        return apiRequest("POST", `/api/intake-documents/${doc.id}/attach-situation`, {
          situationId: Number(situationId),
        });
      }
      return apiRequest("POST", `/api/intake-documents/${doc.id}/attach-commande`, {
        devisId: Number(devisId),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "intake"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "marche-documents"] });
      if (devisId) queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "situations"] });
      toast({
        title: kind === "situation" ? "Situation PDF attached" : "Bon de commande retained",
        description:
          kind === "situation"
            ? "The signed PDF is now attached to the situation record."
            : "The signed order form is retained as marché evidence on the devis.",
      });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Attach failed", description: error.message, variant: "destructive" });
    },
  });

  const canAttach =
    kind === "situation" ? situationId !== "" : devisId !== "";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-testid="dialog-attach-evidence">
        <DialogHeader>
          <DialogTitle>
            {kind === "situation" ? "Attach signed situation PDF" : "Attach bon de commande"}
          </DialogTitle>
          <DialogDescription>
            {kind === "situation"
              ? `Pick the devis and the situation record "${doc.fileName}" belongs to. The PDF is attached as confirmed evidence.`
              : `Pick the devis "${doc.fileName}" authorises. The signed order form is retained as confirmed marché evidence.`}
            {kind === "situation" && extractedNumber ? ` Extracted number: Situation n°${extractedNumber}.` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={devisId} onValueChange={(v) => { setDevisId(v); setSituationId(""); }}>
            <SelectTrigger data-testid="select-attach-devis">
              <SelectValue placeholder="Select a devis" />
            </SelectTrigger>
            <SelectContent>
              {(devisList ?? []).map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.devisCode} — {d.descriptionFr}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {kind === "situation" && devisId !== "" && (
            <Select value={situationId} onValueChange={setSituationId}>
              <SelectTrigger data-testid="select-attach-situation">
                <SelectValue placeholder="Select a situation" />
              </SelectTrigger>
              <SelectContent>
                {(situationsList ?? []).length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    No situations on this devis yet — create the situation record first.
                  </div>
                ) : (
                  (situationsList ?? []).map((s) => (
                    <SelectItem key={s.id} value={String(s.id)} disabled={!!s.sourceStorageKey}>
                      Situation n°{s.situationNumber}
                      {s.sourceStorageKey ? " (PDF already attached)" : ""}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-attach">
            Cancel
          </Button>
          <Button
            onClick={() => attachMutation.mutate()}
            disabled={!canAttach || attachMutation.isPending}
            data-testid="button-confirm-attach"
          >
            {attachMutation.isPending ? "Attaching..." : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ACCEPTED_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".doc", ".docx", ".xls", ".xlsx"];

function isAcceptedFile(file: File): boolean {
  const dot = file.name.lastIndexOf(".");
  if (dot === -1) return false;
  return ACCEPTED_EXTENSIONS.includes(file.name.slice(dot).toLowerCase());
}

export function IntakeTab({ projectId, isArchived = false }: IntakeTabProps) {
  const { toast } = useToast();
  const [showVoid, setShowVoid] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepth = useRef(0);

  const { data: intakeDocs, isLoading } = useQuery<IntakeListItem[]>({
    queryKey: ["/api/projects", String(projectId), "intake", showVoid ? "?includeVoid=true" : ""],
    // Task #327 — poll while any document is still being processed so the
    // status badge advances (pending → analyzing → analyzed/failed) without
    // a manual page refresh. Once every doc is terminal, polling stops.
    refetchInterval: (query) => {
      const docs = query.state.data;
      const active = docs?.some(
        (d) => d.analysisState === "pending" || d.analysisState === "analyzing",
      );
      return active ? 3000 : false;
    },
  });

  // Task #418 — the app runs with staleTime: Infinity, so when the background
  // intake queue promotes an uploaded document into a devis/facture record,
  // nothing would otherwise refresh the (already cached) Devis/Factures lists
  // — the new draft stayed invisible until a hard page reload. Watch the
  // polled intake list for docs that GAIN a promotedId and invalidate the
  // record lists (and their derived summaries) for the affected kinds.
  const promotedTrackerRef = useRef<{ projectId: string; keys: Set<string> } | null>(null);
  useEffect(() => {
    if (!intakeDocs) return;
    // Track (doc id, kind, promotedId) so a re-route that changes the
    // promotion target also triggers invalidation.
    const promotionKey = (d: ProjectIntakeDocument) =>
      `${d.id}:${d.promotedKind}:${d.promotedId}`;
    const promotedDocs = intakeDocs.filter((d) => d.promotedId != null);
    const promotedNow = new Set(promotedDocs.map(promotionKey));
    const prev =
      promotedTrackerRef.current?.projectId === projectId
        ? promotedTrackerRef.current.keys
        : null;
    promotedTrackerRef.current = { projectId, keys: promotedNow };

    let staleKinds: Set<string | null>;
    if (!prev) {
      // First observation for this project. The record lists may hold cached
      // pre-promotion data (staleTime: Infinity), so check whether every
      // promoted record is already present in the cached lists; invalidate
      // the kinds that are missing one. Absent caches fetch fresh on mount
      // and need nothing.
      staleKinds = new Set();
      const cachedDevis = queryClient.getQueryData<{ id: number }[]>(
        ["/api/projects", String(projectId), "devis"],
      );
      const cachedInvoices = queryClient.getQueryData<{ id: number }[]>(
        ["/api/projects", String(projectId), "invoices"],
      );
      for (const d of promotedDocs) {
        if (
          d.promotedKind === "devis" &&
          cachedDevis &&
          !cachedDevis.some((r) => r.id === d.promotedId)
        ) {
          staleKinds.add("devis");
        }
        if (
          d.promotedKind === "invoice" &&
          cachedInvoices &&
          !cachedInvoices.some((r) => r.id === d.promotedId)
        ) {
          staleKinds.add("invoice");
        }
      }
    } else {
      const newlyPromoted = promotedDocs.filter((d) => !prev.has(promotionKey(d)));
      staleKinds = new Set(newlyPromoted.map((d) => d.promotedKind));
    }
    if (staleKinds.size === 0) return;
    const kinds = staleKinds;
    if (kinds.has("devis")) {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "devis-readiness"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "devis-checks", "open-counts"] });
    }
    if (kinds.has("invoice")) {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "invoices"] });
    }
    if (kinds.has("situation")) {
      // Task #450 — situations lists live per-devis; invalidate them all so
      // the new draft's Situations tab chip/list refreshes without a reload.
      queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          q.queryKey[0] === "/api/devis" &&
          q.queryKey[2] === "situations",
      });
    }
    queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "financial-summary"] });
    queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "accounting-status"] });
  }, [intakeDocs, projectId]);

  const uploadMutation = useMutation({
    mutationFn: async (files: File[]) => {
      // Upload sequentially so each file gets its own intake row and a
      // per-file error message; one failure doesn't abort the rest.
      const failures: string[] = [];
      let uploaded = 0;
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`/api/projects/${projectId}/intake/upload`, { method: "POST", body: formData });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          failures.push(`${file.name}: ${body.message || "Upload failed"}`);
        } else {
          uploaded += 1;
        }
      }
      return { uploaded, failures };
    },
    onSuccess: ({ uploaded, failures }) => {
      if (uploaded > 0) {
        queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "intake"] });
        toast({
          title: uploaded === 1 ? "Document uploaded" : `${uploaded} documents uploaded`,
          description: "Parked in intake for analysis.",
        });
      }
      if (failures.length > 0) {
        toast({
          title: failures.length === 1 ? "1 upload failed" : `${failures.length} uploads failed`,
          description: failures.join(" — "),
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (intakeDocumentId: number) => {
      return apiRequest("POST", `/api/intake-documents/${intakeDocumentId}/reanalyze`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "intake"] });
      toast({ title: "Re-analysis triggered", description: "The document is being re-classified and routed." });
    },
    onError: (error: Error) => {
      toast({ title: "Re-analysis failed", description: error.message, variant: "destructive" });
    },
  });

  const [deleteTarget, setDeleteTarget] = useState<ProjectIntakeDocument | null>(null);
  const [attachTarget, setAttachTarget] = useState<ProjectIntakeDocument | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (intakeDocumentId: number) => {
      return apiRequest("DELETE", `/api/intake-documents/${intakeDocumentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "intake"] });
      toast({ title: "Document deleted", description: "The intake document and its stored file were removed." });
      setDeleteTarget(null);
    },
    onError: (error: Error) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
      setDeleteTarget(null);
    },
  });

  const handleUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ACCEPTED_EXTENSIONS.join(",");
    input.onchange = (e) => {
      const files = Array.from((e.target as HTMLInputElement).files ?? []);
      if (files.length > 0) uploadMutation.mutate(files);
    };
    input.click();
  };

  const handleDroppedFiles = (files: File[]) => {
    const accepted = files.filter(isAcceptedFile);
    const rejected = files.filter((f) => !isAcceptedFile(f));
    if (rejected.length > 0) {
      toast({
        title: rejected.length === 1 ? "Unsupported file type" : `${rejected.length} unsupported files`,
        description: `${rejected.map((f) => f.name).join(", ")} — supported types: ${ACCEPTED_EXTENSIONS.join(", ")}`,
        variant: "destructive",
      });
    }
    if (accepted.length > 0) uploadMutation.mutate(accepted);
  };

  const dragHasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const onDragEnter = (e: React.DragEvent) => {
    if (isArchived || uploadMutation.isPending || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragOver(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (isArchived || uploadMutation.isPending || !dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    if (isArchived || uploadMutation.isPending) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleDroppedFiles(files);
  };

  return (
    <div className="space-y-4" data-testid="tab-content-intake">
      <LuxuryCard
        className={`p-5 transition-colors ${isDragOver ? "ring-2 ring-primary bg-primary/5 border-primary" : ""}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-testid="card-intake-upload"
        data-dragover={isDragOver ? "true" : "false"}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">
              Upload a document
            </h3>
            <p className="text-[11px] text-muted-foreground mt-1 max-w-xl">
              Drop any financial document here — a devis, a facture, a situation, anything.
              No need to choose the type. It lands in the intake list below and the system
              sorts it. Emails arrive here automatically too.
            </p>
          </div>
          <Button
            onClick={handleUpload}
            disabled={uploadMutation.isPending || isArchived}
            data-testid="button-upload-intake"
          >
            <Upload size={14} />
            <span className="text-[9px] font-bold uppercase tracking-widest">
              {uploadMutation.isPending ? "Uploading..." : "Upload Document"}
            </span>
          </Button>
        </div>
      </LuxuryCard>

      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => setShowVoid((v) => !v)}
          data-testid="button-toggle-show-void"
        >
          {showVoid ? <EyeOff size={12} /> : <Eye size={12} />}
          <span className="text-[9px] font-bold uppercase tracking-widest">
            {showVoid ? "Hide void" : "Show void"}
          </span>
        </Button>
      </div>

      {isLoading ? (
        <LuxuryCard><Skeleton className="h-40 w-full" /></LuxuryCard>
      ) : intakeDocs && intakeDocs.length > 0 ? (
        <div className="space-y-2" data-testid="list-intake-docs">
          {intakeDocs.map((doc) => {
            const status = analysisLabel(doc.analysisState);
            const routing = routingLabel(doc.routingState);
            const isEmail = doc.source === "gmail";
            const draftHref = promotedHref(projectId, doc);
            const canRetry =
              !isArchived && (doc.analysisState === "failed" || doc.routingState === "failed" || doc.routingState === "parked");
            return (
              <LuxuryCard key={doc.id} className="p-4" data-testid={`card-intake-doc-${doc.id}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center flex-shrink-0">
                      <FileText size={14} className="text-blue-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[12px] font-semibold text-foreground truncate" data-testid={`text-intake-name-${doc.id}`}>
                        {doc.fileName}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span
                          className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${status.className}`}
                          data-testid={`status-intake-${doc.id}`}
                        >
                          {status.label}
                        </span>
                        {doc.isVoid && (
                          <span
                            className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                            data-testid={`badge-void-intake-${doc.id}`}
                          >
                            Void
                          </span>
                        )}
                        {routing && (
                          <span
                            className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${routing.className}`}
                            data-testid={`routing-intake-${doc.id}`}
                          >
                            {routing.label}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" data-testid={`text-intake-source-${doc.id}`}>
                          {isEmail ? <Mail size={11} /> : <HardDriveUpload size={11} />}
                          {isEmail ? "Email" : "Manual upload"}
                        </span>
                        {doc.createdAt && (
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(doc.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })}
                          </span>
                        )}
                      </div>
                      {doc.notes && (doc.routingState === "parked" || doc.routingState === "duplicate" || doc.analysisState === "failed") && (
                        <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2" data-testid={`text-intake-notes-${doc.id}`}>
                          {doc.notes}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {draftHref && (
                      <Link href={draftHref}>
                        <Button variant="outline" size="sm" className="h-8" data-testid={`button-open-draft-${doc.id}`}>
                          <span className="text-[9px] font-bold uppercase tracking-widest">
                            View {doc.promotedKind}
                          </span>
                          <ArrowRight size={12} />
                        </Button>
                      </Link>
                    )}
                    {!isArchived && evidenceKind(doc) && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => setAttachTarget(doc)}
                        title={evidenceKind(doc) === "situation" ? "Attach to a situation record" : "Attach to a devis as bon de commande"}
                        data-testid={`button-attach-evidence-${doc.id}`}
                      >
                        <Paperclip size={12} />
                        <span className="text-[9px] font-bold uppercase tracking-widest">Attach</span>
                      </Button>
                    )}
                    {canRetry && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => retryMutation.mutate(doc.id)}
                        disabled={retryMutation.isPending}
                        title="Re-run analysis & routing"
                        data-testid={`button-reanalyze-intake-${doc.id}`}
                      >
                        <RotateCw size={14} />
                      </Button>
                    )}
                    <a href={`/api/intake-documents/${doc.id}/download`} download>
                      <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-download-intake-${doc.id}`}>
                        <Download size={14} />
                      </Button>
                    </a>
                    {!isArchived && !doc.promotedId && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-red-600"
                        onClick={() => setDeleteTarget(doc)}
                        disabled={deleteMutation.isPending}
                        title="Delete document"
                        data-testid={`button-delete-intake-${doc.id}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                </div>
              </LuxuryCard>
            );
          })}
        </div>
      ) : (
        <LuxuryCard data-testid="card-empty-intake">
          <div className="text-center py-10">
            <Inbox size={28} className="mx-auto mb-3 text-muted-foreground" />
            <p className="text-[12px] text-muted-foreground">No documents in intake yet.</p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Upload a document above, or it will appear here when received by email.
            </p>
          </div>
        </LuxuryCard>
      )}

      {attachTarget && (
        <AttachEvidenceDialog
          projectId={projectId}
          doc={attachTarget}
          onClose={() => setAttachTarget(null)}
        />
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent data-testid="dialog-delete-intake">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.fileName}" will be permanently removed from intake, along with its stored file.
              This cannot be undone. If it was uploaded in error, you can simply upload the correct document afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-intake">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              className="bg-red-600 hover:bg-red-700 text-white"
              data-testid="button-confirm-delete-intake"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default IntakeTab;
