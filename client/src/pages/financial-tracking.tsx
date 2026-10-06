import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { StatusBadge } from "@/components/ui/status-badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { Project } from "@shared/schema";

import { Amount } from "@/components/ui/amount";
import { CommitmentEvidenceSummary } from "@/components/projects/CommitmentEvidenceSummary";
import { commitmentLabel, isSignedCommitment, type FinancialSummary } from "@/lib/financial-summary";

// hint: Logic changed on both sides. Requires understanding intent of each change.
function ProjectFinancialCard({ project }: { project: Project }) {
  const { data: summary, isLoading } = useQuery<FinancialSummary>({
    queryKey: ["/api/projects", String(project.id), "financial-summary"],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${project.id}/financial-summary`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <LuxuryCard>
        <Skeleton className="h-4 w-32 mb-2" />
        <Skeleton className="h-20 w-full" />
      </LuxuryCard>
    );
  }

  if (!summary) return null;

  const progress = summary.totalContractedHt > 0
    ? (summary.totalCertifiedHt / summary.totalContractedHt) * 100
    : 0;

  const anomalies = summary.devis.filter((d) => isSignedCommitment(d) && (d.resteARealiser < 0 || d.certifiedHt > d.adjustedHt));

  return (
    <LuxuryCard data-testid={`card-financial-project-${project.id}`}>
      <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
        <div>
          <Link href={`/projets/${project.id}`}>
            <h3 className="text-[14px] font-bold text-foreground hover:underline cursor-pointer" data-testid={`text-project-name-${project.id}`}>
              {project.name}
            </h3>
          </Link>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <TechnicalLabel>{project.code}</TechnicalLabel>
            <span className="text-[10px] text-muted-foreground">{project.clientName}</span>
          </div>
        </div>
        <StatusBadge status={project.status} />
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <TechnicalLabel>Contracted — Signed</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-0.5" data-testid={`text-contracted-${project.id}`}>
            <Amount value={summary.totalContractedHt} denomination="HT" />
          </p>
          <p className="text-[11px] text-muted-foreground" data-testid={`text-contracted-ttc-${project.id}`}>
            <Amount value={summary.totalContractedTtc} denomination="TTC" />
          </p>
        </div>
        <div>
          <TechnicalLabel>Certified — Signed</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-0.5" data-testid={`text-certified-${project.id}`}>
            <Amount value={summary.totalCertifiedHt} denomination="HT" />
          </p>
          <p className="text-[11px] text-muted-foreground" data-testid={`text-certified-ttc-${project.id}`}>
            <Amount value={summary.totalCertifiedTtc} denomination="TTC" />
          </p>
        </div>
        <div>
          <TechnicalLabel>Remaining — Signed</TechnicalLabel>
          <p className={`text-[13px] font-semibold mt-0.5 ${summary.totalResteARealiser < 0 ? "text-red-500" : "text-foreground"}`} data-testid={`text-remaining-${project.id}`}>
            <Amount value={summary.totalResteARealiser} denomination="HT" />
          </p>
          <p className={`text-[11px] ${summary.totalResteARealiserTtc < 0 ? "text-red-400" : "text-muted-foreground"}`} data-testid={`text-remaining-ttc-${project.id}`}>
            <Amount value={summary.totalResteARealiserTtc} denomination="TTC" />
          </p>
        </div>
      </div>

      <div className="mb-2">
        <Progress value={Math.min(100, progress)} className="h-2" />
        <p className="text-[9px] text-muted-foreground mt-1">{progress.toFixed(1)}% certified</p>
      </div>

      {anomalies.length > 0 && (
        <div className="flex items-center gap-1 mt-2">
          <AlertTriangle size={12} className="text-amber-500" />
          <span className="text-[9px] font-bold text-amber-600 uppercase tracking-widest">
            {anomalies.length} anomal{anomalies.length > 1 ? "ies" : "y"}
          </span>
        </div>
      )}

      <CommitmentEvidenceSummary summary={summary} />
      {summary.devis.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.05)]">
          <div className="space-y-1.5">
            {summary.devis.map((d) => {
              const pct = d.adjustedHt > 0 ? (d.certifiedHt / d.adjustedHt) * 100 : 0;
               const isAnomaly = isSignedCommitment(d) && d.resteARealiser < 0;
              return (
                <div
                  key={d.devisId}
                  className={`flex items-center gap-2 py-1 ${isAnomaly ? "text-red-500" : ""}`}
                  data-testid={`row-devis-financial-${d.devisId}`}
                >
                  <div className="text-[10px] text-foreground min-w-[80px]">
                    <span className="font-semibold">{d.devisCode}</span>
                    <p className="text-[9px] text-muted-foreground" data-testid={`text-commitment-status-${d.devisId}`}>{commitmentLabel(d)}</p>
                    {!isSignedCommitment(d) && (
                      <p className="text-[9px] text-muted-foreground">Certified: <Amount value={d.certifiedTtc} denomination="TTC" />{" · "}<Amount value={d.certifiedHt} denomination="HT" /></p>
                    )}
                  </div>
                  <div className="flex-1">
                    <Progress value={Math.min(100, pct)} className="h-1" />
                  </div>
                  <span className="text-[10px] text-muted-foreground min-w-[50px] text-right">{pct.toFixed(0)}%</span>
                  <div className={`text-right min-w-[80px] ${isAnomaly ? "text-red-500" : "text-foreground"}`}>
                    <div className="text-[10px] font-semibold">
                      {!isSignedCommitment(d) && <span className="text-[9px] text-muted-foreground">Excluded balance: </span>}<Amount value={d.resteARealiser} denomination="HT" />
                    </div>
                    <div className="text-[9px] opacity-60">
                      <Amount value={d.resteARealiserTtc} denomination="TTC" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </LuxuryCard>
  );
}

export default function FinancialTracking() {
  const { data: projects, isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  return (
    <AppLayout>
      <div className="space-y-8">
        <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
          Financial Tracking
        </h1>

        <SectionHeader
          icon={TrendingUp}
          title="Global Financial View"
          subtitle="Tracking by project and Devis"
        />

        {isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <LuxuryCard key={i}>
                <Skeleton className="h-4 w-32 mb-2" />
                <Skeleton className="h-3 w-24 mb-4" />
                <Skeleton className="h-20 w-full" />
              </LuxuryCard>
            ))}
          </div>
        ) : projects && projects.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {projects.map((project) => (
              <ProjectFinancialCard key={project.id} project={project} />
            ))}
          </div>
        ) : (
          <LuxuryCard data-testid="card-empty-financial">
            <p className="text-[12px] text-muted-foreground text-center py-8">
              No projects. Create projects and Devis to see financial tracking.
            </p>
          </LuxuryCard>
        )}
      </div>
    </AppLayout>
  );
}
