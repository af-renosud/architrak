import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { projectScopedKey } from "@/lib/queryClient";
import type { EmailDocumentWithFiling } from "@shared/email-document-filing";

export const EMAIL_DOCUMENT_POLL_INTERVAL_MS = 5_000;
export const EMAIL_DOCUMENT_POLL_LIMIT_MS = 10 * 60_000;

export function hasActiveEmailDocuments(documents: EmailDocumentWithFiling[] | undefined): boolean {
  return documents?.some((document) =>
    document.filing.state !== "removed" && (document.filing.isActive
    || document.extractionStatus === "pending"
    || document.extractionStatus === "processing"),
  ) ?? false;
}

/** Only the affected project's real query keys, including intake's includeVoid variants. */
export function invalidateEmailDocumentProject(
  client: QueryClient,
  projectId: number,
  kind?: string | null,
) {
  void client.invalidateQueries({ queryKey: projectScopedKey(projectId), exact: true });
  void client.invalidateQueries({ queryKey: projectScopedKey(projectId, "intake") });
  for (const resource of ["documents", "financial-summary", "accounting-status"]) {
    void client.invalidateQueries({ queryKey: projectScopedKey(projectId, resource), exact: true });
  }
  if (!kind || kind === "devis" || kind === "invoice") {
    for (const resource of ["devis", "devis-readiness"]) {
      void client.invalidateQueries({ queryKey: projectScopedKey(projectId, resource), exact: true });
    }
    void client.invalidateQueries({ queryKey: projectScopedKey(projectId, "devis-checks", "open-counts"), exact: true });
  }
  if (!kind || kind === "invoice") {
    void client.invalidateQueries({ queryKey: projectScopedKey(projectId, "invoices"), exact: true });
    void client.invalidateQueries({ queryKey: projectScopedKey(projectId, "certificat-invoice-links"), exact: true });
    // Devis cards also cache their invoice lists separately, with numeric record ids.
    const devis = client.getQueryData<{ id: number }[]>(projectScopedKey(projectId, "devis"));
    for (const record of devis ?? []) {
      void client.invalidateQueries({ queryKey: ["/api/devis", record.id, "invoices"], exact: true });
    }
  }
  if (!kind || kind === "situation") {
    const devis = client.getQueryData<{ id: number }[]>(projectScopedKey(projectId, "devis"));
    for (const record of devis ?? []) {
      void client.invalidateQueries({ queryKey: ["/api/devis", record.id, "situations"], exact: true });
    }
  }
  if (!kind || kind === "marche_document") {
    void client.invalidateQueries({ queryKey: projectScopedKey(projectId, "marche-documents"), exact: true });
  }
}

export function observeEmailDocumentPromotions(
  client: QueryClient,
  documents: EmailDocumentWithFiling[],
  observed: Set<string>,
) {
  const affected = new Map<number, Set<string>>();
  for (const document of documents) {
    const { filing } = document;
    if (
      filing.state !== "filed"
      || filing.projectId == null || filing.promotedId == null || !filing.promotedKind
    ) continue;
    const key = `${document.id}:${filing.projectId}:${filing.promotedKind}:${filing.promotedId}`;
    if (observed.has(key)) continue;
    observed.add(key);
    if (filing.promotedKind === "devis") {
      void client.invalidateQueries({ queryKey: ["/api/devis", filing.promotedId], exact: true });
    } else if (filing.promotedKind === "invoice") {
      void client.invalidateQueries({ queryKey: ["/api/invoices", filing.promotedId, "certificat-preview"], exact: true });
    } else if (filing.promotedKind === "situation") {
      void client.invalidateQueries({ queryKey: ["/api/situations", filing.promotedId, "review"], exact: true });
    }
    const kinds = affected.get(filing.projectId) ?? new Set<string>();
    kinds.add(filing.promotedKind);
    affected.set(filing.projectId, kinds);
  }
  for (const [projectId, kinds] of Array.from(affected)) {
    // A fresh observation session deliberately invalidates existing caches even
    // when extraction was already completed: their global staleTime is Infinity.
    invalidateEmailDocumentProject(client, projectId, kinds.size === 1 ? kinds.values().next().value : undefined);
  }
}

export function useEmailDocuments() {
  const client = useQueryClient();
  const observed = useRef(new Set<string>());
  const deadline = useRef(Date.now() + EMAIL_DOCUMENT_POLL_LIMIT_MS);
  const previouslyActive = useRef(false);
  const [pollingExpired, setPollingExpired] = useState(false);
  const [refreshSession, setRefreshSession] = useState(0);
  const query = useQuery<EmailDocumentWithFiling[]>({
    queryKey: ["/api/email-documents"],
    // Revisit/resume must not reuse a forever-fresh pre-promotion list.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: (current) => {
      const active = hasActiveEmailDocuments(current.state.data);
      // Start the budget before QueryObserver decides whether to schedule its
      // timer, including new jobs appearing after the page was idle for hours.
      if (active && !previouslyActive.current) {
        deadline.current = Date.now() + EMAIL_DOCUMENT_POLL_LIMIT_MS;
      }
      previouslyActive.current = active;
      return current.state.status !== "error" && active
        && !pollingExpired && Date.now() < deadline.current
          ? EMAIL_DOCUMENT_POLL_INTERVAL_MS
          : false;
    },
  });
  const hasActive = hasActiveEmailDocuments(query.data);

  useEffect(() => {
    if (query.data) observeEmailDocumentPromotions(client, query.data, observed.current);
  }, [client, query.data]);

  useEffect(() => {
    if (!hasActive) {
      deadline.current = Date.now() + EMAIL_DOCUMENT_POLL_LIMIT_MS;
      setPollingExpired(false);
      return;
    }
    const timer = window.setTimeout(
      () => setPollingExpired(true),
      Math.max(0, deadline.current - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [hasActive, refreshSession]);

  const refresh = useCallback(() => {
    deadline.current = Date.now() + EMAIL_DOCUMENT_POLL_LIMIT_MS;
    setPollingExpired(false);
    setRefreshSession((session) => session + 1);
    return query.refetch();
  }, [query.refetch]);

  return {
    ...query,
    refresh,
    pollingExpired: hasActive && pollingExpired,
    isPolling: hasActive && !pollingExpired && !query.isError,
  };
}