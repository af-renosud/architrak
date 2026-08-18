import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import { ReceiptEuro } from "lucide-react";
import type { ArchitectFeeInvoice } from "@shared/schema";
import { DetectedFeeInvoiceCard } from "@/components/fees/DetectedFeeInvoiceCard";

export default function ArchitectFeeInvoices() {
  const [statusFilter, setStatusFilter] = useState<string>("pending_review");

  const { data: rows, isLoading } = useQuery<ArchitectFeeInvoice[]>({
    queryKey: ["/api/architect-fee-invoices", { status: statusFilter }],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/architect-fee-invoices?status=${encodeURIComponent(statusFilter)}`);
      return res.json();
    },
  });

  return (
    <AppLayout>
      <div className="space-y-6">
        <SectionHeader
          icon={ReceiptEuro}
          title="Factures d'honoraires détectées"
          subtitle="Factures émises par le cabinet, captées depuis Gmail"
        />

        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48" data-testid="select-fee-invoice-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending_review">À vérifier</SelectItem>
              <SelectItem value="dismissed">Écartées</SelectItem>
              <SelectItem value="confirmed">Confirmées</SelectItem>
              <SelectItem value="all">Toutes</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : !rows || rows.length === 0 ? (
          <LuxuryCard className="p-8 text-center text-muted-foreground" data-testid="text-no-fee-invoices">
            Aucune facture d'honoraires dans cet état.
          </LuxuryCard>
        ) : (
          <div className="space-y-4">
            {rows.map((row) => (
              <DetectedFeeInvoiceCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
