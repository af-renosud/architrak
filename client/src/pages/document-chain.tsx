import { useRoute, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  FileText, FileSignature, Layers, Receipt, FileCheck, AlertTriangle,
  Download, ArrowLeft, Lock, Unlock,
} from "lucide-react";

/**
 * Task #451 — read-only per-devis Document Chain audit view.
 * Devis → (Commande/Marché) → ordered Situations → Factures → Certificat(s),
 * with statuses, dates, amounts, PDF downloads and conspicuous
 * missing-evidence flags. The path adapts to invoicingMode: Mode B routes
 * progress through Situations; Mode A goes straight to Factures.
 */

interface ChainDevis {
  id: number; devisCode: string; status: string; signOffStage: string;
  invoicingMode: string; amountHt: string; amountTtc: string;
  dateSent: string | null; dateSigned: string | null;
  hasSourcePdf: boolean; hasSignedPdf: boolean; projectId: number; contractorId: number;
}
interface ChainMarche {
  id: number; marcheNumber: string | null; status: string;
  signedDate: string | null; totalHt: string; totalTtc: string;
}
interface ChainSituation {
  id: number; situationNumber: number; status: string; dateIssued: string | null;
  cumulativeHt: string; netHt: string; netToPayTtc: string; invoiceId: number | null;
}
interface ChainInvoice {
  id: number; invoiceNumber: string; status: string;
  dateIssued: string | null; dateSent: string | null; datePaid: string | null;
  amountHt: string; amountTtc: string; hasSourcePdf: boolean; certificatIds: number[];
}
interface ChainCertificat {
  id: number; certificateRef: string; status: string;
  dateIssued: string | null; issuedAt: string | null;
  netToPayHt: string; netToPayTtc: string; sealed: boolean;
  sourceInvoiceIds: number[]; sourceSituationIds: number[];
}
interface DocumentChain {
  devis: ChainDevis;
  marche: ChainMarche | null;
  situations: ChainSituation[];
  invoices: ChainInvoice[];
  certificats: ChainCertificat[];
}

function formatCurrency(value: string): string {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return value;
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);
}

function MissingFlag({ label, testId }: { label: string; testId: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-red-50 border border-red-300 px-2 py-0.5 text-[11px] font-bold text-red-700"
      data-testid={testId}
    >
      <AlertTriangle size={11} />
      {label}
    </span>
  );
}

