import "./_group.css";
import { useState } from "react";
import { FolderOpen, AlertTriangle, Receipt, Award, Clock, PenLine, Check, HelpCircle, TrendingUp, Coins } from "lucide-react";
import { AppLayout, Link, useQuery } from "./stubs";
import { Amount, LuxuryCard, SectionHeader, Skeleton, StatusBadge, TechnicalLabel } from "./ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./overlays";
import { OutstandingFeesBanner, OutstandingFeesPanel } from "./OutstandingFees";
import { DetectedFeeInvoicesAlert, DesignFeeActionsStrip, GmailStatusBar, UnsentCertificatsAlert } from "./DashboardAlerts";
import BurnUpChart from "./BurnUpChart";
import type { dashboardSample } from "./fixtures";

// Extracted from client/src/pages/dashboard.tsx. Source JSX/classes retained;
// auth, routing, network and mutation boundaries are sandbox-local stubs.
export function Current() {
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const { data, isLoading } = useQuery<typeof dashboardSample>({ queryKey: ["/api/dashboard/summary"] });
  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">Dashboard</h1>
          <p className="text-[11px] text-muted-foreground mt-1">Overview of your projects and activity</p>
        </div>
        <OutstandingFeesBanner scope="global" href="/honoraires" />
        <GmailStatusBar isLoading={isLoading} data={data} />
        {isLoading ? (
          <LuxuryCard><div className="flex items-center gap-3"><Skeleton className="h-8 w-8 rounded-lg" /><Skeleton className="h-3 w-48" /></div></LuxuryCard>
        ) : data && data.recentActivity.length > 0 ? (
          <div>
            <SectionHeader icon={Clock} title="Recent Activity" subtitle="Latest updates" />
            <LuxuryCard className="mt-3" data-testid="card-recent-activity">
              <div className="divide-y divide-[rgba(0,0,0,0.04)] dark:divide-[rgba(255,255,255,0.04)]">
                {data.recentActivity.slice(0, 5).map((item, idx) => (
                  <Link key={idx} href={`/projets/${item.projectId}`}>
                    <div className="flex items-center gap-3 py-2.5 cursor-pointer hover-elevate px-1 -mx-1 rounded-lg" data-testid={`row-activity-${idx}`}>
                      <div className={`p-1.5 rounded-lg shrink-0 ${item.type === "invoice" ? "bg-blue-50 dark:bg-blue-950/30" : "bg-emerald-50 dark:bg-emerald-950/30"}`}>
                        {item.type === "invoice" ? <Receipt size={12} className="text-blue-500 dark:text-blue-400" /> : <Award size={12} className="text-emerald-500 dark:text-emerald-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-semibold text-foreground truncate" data-testid={`text-activity-label-${idx}`}>{item.label}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{item.contractor}{item.date ? ` · ${item.date}` : ""}</p>
                      </div>
                      <span className="text-[11px] font-semibold text-foreground whitespace-nowrap shrink-0" data-testid={`text-activity-amount-${idx}`}>
                        <Amount value={parseFloat(item.amount)} denomination="TTC" />
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </LuxuryCard>
          </div>
        ) : null}
        <div data-testid="section-outstanding-fees-dashboard">
          <SectionHeader icon={Coins} title="Outstanding Architect Fees" subtitle="Approved invoices missing a Penny Lane reference" />
          <div className="mt-3"><OutstandingFeesPanel scope="global" /></div>
        </div>
        <DetectedFeeInvoicesAlert />
        <DesignFeeActionsStrip />
        <UnsentCertificatsAlert />
        {data && data.urgentItems.length > 0 && (
          <div>
            <SectionHeader icon={AlertTriangle} title="Urgent Items" subtitle="Actions required" />
            <div className="space-y-2 mt-3">
              {data.urgentItems.map((item, idx) => (
                <Link key={idx} href={`/projets/${item.projectId}`}>
                  <LuxuryCard className="cursor-pointer hover-elevate transition-all" data-testid={`card-urgent-${idx}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {item.type === "overdue_invoice" && <div className="p-1.5 rounded-lg bg-red-50 dark:bg-red-950/30"><Receipt size={14} className="text-red-500" /></div>}
                        {(item.type === "cert_draft" || item.type === "cert_review") && <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30"><Award size={14} className="text-amber-500" /></div>}
                        {item.type === "anomaly" && <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30"><AlertTriangle size={14} className="text-amber-500" /></div>}
                        <span className="text-[12px] text-foreground" data-testid={`text-urgent-label-${idx}`}>{item.label}</span>
                      </div>
                      {parseFloat(item.amount) > 0 && <span className="text-[12px] font-semibold text-foreground" data-testid={`text-urgent-amount-${idx}`}><Amount value={parseFloat(item.amount)} denomination="TTC" /></span>}
                    </div>
                  </LuxuryCard>
                </Link>
              ))}
            </div>
          </div>
        )}
        {data && data.projectSummaries.length > 0 && (
          <div>
            <SectionHeader icon={TrendingUp} title="Project Financial Health" subtitle="Burn-up chart" />
            <LuxuryCard className="mt-3" data-testid="card-burn-up">
              <div className="mb-3">
                <Select value={selectedProjectId?.toString() ?? ""} onValueChange={(val) => setSelectedProjectId(val ? parseInt(val, 10) : null)}>
                  <SelectTrigger className="w-full max-w-xs" data-testid="select-burnup-project"><SelectValue placeholder="Select a project" /></SelectTrigger>
                  <SelectContent>
                    {data.projectSummaries.map((ps) => <SelectItem key={ps.id} value={ps.id.toString()} data-testid={`option-project-${ps.id}`}>{ps.code} — {ps.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {selectedProjectId ? <BurnUpChart projectId={selectedProjectId} /> : <div className="flex items-center justify-center h-[200px] text-muted-foreground text-[12px]" data-testid="text-select-project-prompt">Select a project to view its burn-up chart.</div>}
            </LuxuryCard>
          </div>
        )}
        <div>
          <SectionHeader icon={FolderOpen} title="Projects" subtitle={`${data?.overview.activeProjects ?? 0} active of ${data?.overview.totalProjects ?? 0} total`} />
          {isLoading ? (
            <div className="space-y-3 mt-3">{Array.from({ length: 3 }).map((_, i) => <LuxuryCard key={i}><Skeleton className="h-4 w-48 mb-2" /><Skeleton className="h-3 w-32" /></LuxuryCard>)}</div>
          ) : data && data.projectSummaries.length > 0 ? (
            <div className="mt-3">
              <div className="flex items-end mb-2 px-2">
                <div className="flex-1" />
                <div className="flex items-end" style={{ gap: "2px" }}>
                  <div className="w-[120px] text-center"><TechnicalLabel>Devis</TechnicalLabel></div>
                  <div className="w-[96px] text-center"><TechnicalLabel>Factures</TechnicalLabel></div>
                  <div className="w-[48px] text-center"><TechnicalLabel>Agent</TechnicalLabel></div>
                </div>
              </div>
              <div className="space-y-2">
                {data.projectSummaries.map((ps) => (
                  <Link key={ps.id} href={`/projets/${ps.id}`}>
                    <LuxuryCard className="cursor-pointer hover-elevate transition-all !py-3" data-testid={`card-project-${ps.id}`}>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-semibold text-foreground truncate" data-testid={`text-project-name-${ps.id}`}>{ps.name}</span>
                            <StatusBadge status={ps.status} />
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{ps.code} — {ps.clientName}</p>
                        </div>
                        <div className="flex items-center shrink-0" style={{ gap: "2px" }}>
                          <div className="flex items-center gap-0.5 w-[120px] justify-center">
                            <CounterCell value={ps.devisApprovedCount} variant={ps.devisApprovedCount > 0 ? "green" : "neutral"} testId={`cell-devis-approved-${ps.id}`} hint="Number of devis" />
                            <CounterCell value={ps.devisUnapprovedCount} variant={ps.devisUnapprovedCount > 0 ? "red" : "neutral"} testId={`cell-devis-unapproved-${ps.id}`} hint="Devis pending approval" />
                            <SignedIcon allSigned={ps.allDevisSigned} hasDevis={ps.devisCount > 0} testId={`icon-signed-${ps.id}`} />
                          </div>
                          <div className="flex items-center gap-0.5 w-[96px] justify-center">
                            <CounterCell value={ps.invoiceApprovedCount} variant={ps.invoiceApprovedCount > 0 ? "green" : "neutral"} testId={`cell-factures-approved-${ps.id}`} hint="Number of factures" />
                            <CounterCell value={ps.invoiceUnapprovedCount} variant={ps.invoiceUnapprovedCount > 0 ? "red" : "neutral"} testId={`cell-factures-unapproved-${ps.id}`} hint="Factures pending approval" />
                          </div>
                          <div className="w-[48px] flex justify-center"><AgentIcon status={ps.agentStatus} testId={`icon-agent-${ps.id}`} /></div>
                        </div>
                      </div>
                    </LuxuryCard>
                  </Link>
                ))}
              </div>
            </div>
          ) : (
            <LuxuryCard className="mt-3" data-testid="card-empty-projects"><p className="text-[12px] text-muted-foreground text-center py-8">No projects yet. Sync from ArchiDoc to get started.</p></LuxuryCard>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function CounterCell({ value, variant, testId, hint }: { value: number; variant: "green" | "red" | "neutral"; testId: string; hint: string }) {
  const styles = {
    green: "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
    red: "bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800",
    neutral: "bg-muted/50 text-muted-foreground border-border",
  };
  return <div className={`w-[34px] h-[34px] rounded-lg border flex items-center justify-center ${styles[variant]}`} data-testid={testId} title={hint}><span className="text-[14px] font-bold">{value}</span></div>;
}
function SignedIcon({ allSigned, hasDevis, testId }: { allSigned: boolean; hasDevis: boolean; testId: string }) {
  if (!hasDevis) return <div className="w-[34px] h-[34px] rounded-lg border border-border bg-muted/50 flex items-center justify-center" data-testid={testId} title="No devis"><span className="text-muted-foreground text-[12px]">—</span></div>;
  return <div className={`w-[34px] h-[34px] rounded-lg border flex items-center justify-center ${allSigned ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800" : "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800"}`} data-testid={testId} title={allSigned ? "All devis signed" : "Devis not yet signed"}>
    <PenLine size={14} className={allSigned ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"} />
  </div>;
}
function AgentIcon({ status, testId }: { status: string; testId: string }) {
  return <div className={`w-[34px] h-[34px] rounded-lg border flex items-center justify-center ${status === "ok" ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800" : "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800"}`} data-testid={testId} title={status === "ok" ? "Agent status: all clear" : "Agent status: queries/anomalies need attention"}>
    {status === "ok" ? <Check size={14} className="text-emerald-600 dark:text-emerald-400" /> : <HelpCircle size={14} className="text-amber-500 dark:text-amber-400" />}
  </div>;
}
