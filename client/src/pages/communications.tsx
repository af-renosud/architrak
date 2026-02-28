import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { MessageSquare, Send, FileCheck, Clock, AlertTriangle, Filter, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import type { ProjectCommunication, Project } from "@shared/schema";

function formatDate(date: string | Date | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const typeIcons: Record<string, typeof Send> = {
  certificat_sent: FileCheck,
  payment_chase: Clock,
  contractor_query: MessageSquare,
  client_update: Send,
  general: MessageSquare,
};

const typeLabels: Record<string, string> = {
  certificat_sent: "Certificat Sent",
  payment_chase: "Payment Chase",
  contractor_query: "Contractor Query",
  client_update: "Client Update",
  general: "General",
};

export default function Communications() {
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: communications, isLoading } = useQuery<ProjectCommunication[]>({
    queryKey: ["/api/communications"],
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const projectMap = new Map<number, Project>();
  projects?.forEach(p => projectMap.set(p.id, p));

  const filtered = communications?.filter(comm => {
    if (typeFilter !== "all" && comm.type !== typeFilter) return false;
    if (statusFilter !== "all" && comm.status !== statusFilter) return false;
    return true;
  }) ?? [];

  const sentCount = communications?.filter(c => c.status === "sent").length ?? 0;
  const queuedCount = communications?.filter(c => c.status === "queued").length ?? 0;
  const draftCount = communications?.filter(c => c.status === "draft").length ?? 0;

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

  return (
    <AppLayout>
      <div className="space-y-8">
        <SectionHeader icon={MessageSquare} title="Communication Hub" subtitle={`${communications?.length ?? 0} communications across all projects`} />

        <div className="grid grid-cols-4 gap-4">
          <LuxuryCard className="p-4 text-center">
            <TechnicalLabel>Total</TechnicalLabel>
            <p className="text-2xl font-bold mt-1" data-testid="text-total-comms">{communications?.length ?? 0}</p>
          </LuxuryCard>
          <LuxuryCard className="p-4 text-center">
            <TechnicalLabel>Sent</TechnicalLabel>
            <p className="text-2xl font-bold mt-1 text-emerald-600" data-testid="text-sent-count">{sentCount}</p>
          </LuxuryCard>
          <LuxuryCard className="p-4 text-center">
            <TechnicalLabel>Queued</TechnicalLabel>
            <p className="text-2xl font-bold mt-1 text-amber-600" data-testid="text-queued-count">{queuedCount}</p>
          </LuxuryCard>
          <LuxuryCard className="p-4 text-center">
            <TechnicalLabel>Drafts</TechnicalLabel>
            <p className="text-2xl font-bold mt-1 text-slate-500" data-testid="text-draft-count">{draftCount}</p>
          </LuxuryCard>
        </div>

        <div className="flex items-center gap-3">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[180px]" data-testid="select-comm-type-filter">
              <Filter size={14} className="mr-1" />
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="certificat_sent">Certificat Sent</SelectItem>
              <SelectItem value="payment_chase">Payment Chase</SelectItem>
              <SelectItem value="contractor_query">Contractor Query</SelectItem>
              <SelectItem value="client_update">Client Update</SelectItem>
              <SelectItem value="general">General</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]" data-testid="select-comm-status-filter">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="queued">Queued</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          {filtered.length === 0 ? (
            <LuxuryCard className="p-8 text-center">
              <MessageSquare size={32} className="mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No communications yet</p>
              <p className="text-xs text-muted-foreground mt-1">Send Certificats and chase payments from project detail pages</p>
            </LuxuryCard>
          ) : (
            filtered.map(comm => {
              const project = projectMap.get(comm.projectId);
              const IconComp = typeIcons[comm.type] || MessageSquare;
              const isExpanded = expandedId === comm.id;

              return (
                <LuxuryCard key={comm.id} className="p-4" data-testid={`card-comm-${comm.id}`}>
                  <div
                    className="flex items-start justify-between gap-4 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : comm.id)}
                  >
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 flex items-center justify-center flex-shrink-0">
                        <IconComp size={16} className="text-indigo-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold truncate">{comm.subject}</span>
                          <StatusBadge status={comm.status} size="sm" />
                          <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300">
                            {typeLabels[comm.type] || comm.type}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          <span>To: {comm.recipientName || comm.recipientEmail || "—"}</span>
                          <span className="mx-2">·</span>
                          <span>{comm.sentAt ? formatDate(comm.sentAt) : formatDate(comm.createdAt)}</span>
                          {project && (
                            <>
                              <span className="mx-2">·</span>
                              <Link href={`/projets/${project.id}`}>
                                <span className="text-blue-600 hover:underline cursor-pointer">{project.name}</span>
                              </Link>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" data-testid={`button-toggle-comm-${comm.id}`}>
                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </Button>
                  </div>
                  {isExpanded && (
                    <div className="mt-4 pl-12 border-t pt-4">
                      <div className="text-sm whitespace-pre-wrap text-muted-foreground">
                        {comm.body || "No content"}
                      </div>
                      {comm.emailMessageId && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          Gmail Message ID: {comm.emailMessageId}
                        </div>
                      )}
                    </div>
                  )}
                </LuxuryCard>
              );
            })
          )}
        </div>
      </div>
    </AppLayout>
  );
}
