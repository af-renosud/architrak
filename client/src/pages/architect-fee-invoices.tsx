import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState } from "react";
import { FileText, ExternalLink, XCircle, ReceiptEuro } from "lucide-react";
import type { ArchitectFeeInvoice } from "@shared/schema";

import { Amount } from "@/components/ui/amount";

interface RankedProject {
  projectId: number;
  score: number;
  reasons: string[];
  name: string;
  clientName: string;
}

interface RankedMilestone {
  milestoneId: number;
  score: number;
  reasons: string[];
  labelFr: string;
  sequence: number;
  amountTtc: string;
}

interface RankedWorksFee {
  feeEntryId: number;
  score: number;
  reasons: string[];
  feeAmount: string;
  contractorName: string | null;
  devisNumber: string | null;
  contractorInvoiceNumber: string | null;
}

interface CandidatesPayload {
  projects: RankedProject[];
  highConfidenceProjectId: number | null;
  milestones: Record<string, RankedMilestone[]>;
  /** Task #430 — pending works-commission fee entries per project. */
  worksFees?: Record<string, RankedWorksFee[]>;
}

const statusLabels: Record<string, string> = {
  pending_review: "À vérifier",
  confirmed: "Confirmée",
  dismissed: "Écartée",
};

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending_review: "default",
  confirmed: "secondary",
  dismissed: "outline",
};

