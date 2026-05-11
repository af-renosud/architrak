import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, Copy, Check, Coins } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { useToast } from "@/hooks/use-toast";
import {
  buildFeeInvoiceDescription,
  type OutstandingFeeEntry,
  type OutstandingFeeSummary,
} from "@shared/fee-description";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

interface Props {
  scope: "global" | "project";
  projectId?: number;
  /** Hide the per-entry list; only show summary + buckets. */
  compact?: boolean;
}

function CopyButton({ entry }: { entry: OutstandingFeeEntry }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const text = buildFeeInvoiceDescription({
      contractorName: entry.contractorName,
      invoiceNumber: entry.invoiceNumber,
      devisCode: entry.devisCode,
      amountHt: entry.amountHt,
      amountTtc: entry.amountTtc,
      feePercentage: entry.feePercentage,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ title: "Invoice description copied" });
    } catch {
      toast({
        title: "Copy failed",
        description: "Clipboard unavailable. Select and copy manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 px-2 border-[#c1a27b]/40 text-[#0B2545] hover:bg-[#c1a27b]/10"
      onClick={onCopy}
      data-testid={`button-copy-fee-desc-${entry.entryId}`}
      title="Copy invoice description for accounting"
    >
      {copied ? <Check size={12} className="mr-1" /> : <Copy size={12} className="mr-1" />}
      <span className="text-[9px] font-bold uppercase tracking-widest">
        {copied ? "Copied" : "Copy"}
      </span>
    </Button>
  );
}

export function OutstandingFeesPanel({ scope, projectId, compact }: Props) {
  const queryKey = scope === "global"
    ? ["/api/fees/outstanding"]
    : ["/api/projects", projectId !== undefined ? String(projectId) : "", "fees", "outstanding"];

  const { data, isLoading } = useQuery<OutstandingFeeSummary>({
    queryKey,
    enabled: scope === "global" || (projectId !== undefined && projectId > 0),
  });

  if (isLoading) {
    return (
      <LuxuryCard data-testid="card-outstanding-fees-loading">
        <Skeleton className="h-4 w-48 mb-2" />
        <Skeleton className="h-3 w-32" />
      </LuxuryCard>
    );
  }

  if (!data || data.totalCount === 0) {
    return (
      <LuxuryCard data-testid="card-outstanding-fees-empty">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30">
            <Check size={14} className="text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <p className="text-[12px] font-semibold text-foreground">
              No outstanding architect fees
            </p>
            <p className="text-[10px] text-muted-foreground">
              Every approved invoice has its commission entry invoiced in Penny Lane.
            </p>
          </div>
        </div>
      </LuxuryCard>
    );
  }

  return (
    <LuxuryCard data-testid="card-outstanding-fees">
      <div className="flex items-start gap-3 mb-4 flex-wrap">
        <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 shrink-0">
          <Coins size={14} className="text-amber-600 dark:text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground" data-testid="text-outstanding-fees-title">
              Outstanding Architect Fees
            </h3>
            <span
              className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full bg-amber-500 text-white text-[10px] font-bold"
              data-testid="badge-outstanding-count"
            >
              {data.totalCount}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Approved invoices missing a Penny Lane commission reference. Total fees:{" "}
            <span className="font-semibold text-foreground" data-testid="text-outstanding-total">
              {formatCurrency(data.totalFeeHt)} HT
            </span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4" data-testid="grid-outstanding-buckets">
        {data.buckets.map((b) => (
          <div
            key={b.label}
            className={`rounded-xl border p-2.5 ${
              b.label === "90+"
                ? "border-red-300 bg-red-50/60 dark:border-red-800 dark:bg-red-950/30"
                : b.label === "61-90"
                ? "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30"
                : "border-border bg-muted/30"
            }`}
            data-testid={`bucket-${b.label}`}
          >
            <TechnicalLabel>{b.label} days</TechnicalLabel>
            <p className="text-[16px] font-light text-foreground mt-1" data-testid={`bucket-count-${b.label}`}>
              {b.count}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {formatCurrency(b.totalFeeHt)}
            </p>
          </div>
        ))}
      </div>

      {scope === "global" && data.byProject.length > 0 && (
        <div className="mb-4" data-testid="section-outstanding-by-project">
          <TechnicalLabel>By Project</TechnicalLabel>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {data.byProject.map((p) => (
              <Link key={p.projectId} href={`/projets/${p.projectId}?tab=honoraires&filter=outstanding`}>
                <div
                  className="rounded-lg border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] p-2 hover-elevate cursor-pointer"
                  data-testid={`row-outstanding-project-${p.projectId}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-widest text-[#0B2545] truncate">
                      {p.projectCode}
                    </span>
                    <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                      {formatCurrency(p.totalFeeHt)}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {p.count} entry{p.count === 1 ? "" : "s"} · oldest {p.oldestAgeDays}d
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {!compact && (
        <div className="space-y-2" data-testid="list-outstanding-entries">
          {data.entries.map((e) => (
            <div
              key={e.entryId}
              className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] flex items-center justify-between gap-3 flex-wrap"
              data-testid={`row-outstanding-entry-${e.entryId}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  {scope === "global" && (
                    <Link href={`/projets/${e.projectId}`}>
                      <span
                        className="text-[10px] font-bold uppercase tracking-widest text-[#0B2545] hover:underline cursor-pointer"
                        data-testid={`link-outstanding-project-${e.entryId}`}
                      >
                        {e.projectCode}
                      </span>
                    </Link>
                  )}
                  <span className="text-[12px] font-semibold text-foreground truncate" data-testid={`text-outstanding-contractor-${e.entryId}`}>
                    {e.contractorName ?? "Unknown contractor"}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 text-[10px] font-semibold ${
                      e.ageDays > 90
                        ? "text-red-600 dark:text-red-400"
                        : e.ageDays > 60
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground"
                    }`}
                    data-testid={`text-outstanding-age-${e.entryId}`}
                  >
                    {e.ageDays > 60 && <AlertTriangle size={10} />}
                    {e.ageDays}d
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                  Facture {e.invoiceNumber ?? "—"}
                  {e.devisCode ? ` · Devis ${e.devisCode}` : ""}
                  {" · "}HT {formatCurrency(e.amountHt)}
                  {" · "}TTC {formatCurrency(e.amountTtc)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[12px] font-semibold text-amber-600 dark:text-amber-400" data-testid={`text-outstanding-fee-${e.entryId}`}>
                  {formatCurrency(e.feeAmountHt)}
                </span>
                <CopyButton entry={e} />
              </div>
            </div>
          ))}
        </div>
      )}
    </LuxuryCard>
  );
}
