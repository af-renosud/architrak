import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, projectScopedKey } from "@/lib/queryClient";

export const reviewOutcomes = {
  confirmed_inaccurate: "Confirmed inaccurate",
  unresolved: "Unresolved",
  false_alarm: "False alarm",
  corrected: "Corrected",
} as const;
export const reviewCategories = {
  missing_text: "Missing text",
  wrong_association: "Wrong association",
  quantities: "Quantities",
  prices: "Prices",
  totals: "Totals",
  other: "Other",
} as const;
export interface ExtractionReviewRequest {
  outcome: keyof typeof reviewOutcomes;
  category: keyof typeof reviewCategories;
  reason: string;
  effortMinutes: number;
}
export interface ExtractionReviewEvent {
  id: number | string;
  created_at: string;
  kind: string;
  outcome: string | null;
  category: string | null;
  reason: string | null;
  effort_minutes: number | null;
}
export interface ExtractionReviewResponse {
  running?: boolean;
  events: ExtractionReviewEvent[];
  evidence: unknown;
  sourcePdfUrl: string;
  candidateAttemptId: number | null;
}
export interface ExtractionCandidateApplyRequest {
  attemptId: number;
  reason: string;
  reviewedOriginal: true;
  initialDifferencesAreOcrErrors: true;
}
export interface ExtractionReviewSummary {
  processed: number;
  reviewed: number;
  inaccurate: number;
  repeatFailures: number;
  effortMinutes: number;
  categories: Array<{ category: string; count: number }>;
}
export function useQuotationExtractionReview(devisId: number, days: 7 | 30 | 90, projectId: string) {
  const client = useQueryClient();
  const path = `/api/devis/${devisId}/extraction-review`;
  const review = useQuery<ExtractionReviewResponse>({
    queryKey: [path],
    queryFn: async () => (await apiRequest("GET", path)).json(),
    refetchInterval: query => query.state.data?.running ? 4000 : false,
  });
  const summary = useQuery<ExtractionReviewSummary>({
    queryKey: ["/api/extraction-review/summary", days],
    queryFn: async () => (await apiRequest("GET", `/api/extraction-review/summary?days=${days}`)).json(),
  });
  const record = useMutation({
    mutationFn: async (request: ExtractionReviewRequest) => {
      // No response shape is promised for POST (including a possible 204).
      await apiRequest("POST", path, request);
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: [path] }),
        client.invalidateQueries({ queryKey: ["/api/extraction-review/summary"] }),
      ]);
    },
  });
  const apply = useMutation({
    mutationFn: async (request: ExtractionCandidateApplyRequest) => {
      await apiRequest("POST", `${path}/apply`, request);
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: [path] }),
        client.invalidateQueries({ queryKey: ["/api/devis", devisId] }),
        client.invalidateQueries({ queryKey: [`/api/devis/${devisId}`] }),
        client.invalidateQueries({ queryKey: projectScopedKey(projectId) }),
        client.invalidateQueries({ queryKey: ["/api/extraction-review/summary"] }),
      ]);
    },
  });
  return { review, summary, record, apply };
}