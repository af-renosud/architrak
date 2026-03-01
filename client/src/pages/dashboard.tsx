import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  FolderOpen,
  AlertTriangle,
  Receipt,
  Award,
  Clock,
  Mail,
  FileText,
  PenLine,
  CheckCircle,
  HelpCircle,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

function formatTimeAgo(isoString: string | null): string {
  if (!isoString) return "Never";
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min${mins > 1 ? "s" : ""} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

interface ProjectSummary {
  id: number;
  name: string;
  code: string;
  clientName: string;
  status: string;
  devisCount: number;
  devisApprovedCount: number;
  devisUnapprovedCount: number;
  allDevisSigned: boolean;
  invoiceCount: number;
  invoiceApprovedCount: number;
  invoiceUnapprovedCount: number;
  agentStatus: string;
  agentIssueCount: number;
}

interface ActivityItem {
  type: string;
  label: string;
  date: string | null;
  amount: string;
  projectId: number;
  contractor: string;
}

interface UrgentItem {
  type: string;
  label: string;
  projectId: number;
  id: number;
  amount: string;
}

interface DashboardData {
  gmailLastCheck: string | null;
  gmailPolling: boolean;
  overview: {
    activeProjects: number;
    totalProjects: number;
  };
  projectSummaries: ProjectSummary[];
  recentActivity: ActivityItem[];
  urgentItems: UrgentItem[];
}

export default function Dashboard() {
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/dashboard/summary"],
  });

  return (
    <AppLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
            Dashboard
          </h1>
          <p className="text-[11px] text-muted-foreground mt-1">
            Overview of your projects and activity
          </p>
        </div>

        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-muted/50 border border-border" data-testid="bar-gmail-status">
          <Mail size={14} className="text-muted-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Last Gmail Check:
          </span>
          <span className="text-[11px] font-semibold text-foreground" data-testid="text-gmail-last-check">
            {isLoading ? "..." : formatTimeAgo(data?.gmailLastCheck ?? null)}
          </span>
          {data && !data.gmailPolling && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400 ml-2">(Polling paused)</span>
          )}
        </div>

        {data && data.urgentItems.length > 0 && (
          <>
            <SectionHeader
              icon={AlertTriangle}
              title="Urgent Items"
              subtitle="Actions required"
            />
            <div className="space-y-2">
              {data.urgentItems.map((item, idx) => (
                <Link key={idx} href={`/projets/${item.projectId}`}>
                  <LuxuryCard
                    className="cursor-pointer hover-elevate transition-all"
                    data-testid={`card-urgent-${idx}`}
                  >
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0">
                        {item.type === "overdue_invoice" && (
                          <div className="p-1.5 rounded-lg bg-red-50 dark:bg-red-950/30">
                            <Receipt size={14} className="text-red-500" />
                          </div>
                        )}
                        {(item.type === "cert_draft" || item.type === "cert_review") && (
                          <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                            <Award size={14} className="text-amber-500" />
                          </div>
                        )}
                        {item.type === "anomaly" && (
                          <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                            <AlertTriangle size={14} className="text-amber-500" />
                          </div>
                        )}
                        <span className="text-[12px] text-foreground" data-testid={`text-urgent-label-${idx}`}>
                          {item.label}
                        </span>
                      </div>
                      {parseFloat(item.amount) > 0 && (
                        <span className="text-[12px] font-semibold text-foreground" data-testid={`text-urgent-amount-${idx}`}>
                          {formatCurrency(parseFloat(item.amount))}
                        </span>
                      )}
                    </div>
                  </LuxuryCard>
                </Link>
              ))}
            </div>
          </>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 space-y-6">
            <SectionHeader
              icon={FolderOpen}
              title="Projects"
              subtitle={`${data?.overview.activeProjects ?? 0} active of ${data?.overview.totalProjects ?? 0} total`}
            />

            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <LuxuryCard key={i}>
                    <Skeleton className="h-4 w-32 mb-2" />
                    <Skeleton className="h-3 w-48" />
                  </LuxuryCard>
                ))}
              </div>
            ) : data && data.projectSummaries.length > 0 ? (
              <div className="space-y-3">
                {data.projectSummaries.map((ps) => (
                  <Link key={ps.id} href={`/projets/${ps.id}`}>
                    <LuxuryCard
                      className="cursor-pointer hover-elevate transition-all"
                      data-testid={`card-project-${ps.id}`}
                    >
                      <div className="flex items-center justify-between gap-4 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-semibold text-foreground truncate" data-testid={`text-project-name-${ps.id}`}>
                              {ps.name}
                            </span>
                            <StatusBadge status={ps.status} />
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{ps.code} — {ps.clientName}</p>
                        </div>

                        <div className="flex items-center gap-3">
                          <CounterBox
                            label="Devis"
                            icon={<FileText size={12} />}
                            total={ps.devisCount}
                            approved={ps.devisApprovedCount}
                            unapproved={ps.devisUnapprovedCount}
                            testId={`counter-devis-${ps.id}`}
                          />

                          <SignedBox
                            allSigned={ps.allDevisSigned}
                            hasDevis={ps.devisCount > 0}
                            testId={`counter-signed-${ps.id}`}
                          />

                          <CounterBox
                            label="Factures"
                            icon={<Receipt size={12} />}
                            total={ps.invoiceCount}
                            approved={ps.invoiceApprovedCount}
                            unapproved={ps.invoiceUnapprovedCount}
                            testId={`counter-factures-${ps.id}`}
                          />

                          <AgentBox
                            status={ps.agentStatus}
                            issueCount={ps.agentIssueCount}
                            testId={`counter-agent-${ps.id}`}
                          />
                        </div>
                      </div>
                    </LuxuryCard>
                  </Link>
                ))}
              </div>
            ) : (
              <LuxuryCard data-testid="card-empty-projects">
                <p className="text-[12px] text-muted-foreground text-center py-8">
                  No projects yet. Sync from ArchiDoc to get started.
                </p>
              </LuxuryCard>
            )}
          </div>

          <div className="space-y-6">
            <SectionHeader
              icon={Clock}
              title="Recent Activity"
              subtitle="Latest updates"
            />

            {isLoading ? (
              <LuxuryCard>
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-8 w-8 rounded-lg" />
                      <div className="flex-1">
                        <Skeleton className="h-3 w-24 mb-1" />
                        <Skeleton className="h-2 w-16" />
                      </div>
                    </div>
                  ))}
                </div>
              </LuxuryCard>
            ) : data && data.recentActivity.length > 0 ? (
              <LuxuryCard data-testid="card-recent-activity">
                <div className="space-y-3">
                  {data.recentActivity.map((item, idx) => (
                    <Link key={idx} href={`/projets/${item.projectId}`}>
                      <div
                        className="flex items-start gap-3 py-2 cursor-pointer rounded-lg hover-elevate px-2 -mx-2"
                        data-testid={`row-activity-${idx}`}
                      >
                        <div className={`p-1.5 rounded-lg mt-0.5 ${
                          item.type === "invoice"
                            ? "bg-blue-50 dark:bg-blue-950/30"
                            : "bg-emerald-50 dark:bg-emerald-950/30"
                        }`}>
                          {item.type === "invoice" ? (
                            <Receipt size={12} className="text-blue-500 dark:text-blue-400" />
                          ) : (
                            <Award size={12} className="text-emerald-500 dark:text-emerald-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-semibold text-foreground truncate" data-testid={`text-activity-label-${idx}`}>
                            {item.label}
                          </p>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {item.contractor}
                          </p>
                          {item.date && (
                            <p className="text-[9px] text-muted-foreground mt-0.5">
                              {item.date}
                            </p>
                          )}
                        </div>
                        <span className="text-[11px] font-semibold text-foreground whitespace-nowrap" data-testid={`text-activity-amount-${idx}`}>
                          {formatCurrency(parseFloat(item.amount))}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </LuxuryCard>
            ) : (
              <LuxuryCard data-testid="card-recent-activity">
                <p className="text-[12px] text-muted-foreground text-center py-8">
                  No recent activity yet.
                </p>
              </LuxuryCard>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function CounterBox({ label, icon, total, approved, unapproved, testId }: {
  label: string;
  icon: React.ReactNode;
  total: number;
  approved: number;
  unapproved: number;
  testId: string;
}) {
  const allApproved = total > 0 && unapproved === 0;
  return (
    <div className="flex flex-col items-center min-w-[56px]" data-testid={testId}>
      <div className="flex items-center gap-1 mb-1">
        <span className="text-muted-foreground">{icon}</span>
        <TechnicalLabel>{label}</TechnicalLabel>
      </div>
      <div className="flex items-center gap-1.5">
        <span className={`text-[14px] font-bold ${allApproved ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`} data-testid={`${testId}-total`}>
          {total}
        </span>
        {unapproved > 0 && (
          <span className="text-[12px] font-bold text-red-500 bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 rounded-md" data-testid={`${testId}-unapproved`}>
            {unapproved}
          </span>
        )}
        {allApproved && total > 0 && (
          <CheckCircle size={12} className="text-emerald-500" />
        )}
      </div>
    </div>
  );
}

function SignedBox({ allSigned, hasDevis, testId }: {
  allSigned: boolean;
  hasDevis: boolean;
  testId: string;
}) {
  return (
    <div className="flex flex-col items-center min-w-[44px]" data-testid={testId}>
      <div className="flex items-center gap-1 mb-1">
        <TechnicalLabel>Signed</TechnicalLabel>
      </div>
      {!hasDevis ? (
        <span className="text-[12px] text-muted-foreground">—</span>
      ) : allSigned ? (
        <PenLine size={16} className="text-emerald-500" />
      ) : (
        <PenLine size={16} className="text-red-500" />
      )}
    </div>
  );
}

function AgentBox({ status, issueCount, testId }: {
  status: string;
  issueCount: number;
  testId: string;
}) {
  return (
    <div className="flex flex-col items-center min-w-[44px]" data-testid={testId}>
      <div className="flex items-center gap-1 mb-1">
        <TechnicalLabel>Agent</TechnicalLabel>
      </div>
      {status === "ok" ? (
        <CheckCircle size={16} className="text-emerald-500" />
      ) : (
        <div className="flex items-center gap-1">
          <HelpCircle size={16} className="text-amber-500" />
          {issueCount > 0 && (
            <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400">{issueCount}</span>
          )}
        </div>
      )}
    </div>
  );
}
