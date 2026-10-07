import type { Devis } from "@shared/schema";
import { commitmentLabel, isSignedCommitment, type DevisFinancialSummary } from "@/lib/financial-summary";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { TvaDerivedHint } from "@/components/ui/tva-derived-hint";
import { CertificatPanel } from "./CertificatPanel";
import { DevisClosurePanel } from "./DevisClosurePanel";
import { WorkflowSection } from "./DevisWorkflow";

export function DevisAfterSigning({ devis, projectId, isArchived, financial, progress, invoiceCount, avenantCount, isError, isFetching, onRetry, onCreateCertificat }: {
  devis: Devis; projectId: string; isArchived: boolean; financial?: DevisFinancialSummary;
  progress: number; invoiceCount: number; avenantCount: number; isError: boolean; isFetching: boolean;
  onRetry: () => void; onCreateCertificat?: (context: { contractorId: number; devisId: number }) => void;
}) {
  return <WorkflowSection group="after" summary={`${invoiceCount} invoices · ${avenantCount} variations · ${financial ? commitmentLabel(financial) : "Commitment evidence loading"}`}>
    <DevisClosurePanel devis={devis} projectId={projectId} isArchived={isArchived} />
    {devis.status !== "void" && <CertificatPanel devisId={devis.id} projectId={projectId} isArchived={isArchived} onCreateManual={onCreateCertificat} />}
    {financial ? <div className="space-y-2" data-testid={`card-devis-detail-financial-${devis.id}`}>
      <p className="text-[11px] text-muted-foreground" data-testid={`text-devis-detail-commitment-${devis.id}`}>{commitmentLabel(financial)}</p>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="p-3 rounded-xl border border-border bg-background/50">
          <TechnicalLabel>{isSignedCommitment(financial) ? "Original Contracted — Signed" : "Original Quotation — Excluded"}</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1"><Amount value={financial.originalTtc} denomination="TTC" /></p>
          <p className="text-[10px] text-muted-foreground"><Amount value={financial.originalHt} denomination="HT" /></p>
        </div>
        <div className="p-3 rounded-xl border border-border bg-background/50">
          <TechnicalLabel>{isSignedCommitment(financial) ? "Adjusted (+ PV/MV)" : "Adjusted Quotation — Excluded"}</TechnicalLabel>
          <p className="text-[13px] font-semibold text-foreground mt-1"><Amount value={financial.adjustedTtc} denomination="TTC" /></p>
          <p className="text-[10px] text-muted-foreground"><Amount value={financial.adjustedHt} denomination="HT" /></p>
        </div>
        <div className="p-3 rounded-xl border border-border bg-background/50">
          <TechnicalLabel>{isSignedCommitment(financial) ? "Certified" : "Certified — Outside commitment"}</TechnicalLabel>
          <p className="text-[13px] font-semibold text-emerald-600 mt-1" data-testid={`text-devis-detail-certified-${devis.id}`}><Amount value={financial.certifiedTtc} denomination="TTC" /></p>
          <p className="text-[10px] text-muted-foreground"><Amount value={financial.certifiedHt} denomination="HT" /></p>
          {(financial.acompteCertifiedHt ?? 0) > 0 && <p className="text-[9px] text-emerald-700 dark:text-emerald-400 mt-1" data-testid={`text-devis-detail-acompte-${devis.id}`}>
            Includes opening deposit: <Amount value={financial.acompteCertifiedTtc ?? 0} denomination="TTC" />{" · "}<Amount value={financial.acompteCertifiedHt ?? 0} denomination="HT" />
          </p>}
          <p className="text-[9px] text-muted-foreground mt-1">{financial.invoiceCount} supplier invoice{financial.invoiceCount !== 1 ? "s" : ""}</p>
        </div>
        <div className="p-3 rounded-xl border border-border bg-background/50">
          <TechnicalLabel>{isSignedCommitment(financial) ? "Reste à Réaliser" : "Quotation balance — Excluded"}</TechnicalLabel>
          <p className={`text-[13px] font-semibold mt-1 ${financial.resteARealiser < 0 ? "text-red-600" : "text-amber-600"}`} data-testid={`text-devis-detail-remaining-${devis.id}`}>
            <Amount value={financial.resteARealiserTtc} denomination="TTC" />
          </p>
          <p className="text-[10px] text-muted-foreground"><Amount value={financial.resteARealiser} denomination="HT" /></p>
        </div>
      </div>
      <TvaDerivedHint amountHt={financial.adjustedHt} amountTtc={financial.adjustedTtc} testId={`text-devis-detail-tva-derived-${devis.id}`} />
      <div className="h-1.5 w-full rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} /></div>
    </div> : isError ? <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3" data-testid={`error-devis-detail-financial-${devis.id}`}>
      <p className="text-[11px] text-amber-900">Financial summary could not be loaded.</p>
      <Button type="button" size="sm" variant="outline" className="h-7 text-[10px]" disabled={isFetching} onClick={onRetry}>{isFetching ? "Retrying…" : "Retry"}</Button>
    </div> : <div className="grid grid-cols-1 md:grid-cols-4 gap-3" data-testid={`skeleton-devis-detail-financial-${devis.id}`}>
      {[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-20 rounded-xl" />)}
    </div>}
  </WorkflowSection>;
}
