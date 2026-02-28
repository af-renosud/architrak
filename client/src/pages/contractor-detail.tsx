import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { StatusBadge } from "@/components/ui/status-badge";
import { Building2, ArrowLeft, Mail, Phone, MapPin, FileText, Receipt, Shield, Globe, User, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, useParams } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Contractor, Devis, Invoice, Project } from "@shared/schema";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

export default function ContractorDetail() {
  const params = useParams<{ id: string }>();
  const contractorId = params.id;
  const { toast } = useToast();

  const { data: contractor, isLoading } = useQuery<Contractor>({
    queryKey: ["/api/contractors", contractorId],
  });

  const { data: contractorDevis } = useQuery<Devis[]>({
    queryKey: ["/api/contractors", contractorId, "devis"],
    enabled: !!contractor,
  });

  const { data: contractorInvoices } = useQuery<Invoice[]>({
    queryKey: ["/api/contractors", contractorId, "invoices"],
    enabled: !!contractor,
  });

  const { data: allProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    enabled: !!contractor,
  });

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-32 w-full rounded-[2rem]" />
        </div>
      </AppLayout>
    );
  }

  if (!contractor) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <p className="text-muted-foreground">Contractor not found.</p>
          <Link href="/entreprises">
            <Button variant="outline" data-testid="button-back-contractors">
              <ArrowLeft size={14} />
              <span className="text-[9px] font-bold uppercase tracking-widest">Back to Contractors</span>
            </Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  const projectMap = new Map<number, Project>();
  allProjects?.forEach((p) => projectMap.set(p.id, p));

  const totalDevisHt = contractorDevis?.reduce((sum, d) => sum + parseFloat(d.amountHt), 0) ?? 0;
  const totalInvoicedHt = contractorInvoices?.reduce((sum, inv) => sum + parseFloat(inv.amountHt), 0) ?? 0;

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/entreprises">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft size={16} />
            </Button>
          </Link>
          <div>
            <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-contractor-name">
              {contractor.name}
            </h1>
            {contractor.siret && (
              <TechnicalLabel data-testid="text-contractor-siret">SIRET: {contractor.siret}</TechnicalLabel>
            )}
          </div>
        </div>

        <SectionHeader
          icon={Building2}
          title={contractor.name}
          subtitle="Contractor details"
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <LuxuryCard data-testid="card-contractor-info" className="md:col-span-1">
            <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground mb-4">
              Information
            </h3>
            <div className="space-y-3">
              {contractor.email && (
                <div className="flex items-center gap-3">
                  <Mail size={14} className="text-muted-foreground" />
                  <span className="text-[12px] text-foreground" data-testid="text-email">{contractor.email}</span>
                </div>
              )}
              {contractor.phone && (
                <div className="flex items-center gap-3">
                  <Phone size={14} className="text-muted-foreground" />
                  <span className="text-[12px] text-foreground" data-testid="text-phone">{contractor.phone}</span>
                </div>
              )}
              {contractor.address && (
                <div className="flex items-center gap-3">
                  <MapPin size={14} className="text-muted-foreground" />
                  <span className="text-[12px] text-foreground" data-testid="text-address">{contractor.address}</span>
                </div>
              )}
              {contractor.defaultTvaRate && (
                <div className="pt-3 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                  <TechnicalLabel>Default TVA Rate</TechnicalLabel>
                  <p className="text-[12px] text-foreground mt-1" data-testid="text-default-tva">{contractor.defaultTvaRate}%</p>
                </div>
              )}
              {(contractor as any).contactName && (
                <div className="pt-3 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                  <TechnicalLabel>Contact</TechnicalLabel>
                  <div className="flex items-center gap-2 mt-1">
                    <User size={12} className="text-muted-foreground" />
                    <span className="text-[12px] text-foreground" data-testid="text-contact-name">
                      {(contractor as any).contactName}
                      {(contractor as any).contactJobTitle && ` — ${(contractor as any).contactJobTitle}`}
                    </span>
                  </div>
                  {(contractor as any).contactMobile && (
                    <div className="flex items-center gap-2 mt-1">
                      <Phone size={12} className="text-muted-foreground" />
                      <span className="text-[12px] text-foreground">{(contractor as any).contactMobile}</span>
                    </div>
                  )}
                </div>
              )}
              {(contractor as any).town && (
                <div className="pt-3 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                  <TechnicalLabel>Location</TechnicalLabel>
                  <p className="text-[12px] text-foreground mt-1">
                    {(contractor as any).town}{(contractor as any).postcode ? ` (${(contractor as any).postcode})` : ""}
                  </p>
                </div>
              )}
              {(contractor as any).website && (
                <div className="pt-3 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                  <div className="flex items-center gap-2">
                    <Globe size={12} className="text-muted-foreground" />
                    <a href={(contractor as any).website} target="_blank" rel="noopener noreferrer" className="text-[12px] text-blue-600 hover:underline" data-testid="link-website">
                      {(contractor as any).website}
                    </a>
                  </div>
                </div>
              )}
              {contractor.notes && (
                <div className="pt-3 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                  <TechnicalLabel>Notes</TechnicalLabel>
                  <p className="text-[12px] text-muted-foreground mt-1" data-testid="text-notes">{contractor.notes}</p>
                </div>
              )}
            </div>
          </LuxuryCard>

          {((contractor as any).insuranceStatus || (contractor as any).decennaleInsurer || (contractor as any).rcProInsurer) && (
            <LuxuryCard data-testid="card-insurance" className="md:col-span-1">
              <div className="flex items-center gap-2 mb-4">
                <Shield size={14} className="text-muted-foreground" />
                <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">
                  Insurance
                </h3>
                {(contractor as any).insuranceStatus && (
                  <StatusBadge status={(contractor as any).insuranceStatus} size="sm" />
                )}
              </div>
              <div className="space-y-4">
                {(contractor as any).decennaleInsurer && (
                  <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                    <TechnicalLabel>Décennale</TechnicalLabel>
                    <p className="text-[12px] text-foreground mt-1">{(contractor as any).decennaleInsurer}</p>
                    {(contractor as any).decennalePolicyNumber && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">Policy: {(contractor as any).decennalePolicyNumber}</p>
                    )}
                    {(contractor as any).decennaleEndDate && (
                      <p className="text-[10px] text-muted-foreground">Expires: {(contractor as any).decennaleEndDate}</p>
                    )}
                  </div>
                )}
                {(contractor as any).rcProInsurer && (
                  <div className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                    <TechnicalLabel>RC Pro</TechnicalLabel>
                    <p className="text-[12px] text-foreground mt-1">{(contractor as any).rcProInsurer}</p>
                    {(contractor as any).rcProPolicyNumber && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">Policy: {(contractor as any).rcProPolicyNumber}</p>
                    )}
                    {(contractor as any).rcProEndDate && (
                      <p className="text-[10px] text-muted-foreground">Expires: {(contractor as any).rcProEndDate}</p>
                    )}
                  </div>
                )}
                {(contractor as any).specialConditions && (
                  <div>
                    <TechnicalLabel>Special Conditions</TechnicalLabel>
                    <p className="text-[12px] text-muted-foreground mt-1">{(contractor as any).specialConditions}</p>
                  </div>
                )}
              </div>
            </LuxuryCard>
          )}

          <div className="md:col-span-2 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <LuxuryCard data-testid="card-total-devis">
                <TechnicalLabel>Total Devis HT</TechnicalLabel>
                <p className="text-[18px] font-light text-foreground mt-2" data-testid="text-total-devis">
                  {formatCurrency(totalDevisHt)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {contractorDevis?.length ?? 0} devis
                </p>
              </LuxuryCard>
              <LuxuryCard data-testid="card-total-invoiced">
                <TechnicalLabel>Total Invoiced HT</TechnicalLabel>
                <p className="text-[18px] font-light text-emerald-600 dark:text-emerald-400 mt-2" data-testid="text-total-invoiced">
                  {formatCurrency(totalInvoicedHt)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {contractorInvoices?.length ?? 0} invoices
                </p>
              </LuxuryCard>
            </div>
          </div>
        </div>

        <LuxuryCard data-testid="card-contractor-devis">
          <div className="flex items-center gap-2 mb-4">
            <FileText size={14} className="text-muted-foreground" />
            <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">
              Devis ({contractorDevis?.length ?? 0})
            </h3>
          </div>
          {contractorDevis && contractorDevis.length > 0 ? (
            <div className="space-y-2">
              {contractorDevis.map((d) => {
                const proj = projectMap.get(d.projectId);
                return (
                  <div
                    key={d.id}
                    className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] flex items-center justify-between gap-3 flex-wrap"
                    data-testid={`row-devis-${d.id}`}
                  >
                    <div className="min-w-0">
                      <TechnicalLabel>{d.devisCode}</TechnicalLabel>
                      <p className="text-[12px] text-foreground mt-0.5 truncate">{d.descriptionFr}</p>
                      {proj && (
                        <Link href={`/projets/${proj.id}`}>
                          <span className="text-[10px] text-muted-foreground hover:underline" data-testid={`link-project-${proj.id}`}>
                            Project: {proj.name} ({proj.code})
                          </span>
                        </Link>
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-[12px] font-semibold text-foreground">{formatCurrency(parseFloat(d.amountHt))} HT</span>
                      <StatusBadge status={d.status} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground text-center py-6">
              No Devis associated with this contractor.
            </p>
          )}
        </LuxuryCard>

        <LuxuryCard data-testid="card-contractor-invoices">
          <div className="flex items-center gap-2 mb-4">
            <Receipt size={14} className="text-muted-foreground" />
            <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">
              Invoices ({contractorInvoices?.length ?? 0})
            </h3>
          </div>
          {contractorInvoices && contractorInvoices.length > 0 ? (
            <div className="space-y-2">
              {contractorInvoices.map((inv) => {
                const proj = projectMap.get(inv.projectId);
                return (
                  <div
                    key={inv.id}
                    className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] flex items-center justify-between gap-3 flex-wrap"
                    data-testid={`row-invoice-${inv.id}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <TechnicalLabel>F{inv.invoiceNumber}</TechnicalLabel>
                        {inv.certificateNumber && (
                          <TechnicalLabel>{inv.certificateNumber}</TechnicalLabel>
                        )}
                      </div>
                      {proj && (
                        <Link href={`/projets/${proj.id}`}>
                          <span className="text-[10px] text-muted-foreground hover:underline" data-testid={`link-invoice-project-${proj.id}`}>
                            Project: {proj.name} ({proj.code})
                          </span>
                        </Link>
                      )}
                      {inv.dateIssued && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">{inv.dateIssued}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="text-right">
                        <span className="text-[12px] font-semibold text-foreground block">{formatCurrency(parseFloat(inv.amountHt))} HT</span>
                        <span className="text-[10px] text-muted-foreground">{formatCurrency(parseFloat(inv.amountTtc))} TTC</span>
                      </div>
                      <StatusBadge status={inv.status} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground text-center py-6">
              No invoices associated with this contractor.
            </p>
          )}
        </LuxuryCard>
      </div>
    </AppLayout>
  );
}
