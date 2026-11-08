import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, projectScopedKey, ApiError } from "@/lib/queryClient";
import { currentNextAction, isNextActionDependency, nextActionsFresh } from "@/lib/quotation-next-actions";
import type { NextActionExplanation, ProjectNextActions, QuotationNextAction } from "@shared/quotation-next-actions";

export function useQuotationNextActions(projectId: string, enabled = true) {
  const client = useQueryClient();
  const [, tick] = useState(0);
  const key = projectScopedKey(projectId, "quotation-next-actions");
  const query = useQuery<ProjectNextActions>({
    queryKey: key,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/projects/${projectId}/quotation-next-actions`);
      const data: ProjectNextActions = await response.json();
      if (data.projectId !== Number(projectId) || !data.quotations || !nextActionsFresh(data)) {
        throw new Error("Current quotation guidance is unavailable.");
      }
      return data;
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  // Time passing alone must not leave an old response looking authoritative.
  useEffect(() => {
    const timer = window.setInterval(() => tick(value => value + 1), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queryKey = projectScopedKey(projectId, "quotation-next-actions");
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || !["invalidate", "success"].includes(event.action.type) ||
        !isNextActionDependency(event.query.queryKey, projectId)) return;
      // Immediately mark unknown; coalesce dependent invalidations/refetches.
      void client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
      clearTimeout(timer);
      timer = setTimeout(() => { void client.refetchQueries({ queryKey, exact: true, type: "active" }); }, 75);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [client, projectId, enabled]);

  const unknown = !enabled || query.isError || !nextActionsFresh(query.data) ||
    (query.isStale && client.getQueryState(key)?.isInvalidated === true);

  async function revalidate(action: QuotationNextAction) {
    // refetch always reaches the server, even with globally infinite staleTime.
    const fresh = await query.refetch();
    if (fresh.isError || !fresh.data || client.getQueryState(key)?.isInvalidated) {
      throw new Error("Guidance could not be verified. Retry before continuing.");
    }
    return currentNextAction(fresh.data, action);
  }

  async function explain(action: QuotationNextAction): Promise<NextActionExplanation> {
    await revalidate(action);
    try {
      const response = await apiRequest("POST", `/api/projects/${projectId}/quotation-next-actions/explain`, {
        devisId: action.devisId, actionId: action.id,
      });
      const result: NextActionExplanation = await response.json();
      if (result.actionId !== action.id || !["ai", "fallback"].includes(result.source) || typeof result.explanation !== "string") {
        throw new Error("Explanation unavailable. The factual guidance above remains the source of truth.");
      }
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await client.invalidateQueries({ queryKey: key, exact: true });
        throw new Error("This action is no longer current. Review the refreshed flag.");
      }
      throw error;
    }
  }

  return { data: query.data, unknown, loading: query.isLoading, fetching: query.isFetching,
    error: query.isError, retry: () => query.refetch(), revalidate, explain };
}

export type QuotationNextActionsController = ReturnType<typeof useQuotationNextActions>;
