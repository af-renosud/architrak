import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Upload, FileText, Download, Mail, HardDriveUpload, Inbox, ArrowRight, RotateCw, Trash2, Eye, EyeOff } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { ProjectIntakeDocument } from "@shared/schema";

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
  if (doc.promotedKind === "devis") return `/projects/${projectId}?devis=${doc.promotedId}`;
  if (doc.promotedKind === "invoice") return `/projects/${projectId}?invoice=${doc.promotedId}`;
  return null;
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
    queryKey: ["/api/projects", projectId, "intake", showVoid ? "?includeVoid=true" : ""],
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
        queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "intake"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "intake"] });
      toast({ title: "Re-analysis triggered", description: "The document is being re-classified and routed." });
    },
    onError: (error: Error) => {
      toast({ title: "Re-analysis failed", description: error.message, variant: "destructive" });
    },
  });

  const [deleteTarget, setDeleteTarget] = useState<ProjectIntakeDocument | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (intakeDocumentId: number) => {
      return apiRequest("DELETE", `/api/intake-documents/${intakeDocumentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "intake"] });
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
