import { useQuery } from "@tanstack/react-query";
import { apiRequest, projectScopedKey, queryClient } from "@/lib/queryClient";
import type { QuotationReplacementHistory, ReplacementOptions } from "@shared/quotation-replacement";
import type { Devis } from "@shared/schema";

export function useQuotationReplacementHistory(projectId: string) {
  return useQuery<QuotationReplacementHistory[]>({
    queryKey: projectScopedKey(projectId, "devis-replacements"),
  });
}

export function useQuotationReplacementOptions(devisId: number) {
  return useQuery<ReplacementOptions>({
    queryKey: ["/api/devis", devisId, "replacement-options"],
    queryFn: async () => (await apiRequest("GET", `/api/devis/${devisId}/replacement-options`)).json(),
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function invalidateQuotationReplacement(projectId: string) {
  for (const resource of ["devis", "financial-summary", "accounting-status", "devis-readiness", "quotation-next-actions", "devis-replacements"]) {
    void queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, resource) });
  }
}

/** Local evidence keeps unavailable actions discoverable before options load. */
export function replacementBlockedReason(d: Devis, isArchived: boolean): string | null {
  if (isArchived) return "This project is archived. Quotations cannot be replaced.";
  if (d.status === "void" || d.signOffStage === "void" || d.accountingState === "void") return "This quotation is void and cannot be replaced.";
  if (d.accountingState === "superseded" || d.status === "superseded") return "This quotation has already been replaced.";
  const terminalEnvelope = ["signed", "declined", "expired", "cancelled", "canceled", "revoked"].includes(d.archisignEnvelopeStatus ?? "");
  if (["created", "draft", "pending", "sent", "viewed", "queried", "partially_signed"].includes(d.archisignEnvelopeStatus ?? "")
    || (d.archisignEnvelopeId && !terminalEnvelope)
    || (d.signOffStage === "sent_to_client" && !terminalEnvelope)) {
    return "A signature request is in flight. Resolve or cancel it before replacing this quotation.";
  }
  return null;
}