function ConfirmControls({ row, candidates }: { row: ArchitectFeeInvoice; candidates: CandidatesPayload }) {
  const { toast } = useToast();
  const [projectId, setProjectId] = useState<string>(() =>
    candidates.highConfidenceProjectId != null
      ? String(candidates.highConfidenceProjectId)
      : candidates.projects.length === 1
        ? String(candidates.projects[0].projectId)
        : "",
  );
  const milestonesForProject = projectId ? (candidates.milestones[projectId] ?? []) : [];
  const worksForProject = projectId ? (candidates.worksFees?.[projectId] ?? []) : [];
  // Binding value: "m:<milestoneId>" (jalon) or "w:<feeEntryId>" (commission travaux).
  const [binding, setBinding] = useState<string>("");

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const [kind, idStr] = binding.split(":");
      const body =
        kind === "w"
          ? { projectId: Number(projectId), feeEntryId: Number(idStr) }
          : { projectId: Number(projectId), milestoneId: Number(idStr) };
      const res = await apiRequest("POST", `/api/architect-fee-invoices/${row.id}/confirm`, body);
      return res.json();
    },
    onSuccess: (data: { reconciliation: string; feeEntryId: number; milestoneId: number | null }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/architect-fee-invoices"] });
      const how =
        data.reconciliation === "created"
          ? "Jalon marqué facturé — nouvelle écriture d'honoraires créée"
          : data.reconciliation === "invoiced_works_entry"
            ? "Commission travaux facturée — écriture existante enregistrée"
            : data.milestoneId != null
              ? "Jalon marqué facturé — rattachée à l'écriture Pennylane existante"
              : "Rattachée à l'écriture Pennylane existante";
      toast({ title: "Facture confirmée", description: `${how} (n°${data.feeEntryId}).` });
    },
    onError: (err: Error) => {
      toast({ title: "Confirmation refusée", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Select
        value={projectId}
        onValueChange={(v) => {
          setProjectId(v);
          setBinding("");
        }}
      >
        <SelectTrigger className="w-44" data-testid={`select-fee-invoice-project-${row.id}`}>
          <SelectValue placeholder="Projet…" />
        </SelectTrigger>
        <SelectContent>
          {candidates.projects.map((p) => (
            <SelectItem key={p.projectId} value={String(p.projectId)}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={binding}
        onValueChange={setBinding}
        disabled={!projectId || (milestonesForProject.length === 0 && worksForProject.length === 0)}
      >
        <SelectTrigger className="w-64" data-testid={`select-fee-invoice-milestone-${row.id}`}>
          <SelectValue
            placeholder={
              milestonesForProject.length === 0 && worksForProject.length === 0
                ? "Aucun rattachement"
                : "Jalon ou commission…"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {milestonesForProject.map((m) => (
            <SelectItem key={`m:${m.milestoneId}`} value={`m:${m.milestoneId}`}>
              Jalon #{m.sequence} · {m.labelFr}
            </SelectItem>
          ))}
          {worksForProject.map((w) => (
            <SelectItem
              key={`w:${w.feeEntryId}`}
              value={`w:${w.feeEntryId}`}
              data-testid={`option-fee-invoice-works-${row.id}-${w.feeEntryId}`}
            >
              Commission travaux · {w.contractorName ?? "?"}
              {w.devisNumber ? ` (devis ${w.devisNumber})` : ""} — <Amount value={parseFloat(w.feeAmount ?? "0")} denomination="HT" />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              size="sm"
              disabled={!projectId || !binding || confirmMutation.isPending}
              onClick={() => confirmMutation.mutate()}
              data-testid={`button-fee-invoice-confirm-${row.id}`}
            >
              Confirmer
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Marque le jalon comme facturé et enregistre l'écriture d'honoraires (rapprochement Pennylane automatique).
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export default function ArchitectFeeInvoices() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("pending_review");

  const { data: rows, isLoading } = useQuery<ArchitectFeeInvoice[]>({
    queryKey: ["/api/architect-fee-invoices", { status: statusFilter }],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/architect-fee-invoices?status=${encodeURIComponent(statusFilter)}`);
      return res.json();
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/architect-fee-invoices/${id}/dismiss`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/architect-fee-invoices"] });
      toast({ title: "Facture écartée", description: "Cette facture d'honoraires ne sera plus proposée." });
    },
    onError: (err: Error) => {
      toast({ title: "Échec", description: err.message, variant: "destructive" });
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
            {rows.map((row) => {
              const candidates = (row.candidates ?? { projects: [], highConfidenceProjectId: null, milestones: {} }) as CandidatesPayload;
              return (
                <LuxuryCard key={row.id} className="p-5" data-testid={`card-fee-invoice-${row.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
                        <span className="font-medium truncate" data-testid={`text-fee-invoice-ref-${row.id}`}>
                          {row.invoiceNumber ?? row.fileName ?? `Facture #${row.id}`}
                        </span>
                        <Badge variant={statusVariant[row.status] ?? "outline"} data-testid={`badge-fee-invoice-status-${row.id}`}>
                          {statusLabels[row.status] ?? row.status}
                        </Badge>
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground space-x-3">
                        {row.clientName && <span>Client : {row.clientName}</span>}
                        {row.devisNumber && (
                          <span data-testid={`text-fee-invoice-devis-ref-${row.id}`}>Réf. devis : {row.devisNumber}</span>
                        )}
                        {row.issueDate && <span>Émise le {row.issueDate}</span>}
                        {row.fileName && <span className="break-all">{row.fileName}</span>}
                      </div>
                      <div className="mt-2 flex gap-4 text-sm">
                        <span>HT {row.amountHt != null ? <Amount value={parseFloat(row.amountHt)} denomination="none" /> : "—"}</span>
                        <span>TVA {row.tvaAmount != null ? <Amount value={parseFloat(row.tvaAmount)} denomination="none" /> : "—"}</span>
                        <span className="font-medium">TTC {row.amountTtc != null ? <Amount value={parseFloat(row.amountTtc)} denomination="none" /> : "—"}</span>
                      </div>
                      {row.identityReason && (
                        <p className="mt-2 text-xs text-muted-foreground">Identification : {row.identityReason}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {row.emailDocumentId != null && (
                        <Button asChild variant="outline" size="sm" data-testid={`button-fee-invoice-pdf-${row.id}`}>
                          <a href={`/api/email-documents/${row.emailDocumentId}/download`} target="_blank" rel="noreferrer">
                            <ExternalLink className="w-4 h-4 mr-1" /> PDF
                          </a>
                        </Button>
                      )}
                      {row.status === "pending_review" && (
                        <>
                          <ConfirmControls row={row} candidates={candidates} />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => dismissMutation.mutate(row.id)}
                            disabled={dismissMutation.isPending}
                            data-testid={`button-fee-invoice-dismiss-${row.id}`}
                          >
                            <XCircle className="w-4 h-4 mr-1" /> Écarter
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {candidates.projects.length > 0 && (
                    <div className="mt-4 border-t pt-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Projets suggérés</p>
                      <div className="space-y-2">
                        {candidates.projects.map((p) => (
                          <div key={p.projectId} className="text-sm" data-testid={`text-fee-invoice-candidate-${row.id}-${p.projectId}`}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium">{p.name}</span>
                              <span className="text-muted-foreground">({p.clientName})</span>
                              {candidates.highConfidenceProjectId === p.projectId && (
                                <Badge variant="secondary">Correspondance forte</Badge>
                              )}
                              <span className="text-xs text-muted-foreground">score {p.score}</span>
                            </div>
                            <p className="text-xs text-muted-foreground">{p.reasons.join(" · ")}</p>
                            {(candidates.milestones[String(p.projectId)] ?? []).length > 0 && (
                              <ul className="mt-1 ml-4 list-disc text-xs text-muted-foreground">
                                {candidates.milestones[String(p.projectId)].map((m) => (
                                  <li key={m.milestoneId}>
                                    Jalon #{m.sequence} · {m.labelFr} — {m.amountTtc != null ? <Amount value={parseFloat(m.amountTtc)} denomination="TTC" /> : "—"} ({m.reasons.join(", ")})
                                  </li>
                                ))}
                              </ul>
                            )}
                            {(candidates.worksFees?.[String(p.projectId)] ?? []).length > 0 && (
                              <ul className="mt-1 ml-4 list-disc text-xs text-muted-foreground">
                                {(candidates.worksFees?.[String(p.projectId)] ?? []).map((w) => (
                                  <li key={w.feeEntryId} data-testid={`text-fee-invoice-works-candidate-${row.id}-${w.feeEntryId}`}>
                                    Commission travaux · {w.contractorName ?? "?"}
                                    {w.devisNumber ? ` (devis ${w.devisNumber})` : ""} — <Amount value={parseFloat(w.feeAmount ?? "0")} denomination="HT" /> ({w.reasons.join(", ")})
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {candidates.projects.length === 0 && row.status === "pending_review" && (
                    <p className="mt-4 border-t pt-3 text-sm text-muted-foreground">
                      Aucun projet candidat identifié — rapprochement manuel nécessaire.
                    </p>
                  )}
                </LuxuryCard>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