function ChainStep({ icon, title, children, testId }: {
  icon: React.ReactNode; title: string; children: React.ReactNode; testId: string;
}) {
  return (
    <div className="relative pl-8 pb-6 border-l-2 border-[rgba(11,37,69,0.15)] last:border-l-transparent" data-testid={testId}>
      <div className="absolute -left-[15px] top-0 w-7 h-7 rounded-full bg-[#0B2545] text-white flex items-center justify-center">
        {icon}
      </div>
      <div className="ml-2">
        <h3 className="text-[13px] font-black uppercase tracking-wide text-[#0B2545] mb-2">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function DocRow({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl border border-[rgba(0,0,0,0.06)] bg-white/50 mb-2" data-testid={testId}>
      {children}
    </div>
  );
}

export default function DocumentChainPage() {
  const [, params] = useRoute("/devis/:id/document-chain");
  const devisId = params ? Number(params.id) : NaN;

  const { data: chain, isLoading, error } = useQuery<DocumentChain>({
    queryKey: [`/api/devis/${devisId}/document-chain`],
    enabled: Number.isFinite(devisId),
  });

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-4 max-w-3xl">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AppLayout>
    );
  }

  if (error || !chain) {
    return (
      <AppLayout>
        <LuxuryCard className="p-6 max-w-3xl">
          <p className="text-sm text-red-700" data-testid="text-chain-error">
            Could not load the document chain{error instanceof Error ? `: ${error.message}` : "."}
          </p>
        </LuxuryCard>
      </AppLayout>
    );
  }

  const { devis, marche, situations, invoices, certificats } = chain;
  const isModeB = devis.invoicingMode === "mode_b";
  const isSigned = !!devis.dateSigned || devis.status === "signed";

  return (
    <AppLayout>
      <div className="max-w-3xl space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <SectionHeader
            icon={Layers}
            title={`Document Chain — ${devis.devisCode}`}
            subtitle={`Read-only audit trail · ${isModeB ? "Mode B (situation de travaux, % completion)" : "Mode A (tick-off line items)"}`}
          />
          <Link href={`/projets/${devis.projectId}?tab=devis`}>
            <Button variant="outline" size="sm" data-testid="button-back-to-project">
              <ArrowLeft size={14} className="mr-1" /> Back to project
            </Button>
          </Link>
        </div>

        <LuxuryCard className="p-5">
          {/* 1 — Devis */}
          <ChainStep icon={<FileText size={13} />} title="Devis" testId="chain-step-devis">
            <DocRow testId={`chain-devis-${devis.id}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-bold text-[#0B2545]">{devis.devisCode}</span>
                <StatusBadge status={devis.status} />
                <TechnicalLabel>{formatCurrency(devis.amountTtc)} TTC</TechnicalLabel>
                {devis.dateSigned && <TechnicalLabel>Signed {devis.dateSigned}</TechnicalLabel>}
                {!devis.hasSourcePdf && <MissingFlag label="Source PDF missing" testId="flag-devis-source-missing" />}
                {isSigned && !devis.hasSignedPdf && <MissingFlag label="Signed PDF missing" testId="flag-devis-signed-missing" />}
              </div>
              <div className="flex items-center gap-1.5">
                {devis.hasSourcePdf && (
                  <a href={`/api/devis/${devis.id}/pdf?variant=original`} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" data-testid="button-devis-source-pdf"><Download size={13} className="mr-1" />Source</Button>
                  </a>
                )}
                {devis.hasSignedPdf && (
                  <a href={`/api/devis/${devis.id}/signed-pdf`} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" data-testid="button-devis-signed-pdf"><FileSignature size={13} className="mr-1" />Signed</Button>
                  </a>
                )}
              </div>
            </DocRow>
          </ChainStep>

          {/* 2 — Commande / Marché */}
          <ChainStep icon={<FileSignature size={13} />} title="Commande (Marché)" testId="chain-step-marche">
            {marche ? (
              <DocRow testId={`chain-marche-${marche.id}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-bold text-[#0B2545]">{marche.marcheNumber || `Marché #${marche.id}`}</span>
                  <StatusBadge status={marche.status} />
                  <TechnicalLabel>{formatCurrency(marche.totalTtc)} TTC</TechnicalLabel>
                  {marche.signedDate
                    ? <TechnicalLabel>Signed {marche.signedDate}</TechnicalLabel>
                    : <MissingFlag label="Not signed" testId="flag-marche-unsigned" />}
                </div>
              </DocRow>
            ) : (
              <p className="text-[12px] text-muted-foreground italic" data-testid="text-no-marche">
                No marché linked — devis operates outside a signed commande.
              </p>
            )}
          </ChainStep>

          {/* 3 — Situations (Mode B path) */}
          {isModeB && (
            <ChainStep icon={<Layers size={13} />} title="Situations de travaux" testId="chain-step-situations">
              {situations.length === 0 ? (
                <MissingFlag label="No situations recorded" testId="flag-no-situations" />
              ) : (
                situations.map((s) => (
                  <DocRow key={s.id} testId={`chain-situation-${s.id}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-bold text-[#0B2545]">Situation n°{s.situationNumber}</span>
                      <StatusBadge status={s.status} />
                      <TechnicalLabel>Cumul {formatCurrency(s.cumulativeHt)} HT</TechnicalLabel>
                      <TechnicalLabel>Net {formatCurrency(s.netToPayTtc)} TTC</TechnicalLabel>
                      {s.dateIssued && <TechnicalLabel>{s.dateIssued}</TechnicalLabel>}
                      {s.invoiceId == null && <MissingFlag label="No facture linked" testId={`flag-situation-${s.id}-no-invoice`} />}
                    </div>
                  </DocRow>
                ))
              )}
            </ChainStep>
          )}

          {/* 4 — Factures */}
          <ChainStep icon={<Receipt size={13} />} title="Factures" testId="chain-step-invoices">
            {invoices.length === 0 ? (
              <MissingFlag label="No factures recorded" testId="flag-no-invoices" />
            ) : (
              invoices.map((inv) => (
                <DocRow key={inv.id} testId={`chain-invoice-${inv.id}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-bold text-[#0B2545]">Facture #{inv.invoiceNumber}</span>
                    <StatusBadge status={inv.status} />
                    <TechnicalLabel>{formatCurrency(inv.amountTtc)} TTC</TechnicalLabel>
                    {inv.datePaid && <TechnicalLabel>Paid {inv.datePaid}</TechnicalLabel>}
                    {!inv.hasSourcePdf && <MissingFlag label="Source PDF missing" testId={`flag-invoice-${inv.id}-pdf-missing`} />}
                    {inv.certificatIds.length === 0 && <MissingFlag label="Not certified" testId={`flag-invoice-${inv.id}-uncertified`} />}
                  </div>
                  {inv.hasSourcePdf && (
                    <a href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">
                      <Button variant="outline" size="sm" data-testid={`button-invoice-${inv.id}-pdf`}><Download size={13} className="mr-1" />Source</Button>
                    </a>
                  )}
                </DocRow>
              ))
            )}
          </ChainStep>

          {/* 5 — Certificats */}
          <ChainStep icon={<FileCheck size={13} />} title="Certificats de paiement" testId="chain-step-certificats">
            {certificats.length === 0 ? (
              invoices.length > 0
                ? <MissingFlag label="No certificat covers these factures" testId="flag-no-certificats" />
                : <p className="text-[12px] text-muted-foreground italic" data-testid="text-no-certificats">Nothing to certify yet.</p>
            ) : (
              certificats.map((c) => (
                <DocRow key={c.id} testId={`chain-certificat-${c.id}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-bold text-[#0B2545]">{c.certificateRef}</span>
                    <StatusBadge status={c.status} />
                    <TechnicalLabel>Net {formatCurrency(c.netToPayTtc)} TTC</TechnicalLabel>
                    {c.dateIssued && <TechnicalLabel>Issued {c.dateIssued}</TechnicalLabel>}
                    {c.sealed ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-300 px-2 py-0.5 text-[11px] font-bold text-emerald-700" data-testid={`badge-certificat-${c.id}-sealed`}>
                        <Lock size={11} /> Sealed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 border border-amber-300 px-2 py-0.5 text-[11px] font-bold text-amber-700" data-testid={`badge-certificat-${c.id}-draft`}>
                        <Unlock size={11} /> Draft — no pinned PDF
                      </span>
                    )}
                  </div>
                  {c.sealed && (
                    <a href={`/api/certificats/${c.id}/pdf`} target="_blank" rel="noreferrer">
                      <Button variant="outline" size="sm" data-testid={`button-certificat-${c.id}-pdf`}><Download size={13} className="mr-1" />Pinned PDF</Button>
                    </a>
                  )}
                </DocRow>
              ))
            )}
          </ChainStep>
        </LuxuryCard>
      </div>
    </AppLayout>
  );
}
