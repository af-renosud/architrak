import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Award, Send, Loader2, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, projectScopedKey, ApiError } from "@/lib/queryClient";
import type { Devis, Certificat } from "@shared/schema";

/**
 * Task #539 — per-devis certificat section, rendered immediately below the
 * electronic-signature panel so the workflow reads linearly:
 * devis → signature → certificat de paiement.
 *
 * Lists the certificats for this devis's contractor on this project and
 * exposes the SAME send action as the Communications tab (same endpoint,
 * same banking-gate error translation). Certificats are per contractor +
 * project (not per individual devis), which is also how the send endpoint
 * validates them.
 *
 * Visibility: hidden until the devis reaches the signing stages (same set
 * as SigningPanel) — earlier stages have nothing meaningful to show. Once
 * signed with no certificat yet, shows an explicit empty state pointing to
 * the existing creation flow.
 */
const STAGES_SHOWING_PANEL = new Set([
  "approved_for_signing",
  "sent_to_client",
  "client_signed_off",
  "void",
]);

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
  ready: { label: "Ready to send", className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200" },
  sent: { label: "Sent", className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" },
  paid: { label: "Paid", className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" },
  superseded: { label: "Superseded", className: "bg-muted text-muted-foreground line-through" },
};

function formatEur(value: string): string {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);
}

export function CertificatPanel({
  devisId,
  projectId,
  isArchived,
}: {
  devisId: number;
  projectId: number | string;
  isArchived: boolean;
}) {
  const { toast } = useToast();

  const devisQuery = useQuery<Devis>({ queryKey: ["/api/devis", devisId] });
  const d = devisQuery.data;

  const certsQuery = useQuery<Certificat[]>({
    queryKey: projectScopedKey(projectId, "certificats"),
    enabled: Boolean(d),
  });

  // Task #539 — the dashboard's unsent list shares the SAME server-side
  // definition; invalidated after every send so both surfaces agree.
  const sendMutation = useMutation({
    mutationFn: async (certId: number) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/certificats/${certId}/send`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Certificat sent" });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "certificats") });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "communications") });
      queryClient.invalidateQueries({ queryKey: ["/api/certificats/unsent"] });
    },
    onError: (error: Error) => {
      // Same banking-gate translation as the Communications tab send.
      if (error instanceof ApiError && error.status === 422) {
        const data = error.data as { contractorName?: string } | undefined;
        toast({
          title: "Banking details issue",
          description:
            error.message +
            (data?.contractorName ? ` (${data.contractorName})` : ""),
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Send failed", description: error.message, variant: "destructive" });
    },
  });

  const certs = useMemo(() => {
    if (!d || !certsQuery.data) return [];
    return certsQuery.data.filter(
      (c) => c.contractorId === d.contractorId && c.status !== "superseded",
    );
  }, [d, certsQuery.data]);

  if (!d) return null;
  const stage = d.signOffStage as string | null | undefined;
  if (!stage || !STAGES_SHOWING_PANEL.has(stage)) return null;

  const isSignedOff = stage === "client_signed_off";
  // Nothing to say before sign-off if no certificat exists yet.
  if (certs.length === 0 && !isSignedOff) return null;

  return (
    <LuxuryCard className="p-3 space-y-2" data-testid={`panel-certificat-${devisId}`}>
      <div className="flex items-center gap-2">
        <Award className="h-4 w-4 text-[#0B2545]" />
        <TechnicalLabel className="text-sm">Certificat de paiement</TechnicalLabel>
      </div>

      {certs.length === 0 ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2"
          data-testid={`empty-certificat-${devisId}`}
        >
          <p className="text-[11px] text-amber-900 dark:text-amber-200">
            The devis is signed but no certificat de paiement exists yet for this contractor.
          </p>
          <Link href="/certificats">
            <Button variant="outline" size="sm" data-testid={`link-create-certificat-${devisId}`}>
              <ExternalLink size={12} />
              <span className="text-[9px] font-bold uppercase tracking-widest">Create certificat</span>
            </Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-1.5">
          {certs.map((cert) => {
            const badge = STATUS_LABEL[cert.status] ?? {
              label: cert.status,
              className: "bg-muted text-muted-foreground",
            };
            return (
              <div
                key={cert.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
                data-testid={`row-devis-certificat-${cert.id}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] font-semibold text-foreground truncate">
                    {cert.certificateRef}
                  </span>
                  <Badge className={`text-[9px] ${badge.className}`} data-testid={`badge-devis-cert-status-${cert.id}`}>
                    {badge.label}
                  </Badge>
                  {cert.isSolde && (
                    <Badge variant="outline" className="text-[9px]">Solde</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-semibold text-foreground whitespace-nowrap">
                    {formatEur(cert.netToPayTtc)}
                  </span>
                  {cert.status === "ready" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={sendMutation.isPending || isArchived}
                      onClick={() => sendMutation.mutate(cert.id)}
                      data-testid={`button-devis-send-cert-${cert.id}`}
                    >
                      {sendMutation.isPending ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Send size={12} />
                      )}
                      <span className="text-[9px] font-bold uppercase tracking-widest">Send</span>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </LuxuryCard>
  );
}
