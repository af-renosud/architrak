/**
 * Task #617 — shared review card for a Gmail-detected architect fee invoice.
 * Extracted from the /honoraires/factures-detectees page so the same
 * confirm/dismiss controls can be embedded in the Honoraires-page review
 * banner. `compact` hides the candidate-detail footer for the banner.
 */
import { LuxuryCard } from "@/components/ui/luxury-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState } from "react";
import { FileText, ExternalLink, XCircle } from "lucide-react";
import type { ArchitectFeeInvoice } from "@shared/schema";
import { Amount } from "@/components/ui/amount";

export interface RankedProject {
  projectId: number;
  score: number;
  reasons: string[];
  name: string;
  clientName: string;
}

export interface RankedMilestone {
  milestoneId: number;
  score: number;
  reasons: string[];
  labelFr: string;
  sequence: number;
  amountTtc: string;
}

export interface RankedWorksFee {
  feeEntryId: number;
  score: number;
  reasons: string[];
  feeAmount: string;
  contractorName: string | null;
  devisNumber: string | null;
  contractorInvoiceNumber: string | null;
}

export interface CandidatesPayload {
  projects: RankedProject[];
  highConfidenceProjectId: number | null;
  milestones: Record<string, RankedMilestone[]>;
  /** Task #430 — pending works-commission fee entries per project. */
  worksFees?: Record<string, RankedWorksFee[]>;
}

export const feeInvoiceStatusLabels: Record<string, string> = {
  pending_review: "À vérifier",
  confirmed: "Confirmée",
  dismissed: "Écartée",
};

export const feeInvoiceStatusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending_review: "default",
  confirmed: "secondary",
  dismissed: "outline",
};

/** Pending-review detected fee invoices (shared query for badge counts). */
export function usePendingFeeInvoices() {
  return useQuery<ArchitectFeeInvoice[]>({
    queryKey: ["/api/architect-fee-invoices", { status: "pending_review" }],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/architect-fee-invoices?status=pending_review`);
      return res.json();
    },
  });
}

export function ConfirmControls({ row, candidates }: { row: ArchitectFeeInvoice; candidates: CandidatesPayload }) {
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
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "design-contract"] });
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

export function DetectedFeeInvoiceCard({ row, compact = false }: { row: ArchitectFeeInvoice; compact?: boolean }) {
  const { toast } = useToast();
  const candidates = (row.candidates ?? { projects: [], highConfidenceProjectId: null, milestones: {} }) as CandidatesPayload;

  const dismissMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/architect-fee-invoices/${row.id}/dismiss`);
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
    <LuxuryCard className="p-5" data-testid={`card-fee-invoice-${row.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
            <span className="font-medium truncate" data-testid={`text-fee-invoice-ref-${row.id}`}>
              {row.invoiceNumber ?? row.fileName ?? `Facture #${row.id}`}
            </span>
            <Badge variant={feeInvoiceStatusVariant[row.status] ?? "outline"} data-testid={`badge-fee-invoice-status-${row.id}`}>
              {feeInvoiceStatusLabels[row.status] ?? row.status}
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
          {!compact && row.identityReason && (
            <p className="mt-2 text-xs text-muted-foreground">Identification : {row.identityReason}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
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
                onClick={() => dismissMutation.mutate()}
                disabled={dismissMutation.isPending}
                data-testid={`button-fee-invoice-dismiss-${row.id}`}
              >
                <XCircle className="w-4 h-4 mr-1" /> Écarter
              </Button>
            </>
          )}
        </div>
      </div>

      {!compact && candidates.projects.length > 0 && (
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
      {!compact && candidates.projects.length === 0 && row.status === "pending_review" && (
        <p className="mt-4 border-t pt-3 text-sm text-muted-foreground">
          Aucun projet candidat identifié — rapprochement manuel nécessaire.
        </p>
      )}
    </LuxuryCard>
  );
}
