import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TechnicalLabel } from "@/components/ui/technical-label";

interface LateInvoice {
  invoiceId: number;
  invoiceNumber: string;
  amountHt: number | string;
  amountTtc: number | string;
  reason: string;
  actor: string;
  linkedAt: string;
}

export function CertificateLateInvoicesSection({ certificatId }: { certificatId: number }) {
  const history = useQuery<LateInvoice[]>({
    queryKey: ["/api/certificats", String(certificatId), "late-invoices"],
    queryFn: async () => (await apiRequest("GET", `/api/certificats/${certificatId}/late-invoices`)).json(),
  });
  return (
    <section className="space-y-3 rounded-xl border border-border/60 p-4" data-testid="section-certificate-late-invoices">
      <TechnicalLabel>Factures liées après émission</TechnicalLabel>
      <p className="text-[11px] leading-relaxed text-muted-foreground">Historique des rapprochements documentaires postérieurs à l'émission, distincts des factures sources d'origine. Le PDF émis, les montants et le statut de paiement restent inchangés.</p>
      {history.isLoading ? <Skeleton className="h-16 w-full" /> : history.error ? (
        <div role="alert" className="space-y-2 text-[12px] text-destructive">
          <p>Historique indisponible : {history.error.message}</p>
          <Button variant="outline" size="sm" disabled={history.isFetching} onClick={() => { void history.refetch(); }}>Réessayer</Button>
        </div>
      ) : history.data?.length ? history.data.map((entry) => (
        <div key={entry.invoiceId} className="space-y-2 border-t border-border/60 pt-3 text-[12px]" data-testid={`late-invoice-${entry.invoiceId}`}>
          <p className="font-semibold">Facture #{entry.invoiceNumber}</p>
          <div className="grid grid-cols-2 gap-3 tabular-nums">
            <Amount value={Number(entry.amountHt)} denomination="HT" />
            <Amount value={Number(entry.amountTtc)} denomination="TTC" />
          </div>
          <p className="whitespace-pre-wrap break-words"><span className="text-muted-foreground">Motif : </span>{entry.reason}</p>
          <p className="text-[11px] text-muted-foreground">Liée le {new Date(entry.linkedAt).toLocaleString("fr-FR")} · {entry.actor || "Auteur non renseigné"}</p>
        </div>
      )) : <div className="rounded-lg border border-dashed border-border px-3 py-3 text-[11px] text-muted-foreground">Aucune facture liée après l'émission de ce certificat.</div>}
    </section>
  );
}
