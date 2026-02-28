import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  LayoutDashboard,
  FolderOpen,
  TrendingUp,
  FileCheck,
  AlertTriangle,
  Receipt,
  Award,
  Clock,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Progress } from "@/components/ui/progress";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

interface ProjectSummary {
  id: number;
  name: string;
  code: string;
  clientName: string;
  status: string;
  devisCount: number;
  contractedHt: number;
  certifiedHt: number;
  resteARealiser: number;
  progress: number;
  anomalyCount: number;
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
  overview: {
    activeProjects: number;
    totalProjects: number;
    totalContractedHt: number;
    totalCertifiedHt: number;
    totalResteARealiser: number;
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
            Tableau de Bord
          </h1>
          <p className="text-[11px] text-muted-foreground mt-1">
            Vue d'ensemble de vos projets et activités financières
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <LuxuryCard key={i}>
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-8 w-16" />
              </LuxuryCard>
            ))
          ) : (
            <>
              <LuxuryCard data-testid="card-active-projects">
                <div className="flex items-center gap-2 mb-3">
                  <FolderOpen size={14} strokeWidth={1.5} className="text-muted-foreground" />
                  <TechnicalLabel>Projets Actifs</TechnicalLabel>
                </div>
                <p className="text-[28px] font-light text-foreground" data-testid="text-active-projects-count">
                  {data?.overview.activeProjects ?? 0}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  sur {data?.overview.totalProjects ?? 0} projets au total
                </p>
              </LuxuryCard>

              <LuxuryCard data-testid="card-contracted">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp size={14} strokeWidth={1.5} className="text-muted-foreground" />
                  <TechnicalLabel>Total Contracté HT</TechnicalLabel>
                </div>
                <p className="text-[28px] font-light text-foreground" data-testid="text-contracted-total">
                  {formatCurrency(data?.overview.totalContractedHt ?? 0)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Valeur totale des devis
                </p>
              </LuxuryCard>

              <LuxuryCard data-testid="card-certified">
                <div className="flex items-center gap-2 mb-3">
                  <FileCheck size={14} strokeWidth={1.5} className="text-muted-foreground" />
                  <TechnicalLabel>Total Certifié</TechnicalLabel>
                </div>
                <p className="text-[28px] font-light text-emerald-600 dark:text-emerald-400" data-testid="text-certified-total">
                  {formatCurrency(data?.overview.totalCertifiedHt ?? 0)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Montant certifié à ce jour
                </p>
              </LuxuryCard>

              <LuxuryCard data-testid="card-remaining">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle size={14} strokeWidth={1.5} className="text-muted-foreground" />
                  <TechnicalLabel>Reste à Réaliser</TechnicalLabel>
                </div>
                <p className="text-[28px] font-light text-amber-600 dark:text-amber-400" data-testid="text-remaining-total">
                  {formatCurrency(data?.overview.totalResteARealiser ?? 0)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Montant restant
                </p>
              </LuxuryCard>
            </>
          )}
        </div>

        {data && data.urgentItems.length > 0 && (
          <>
            <SectionHeader
              icon={AlertTriangle}
              title="Éléments Urgents"
              subtitle="Actions requises"
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
              title="Résumé des Projets"
              subtitle="Indicateurs financiers par projet"
            />

            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <LuxuryCard key={i}>
                    <Skeleton className="h-4 w-32 mb-2" />
                    <Skeleton className="h-3 w-48 mb-3" />
                    <Skeleton className="h-2 w-full" />
                  </LuxuryCard>
                ))}
              </div>
            ) : data && data.projectSummaries.length > 0 ? (
              <LuxuryCard data-testid="card-projects-table">
                <div className="overflow-x-auto">
                  <table className="w-full" data-testid="table-projects-summary">
                    <thead>
                      <tr className="border-b border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                        <th className="text-left py-3 pr-3">
                          <TechnicalLabel>Projet</TechnicalLabel>
                        </th>
                        <th className="text-left py-3 px-3">
                          <TechnicalLabel>Statut</TechnicalLabel>
                        </th>
                        <th className="text-right py-3 px-3">
                          <TechnicalLabel>Contracté HT</TechnicalLabel>
                        </th>
                        <th className="text-right py-3 px-3">
                          <TechnicalLabel>Certifié HT</TechnicalLabel>
                        </th>
                        <th className="text-right py-3 px-3">
                          <TechnicalLabel>Reste</TechnicalLabel>
                        </th>
                        <th className="text-left py-3 pl-3" style={{ minWidth: "100px" }}>
                          <TechnicalLabel>Avancement</TechnicalLabel>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.projectSummaries.map((ps) => (
                        <tr
                          key={ps.id}
                          className="border-b border-[rgba(0,0,0,0.03)] dark:border-[rgba(255,255,255,0.03)] last:border-0"
                          data-testid={`row-project-${ps.id}`}
                        >
                          <td className="py-3 pr-3">
                            <Link href={`/projets/${ps.id}`}>
                              <span className="text-[12px] font-semibold text-foreground hover:underline cursor-pointer" data-testid={`text-project-name-${ps.id}`}>
                                {ps.name}
                              </span>
                            </Link>
                            <p className="text-[10px] text-muted-foreground mt-0.5">{ps.code} — {ps.clientName}</p>
                          </td>
                          <td className="py-3 px-3">
                            <StatusBadge status={ps.status} />
                          </td>
                          <td className="py-3 px-3 text-right">
                            <span className="text-[12px] font-semibold text-foreground" data-testid={`text-project-contracted-${ps.id}`}>
                              {formatCurrency(ps.contractedHt)}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <span className="text-[12px] font-semibold text-emerald-600 dark:text-emerald-400" data-testid={`text-project-certified-${ps.id}`}>
                              {formatCurrency(ps.certifiedHt)}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <span className={`text-[12px] font-semibold ${ps.resteARealiser < 0 ? "text-red-500" : "text-amber-600 dark:text-amber-400"}`} data-testid={`text-project-reste-${ps.id}`}>
                              {formatCurrency(ps.resteARealiser)}
                            </span>
                          </td>
                          <td className="py-3 pl-3" style={{ minWidth: "100px" }}>
                            <div className="flex items-center gap-2">
                              <Progress value={ps.progress} className="h-1.5 flex-1" />
                              <span className="text-[10px] text-muted-foreground min-w-[32px] text-right">
                                {ps.progress.toFixed(0)}%
                              </span>
                            </div>
                            {ps.anomalyCount > 0 && (
                              <div className="flex items-center gap-1 mt-1">
                                <AlertTriangle size={10} className="text-amber-500" />
                                <span className="text-[9px] text-amber-600 dark:text-amber-400">
                                  {ps.anomalyCount} anomalie{ps.anomalyCount > 1 ? "s" : ""}
                                </span>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </LuxuryCard>
            ) : (
              <LuxuryCard data-testid="card-empty-projects">
                <p className="text-[12px] text-muted-foreground text-center py-8">
                  Aucun projet pour le moment. Créez votre premier projet pour commencer.
                </p>
              </LuxuryCard>
            )}
          </div>

          <div className="space-y-6">
            <SectionHeader
              icon={Clock}
              title="Activité Récente"
              subtitle="Dernières mises à jour"
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
                  Les données d'activité récente seront disponibles une fois les projets créés.
                </p>
              </LuxuryCard>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
