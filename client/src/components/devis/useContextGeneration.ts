import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DevisLineContext } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { quotationWorkBlocked, setQuotationWork } from "./quotation-review-state";

export interface ContextGenerationState {
  running: boolean;
  completed: number;
  skipped: number;
  failed: number;
  error: string | null;
}

export interface GeneratedLineContext {
  context: DevisLineContext;
  sources: Array<{ title: string; uri: string }>;
  warning: string | null;
}

function assertGenerationAllowed(devisId: number, disabled: boolean) {
  if (disabled || quotationWorkBlocked(devisId)) {
    throw new Error("Save the working draft and reopen for review before generating context.");
  }
}

export function useGenerateLineContext(devisId: number, lineItemId: number, disabled: boolean) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<GeneratedLineContext> => {
      assertGenerationAllowed(devisId, disabled);
      const key = `context-generation-request:${lineItemId}`;
      setQuotationWork(devisId, key, true, "An AI context draft is being prepared.");
      try {
        return await (await apiRequest("POST", `/api/devis/${devisId}/line-contexts/${lineItemId}/generate`, {})).json();
      } finally {
        setQuotationWork(devisId, key, false);
      }
    },
    onSuccess: () => {
      // Never push generated text into an editor: its existing revision,
      // debounce, recovery and conflict guards decide whether to adopt it.
      void client.invalidateQueries({ queryKey: ["/api/devis", devisId, "line-contexts"] });
      void client.invalidateQueries({ predicate: query => query.queryKey.includes("devis-readiness") });
    },
  });
}

export function useContextGeneration(devisId: number, disabled: boolean, translationStatus: string) {
  const client = useQueryClient();
  const queryKey = ["/api/devis", devisId, "context-generation"];
  const state = useQuery<ContextGenerationState>({
    queryKey,
    queryFn: async () => (await apiRequest("GET", `/api/devis/${devisId}/context-generation`)).json(),
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchInterval: query => query.state.data?.running ? 2000 : false,
    retry: false,
  });
  const previousStatus = useRef(translationStatus);
  useEffect(() => {
    // A translation can start its fill-empty job after our initial GET.
    if (previousStatus.current !== translationStatus) {
      previousStatus.current = translationStatus;
      void client.invalidateQueries({ queryKey: ["/api/devis", devisId, "context-generation"] });
    }
  }, [client, devisId, translationStatus]);
  const { completed, skipped, failed, running } = state.data ?? {};
  useEffect(() => {
    if (running === undefined) return;
    void client.invalidateQueries({ queryKey: ["/api/devis", devisId, "line-contexts"] });
    void client.invalidateQueries({ predicate: query => query.queryKey.includes("devis-readiness") });
  }, [client, devisId, completed, skipped, failed, running]);
  useEffect(() => {
    const key = "context-generation-bulk";
    setQuotationWork(devisId, key, !!running, "AI context drafts are being prepared. Review them before approval.");
    return () => setQuotationWork(devisId, key, false);
  }, [devisId, running]);
  const start = useMutation({
    mutationFn: async () => {
      assertGenerationAllowed(devisId, disabled);
      if (!state.data || state.data.running || state.isError) throw new Error("Check context generation status before retrying.");
      const key = "context-generation-start";
      setQuotationWork(devisId, key, true, "AI context generation is starting.");
      try {
        await apiRequest("POST", `/api/devis/${devisId}/context-generation`, {});
        await client.invalidateQueries({ queryKey });
      } finally {
        setQuotationWork(devisId, key, false);
      }
    },
  });
  return { state, start };
}
