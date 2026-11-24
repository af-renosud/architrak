import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ReplaceQuotationRequest } from "@shared/quotation-replacement";
import type { ExtractionReviewResponse } from "./use-quotation-extraction-review";
export type PreparedReplacementRequest = ReplaceQuotationRequest;

export function hasPreparedReplacement(data: ExtractionReviewResponse | undefined): boolean {
  return !!data && !data.humanWorkingVersion && Number.isSafeInteger(data.candidateAttemptId)
    && Number(data.candidateAttemptId) > 0;
}

export function usePreparedQuotationReplacement(targetId: number | null) {
  return useQuery<ExtractionReviewResponse>({
    queryKey: [`/api/devis/${targetId}/extraction-review`],
    queryFn: async () => (await apiRequest("GET", `/api/devis/${targetId}/extraction-review`)).json(),
    enabled: targetId !== null,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
}

export function invalidatePreparedReplacement(sourceId: number, targetId: number) {
  for (const id of [sourceId, targetId]) {
    void queryClient.invalidateQueries({ queryKey: [`/api/devis/${id}/extraction-review`] });
  }
  void queryClient.invalidateQueries({ queryKey: ["/api/extraction-review/summary"] });
}
