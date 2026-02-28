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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

interface DevisSummary {
  devisId: number;
  devisCode: string;
  descriptionFr: string;
  descriptionUk: string | null;
  status: string;
  contractorId: number;
  invoicingMode: string;
  originalHt: number;
  pvTotal: number;
  mvTotal: number;
  adjustedHt: number;
  certifiedHt: number;
  resteARealiser: number;
  invoiceCount: number;
  avenantCount: number;
}

interface FinancialSummary {
  projectId: number;
  projectName: string;
  projectCode: string;
  devis: DevisSummary[];
  totalContractedHt: number;
  totalCertifiedHt: number;
  totalResteARealiser: number;
  totalOriginalHt: number;
  totalPv: number;
  totalMv: number;
}

function ProjectFinancialCard({ project }: { project: Project }) {
  const { data: summary, isLoading } = useQuery<FinancialSummary>({
    queryKey: ["/api/projects", project.id, "financial-summary"],
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

  const anomalies = summary.devis.filter((d) => d.resteARealiser < 0 || d.certifiedHt > d.adjustedHt);

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
          <TechnicalLabel>Contract\u00e9</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-0.5" data-testid={`text-contracted-${project.id}`}>
            {formatCurrency(summary.totalContractedHt)}
          </p>
        </div>
        <div>
          <TechnicalLabel>Certifi\u00e9</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-0.5" data-testid={`text-certified-${project.id}`}>
            {formatCurrency(summary.totalCertifiedHt)}
          </p>
        </div>
        <div>
          <TechnicalLabel>Reste</TechnicalLabel>
          <p className={`text-[13px] font-semibold mt-0.5 ${summary.totalResteARealiser < 0 ? "text-red-500" : "text-foreground"}`} data-testid={`text-remaining-${project.id}`}>
            {formatCurrency(summary.totalResteARealiser)}
          </p>
        </div>
      </div>

      <div className="mb-2">
        <Progress value={Math.min(100, progress)} className="h-2" />
        <p className="text-[9px] text-muted-foreground mt-1">{progress.toFixed(1)}% certifi\u00e9</p>
      </div>

      {anomalies.length > 0 && (
        <div className="flex items-center gap-1 mt-2">
          <AlertTriangle size={12} className="text-amber-500" />
          <span className="text-[9px] font-bold text-amber-600 uppercase tracking-widest">
            {anomalies.length} anomalie{anomalies.length > 1 ? "s" : ""}
          </span>
        </div>
      )}

      {summary.devis.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.05)]">
          <div className="space-y-1.5">
            {summary.devis.map((d) => {
              const pct = d.adjustedHt > 0 ? (d.certifiedHt / d.adjustedHt) * 100 : 0;
              const isAnomaly = d.resteARealiser < 0;
              return (
                <div
                  key={d.devisId}
                  className={`flex items-center gap-2 py-1 ${isAnomaly ? "text-red-500" : ""}`}
                  data-testid={`row-devis-financial-${d.devisId}`}
                >
                  <span className="text-[10px] font-semibold text-foreground min-w-[80px]">{d.devisCode}</span>
                  <div className="flex-1">
                    <Progress value={Math.min(100, pct)} className="h-1" />
                  </div>
                  <span className="text-[10px] text-muted-foreground min-w-[50px] text-right">{pct.toFixed(0)}%</span>
                  <span className={`text-[10px] font-semibold min-w-[80px] text-right ${isAnomaly ? "text-red-500" : "text-foreground"}`}>
                    {formatCurrency(d.resteARealiser)}
                  </span>
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
          Suivi Financier
        </h1>

        <SectionHeader
          icon={TrendingUp}
          title="Vue Financi\u00e8re Globale"
          subtitle="Suivi par projet et par devis"
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
              Aucun projet. Cr\u00e9ez des projets et des devis pour voir le suivi financier.
            </p>
          </LuxuryCard>
        )}
      </div>
    </AppLayout>
  );
}
