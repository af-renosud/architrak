import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Mail, FileText, RefreshCw, ExternalLink, Search, Filter, Eye, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { EmailDocument, Project } from "@shared/schema";

function formatDate(date: string | Date | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const statusColors: Record<string, string> = {
  pending: "warning",
  processing: "info",
  completed: "success",
  failed: "error",
  needs_review: "warning",
};

const typeLabels: Record<string, string> = {
  quotation: "Devis",
  invoice: "Facture",
  situation: "Situation",
  avenant: "Avenant",
  other: "Other",
  unknown: "Unknown",
};

export default function EmailDocuments() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewingDoc, setViewingDoc] = useState<EmailDocument | null>(null);

  const { data: emailDocs, isLoading } = useQuery<EmailDocument[]>({
    queryKey: ["/api/email-documents"],
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const { data: gmailStatus } = useQuery<any>({
    queryKey: ["/api/gmail/status"],
  });

  const pollMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/gmail/poll");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-documents"] });
      toast({ title: `Poll complete: ${data.processed} processed, ${data.errors} errors` });
    },
    onError: (error: Error) => {
      toast({ title: "Poll failed", description: error.message, variant: "destructive" });
    },
  });

  const processMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/email-documents/${id}/process`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-documents"] });
      toast({ title: "Document re-processed" });
    },
    onError: (error: Error) => {
      toast({ title: "Processing failed", description: error.message, variant: "destructive" });
    },
  });

  const assignMutation = useMutation({
    mutationFn: async ({ id, projectId }: { id: number; projectId: number }) => {
      const res = await apiRequest("PATCH", `/api/email-documents/${id}`, { projectId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-documents"] });
      toast({ title: "Project assigned" });
    },
  });

  const projectMap = new Map<number, Project>();
  projects?.forEach(p => projectMap.set(p.id, p));

  const filtered = emailDocs?.filter(doc => {
    if (statusFilter !== "all" && doc.extractionStatus !== statusFilter) return false;
    if (typeFilter !== "all" && doc.documentType !== typeFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const match = (doc.emailSubject?.toLowerCase().includes(q)) ||
        (doc.emailFrom?.toLowerCase().includes(q)) ||
        (doc.attachmentFileName?.toLowerCase().includes(q));
      if (!match) return false;
    }
    return true;
  }) ?? [];

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <Skeleton className="h-6 w-48" />
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full rounded-[2rem]" />)}
        </div>
      </AppLayout>
    );
  }

  const pendingCount = emailDocs?.filter(d => d.extractionStatus === "pending" || d.extractionStatus === "needs_review").length ?? 0;

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <SectionHeader icon={Mail} title="Email Documents" subtitle={`${emailDocs?.length ?? 0} documents extracted`} />
          <div className="flex items-center gap-3">
            {gmailStatus && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <div className={`w-2 h-2 rounded-full ${gmailStatus.configured ? "bg-emerald-500" : "bg-rose-500"}`} />
                <span data-testid="text-gmail-status">{gmailStatus.configured ? "Gmail connected" : "Gmail not configured"}</span>
                {gmailStatus.lastPollTime && (
                  <span>Last poll: {formatDate(gmailStatus.lastPollTime)}</span>
                )}
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => pollMutation.mutate()}
              disabled={pollMutation.isPending}
              data-testid="button-poll-gmail"
            >
              <RefreshCw size={14} className={pollMutation.isPending ? "animate-spin" : ""} />
              <span className="text-[9px] font-bold uppercase tracking-widest">Poll Now</span>
            </Button>
          </div>
        </div>

        {pendingCount > 0 && (
          <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-900 flex items-center justify-center">
              <FileText size={14} className="text-amber-600" />
            </div>
            <span className="text-sm font-medium text-amber-800 dark:text-amber-200" data-testid="text-pending-count">
              {pendingCount} document{pendingCount > 1 ? "s" : ""} pending review or processing
            </span>
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by subject, sender, filename..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 text-sm"
              data-testid="input-search-documents"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]" data-testid="select-status-filter">
              <Filter size={14} className="mr-1" />
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="needs_review">Needs Review</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[160px]" data-testid="select-type-filter">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="quotation">Devis</SelectItem>
              <SelectItem value="invoice">Facture</SelectItem>
              <SelectItem value="situation">Situation</SelectItem>
              <SelectItem value="avenant">Avenant</SelectItem>
              <SelectItem value="other">Other</SelectItem>
              <SelectItem value="unknown">Unknown</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          {filtered.length === 0 ? (
            <LuxuryCard className="p-8 text-center">
              <Mail size={32} className="mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No email documents found</p>
              <p className="text-xs text-muted-foreground mt-1">ArchiTrak monitors Gmail every 15 minutes for PDF attachments</p>
            </LuxuryCard>
          ) : (
            filtered.map(doc => {
              const project = doc.projectId ? projectMap.get(doc.projectId) : null;
              return (
                <LuxuryCard key={doc.id} className="p-4" data-testid={`card-email-doc-${doc.id}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center flex-shrink-0">
                        <FileText size={16} className="text-blue-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold truncate" data-testid={`text-doc-filename-${doc.id}`}>
                            {doc.attachmentFileName || "Unknown file"}
                          </span>
                          <StatusBadge status={doc.extractionStatus} size="sm" />
                          <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                            {typeLabels[doc.documentType] || doc.documentType}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          <span>From: {doc.emailFrom || "Unknown"}</span>
                          <span className="mx-2">·</span>
                          <span>{formatDate(doc.emailReceivedAt)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 truncate">
                          {doc.emailSubject || "No subject"}
                        </div>
                        {project && (
                          <div className="text-xs mt-1">
                            <span className="text-emerald-600 font-medium">Matched: {project.name}</span>
                            {doc.matchConfidence && (
                              <span className="text-muted-foreground ml-1">({doc.matchConfidence}% confidence)</span>
                            )}
                          </div>
                        )}
                        {!project && doc.extractionStatus !== "pending" && (
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-xs text-rose-500 font-medium">Unmatched</span>
                            <Select onValueChange={(val) => assignMutation.mutate({ id: doc.id, projectId: Number(val) })}>
                              <SelectTrigger className="w-[200px] h-7 text-xs" data-testid={`select-assign-project-${doc.id}`}>
                                <SelectValue placeholder="Assign to project..." />
                              </SelectTrigger>
                              <SelectContent>
                                {projects?.map(p => (
                                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setViewingDoc(doc)}
                        data-testid={`button-view-doc-${doc.id}`}
                      >
                        <Eye size={14} />
                      </Button>
                      {doc.emailLink && (
                        <a href={doc.emailLink} target="_blank" rel="noopener noreferrer">
                          <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-gmail-link-${doc.id}`}>
                            <ExternalLink size={14} />
                          </Button>
                        </a>
                      )}
                      {(doc.extractionStatus === "failed" || doc.extractionStatus === "pending") && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => processMutation.mutate(doc.id)}
                          disabled={processMutation.isPending}
                          data-testid={`button-reprocess-${doc.id}`}
                        >
                          <RotateCcw size={14} />
                        </Button>
                      )}
                    </div>
                  </div>
                </LuxuryCard>
              );
            })
          )}
        </div>

        <Dialog open={!!viewingDoc} onOpenChange={() => setViewingDoc(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Document Details</DialogTitle>
            </DialogHeader>
            {viewingDoc && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <TechnicalLabel>File Name</TechnicalLabel>
                    <p className="text-sm">{viewingDoc.attachmentFileName}</p>
                  </div>
                  <div>
                    <TechnicalLabel>Type</TechnicalLabel>
                    <p className="text-sm">{typeLabels[viewingDoc.documentType] || viewingDoc.documentType}</p>
                  </div>
                  <div>
                    <TechnicalLabel>From</TechnicalLabel>
                    <p className="text-sm">{viewingDoc.emailFrom}</p>
                  </div>
                  <div>
                    <TechnicalLabel>Subject</TechnicalLabel>
                    <p className="text-sm">{viewingDoc.emailSubject}</p>
                  </div>
                  <div>
                    <TechnicalLabel>Received</TechnicalLabel>
                    <p className="text-sm">{formatDate(viewingDoc.emailReceivedAt)}</p>
                  </div>
                  <div>
                    <TechnicalLabel>Confidence</TechnicalLabel>
                    <p className="text-sm">{viewingDoc.matchConfidence ? `${viewingDoc.matchConfidence}%` : "—"}</p>
                  </div>
                </div>
                {viewingDoc.extractedData && (
                  <div>
                    <TechnicalLabel>Extracted Data</TechnicalLabel>
                    <pre className="text-xs bg-slate-50 dark:bg-slate-900 p-3 rounded-lg mt-1 overflow-auto max-h-64">
                      {JSON.stringify(viewingDoc.extractedData, null, 2)}
                    </pre>
                  </div>
                )}
                {viewingDoc.matchedFields && (
                  <div>
                    <TechnicalLabel>Matched Fields</TechnicalLabel>
                    <pre className="text-xs bg-slate-50 dark:bg-slate-900 p-3 rounded-lg mt-1 overflow-auto max-h-32">
                      {JSON.stringify(viewingDoc.matchedFields, null, 2)}
                    </pre>
                  </div>
                )}
                <div className="flex gap-2">
                  {viewingDoc.emailLink && (
                    <a href={viewingDoc.emailLink} target="_blank" rel="noopener noreferrer">
                      <Button variant="outline" size="sm" data-testid="button-open-gmail">
                        <ExternalLink size={14} />
                        <span className="text-xs">Open in Gmail</span>
                      </Button>
                    </a>
                  )}
                  <a href={`/api/email-documents/${viewingDoc.id}/download`} download>
                    <Button variant="outline" size="sm" data-testid="button-download-doc">
                      <FileText size={14} />
                      <span className="text-xs">Download</span>
                    </Button>
                  </a>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
