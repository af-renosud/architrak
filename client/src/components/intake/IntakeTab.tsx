import { useMutation, useQuery } from "@tanstack/react-query";
import { Upload, FileText, Download, Mail, HardDriveUpload, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { ProjectIntakeDocument } from "@shared/schema";

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

export function IntakeTab({ projectId, isArchived = false }: IntakeTabProps) {
  const { toast } = useToast();

  const { data: intakeDocs, isLoading } = useQuery<ProjectIntakeDocument[]>({
    queryKey: ["/api/projects", projectId, "intake"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/intake/upload`, { method: "POST", body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "intake"] });
      toast({ title: "Document uploaded", description: "Parked in intake for analysis." });
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const handleUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.doc,.docx,.xls,.xlsx";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) uploadMutation.mutate(file);
    };
    input.click();
  };

  return (
    <div className="space-y-4" data-testid="tab-content-intake">
      <LuxuryCard className="p-5">
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

      {isLoading ? (
        <LuxuryCard><Skeleton className="h-40 w-full" /></LuxuryCard>
      ) : intakeDocs && intakeDocs.length > 0 ? (
        <div className="space-y-2" data-testid="list-intake-docs">
          {intakeDocs.map((doc) => {
            const status = analysisLabel(doc.analysisState);
            const isEmail = doc.source === "gmail";
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
                    </div>
                  </div>
                  <a href={`/api/intake-documents/${doc.id}/download`} download>
                    <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-download-intake-${doc.id}`}>
                      <Download size={14} />
                    </Button>
                  </a>
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
    </div>
  );
}

export default IntakeTab;
