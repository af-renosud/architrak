// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { EmailDocumentWithFiling } from "@shared/email-document-filing";
import {
  EMAIL_DOCUMENT_POLL_INTERVAL_MS,
  EMAIL_DOCUMENT_POLL_LIMIT_MS,
  hasActiveEmailDocuments,
  invalidateEmailDocumentProject,
  observeEmailDocumentPromotions,
  useEmailDocuments,
} from "../use-email-documents";
import { projectScopedKey } from "@/lib/queryClient";

function document(overrides: Partial<EmailDocumentWithFiling["filing"]> = {}, extractionStatus = "completed") {
  return {
    id: 898,
    extractionStatus,
    filing: {
      state: "processing",
      label: "Processing",
      reason: "Analysis has not finished.",
      intakeId: 80,
      projectId: 12,
      promotedKind: null,
      promotedId: null,
      destination: { href: "/projets/12?tab=intake", label: "Open project intake" },
      isActive: true,
      ...overrides,
    },
  } as EmailDocumentWithFiling;
}

function createClient(queryFn = vi.fn().mockResolvedValue([])) {
  return new QueryClient({
    defaultOptions: { queries: { queryFn, retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
}

function wrapper(client: QueryClient) {
  return function Provider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

describe("bounded email filing observations", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("polls completed extraction while intake is active, then stops on filing", async () => {
    let docs = [document()];
    const queryFn = vi.fn(async () => docs);
    const client = createClient(queryFn);
    const { result } = renderHook(() => useEmailDocuments(), { wrapper: wrapper(client) });
    await flush();
    expect(result.current.isPolling).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
    docs = [document({ state: "filed", label: "Added to project", promotedKind: "devis", promotedId: 35, isActive: false })];
    await act(async () => { await vi.advanceTimersByTimeAsync(EMAIL_DOCUMENT_POLL_INTERVAL_MS); });
    await flush();
    expect(result.current.isPolling).toBe(false);
    const terminalCalls = queryFn.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(EMAIL_DOCUMENT_POLL_LIMIT_MS * 2); });
    expect(queryFn).toHaveBeenCalledTimes(terminalCalls);
    client.clear();
  });

  it.each(["needs_review", "duplicate", "failed", "removed", "not_filed", "mismatch"] as const)(
    "never polls a terminal %s filing just because extraction is completed",
    async (state) => {
      const queryFn = vi.fn(async () => [document({ state, isActive: false })]);
      const client = createClient(queryFn);
      const { result } = renderHook(() => useEmailDocuments(), { wrapper: wrapper(client) });
      await flush();
      expect(result.current.isPolling).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(EMAIL_DOCUMENT_POLL_LIMIT_MS * 2); });
      expect(queryFn).toHaveBeenCalledTimes(1);
      client.clear();
    },
  );

  it("caps a stalled job, offers explicit refresh, and starts a new bounded window", async () => {
    const queryFn = vi.fn(async () => [document()]);
    const client = createClient(queryFn);
    const { result } = renderHook(() => useEmailDocuments(), { wrapper: wrapper(client) });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(EMAIL_DOCUMENT_POLL_LIMIT_MS + 1); });
    expect(result.current.pollingExpired).toBe(true);
    expect(result.current.isPolling).toBe(false);
    const expiredCalls = queryFn.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(EMAIL_DOCUMENT_POLL_LIMIT_MS); });
    expect(queryFn).toHaveBeenCalledTimes(expiredCalls);
    await act(async () => { await result.current.refresh(); });
    await flush();
    expect(result.current.pollingExpired).toBe(false);
    expect(result.current.isPolling).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(expiredCalls + 1);
    client.clear();
  });

  it("starts a full bounded window when a new active document appears after an idle list", async () => {
    const queryFn = vi.fn(async () => [document({ state: "needs_review", isActive: false })]);
    const client = createClient(queryFn);
    const { result } = renderHook(() => useEmailDocuments(), { wrapper: wrapper(client) });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(EMAIL_DOCUMENT_POLL_LIMIT_MS * 2); });
    queryFn.mockResolvedValue([document()]);
    await act(async () => { client.setQueryData(["/api/email-documents"], [document()]); });
    await flush();
    expect(result.current.pollingExpired).toBe(false);
    expect(result.current.isPolling).toBe(true);
    const callsBefore = queryFn.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(EMAIL_DOCUMENT_POLL_INTERVAL_MS); });
    expect(queryFn.mock.calls.length).toBeGreaterThan(callsBefore);
    client.clear();
  });

  it("stops polling after a fetch error instead of retrying forever", async () => {
    const queryFn = vi.fn().mockResolvedValueOnce([document()]).mockRejectedValue(new Error("Status unavailable"));
    const client = createClient(queryFn);
    const { result } = renderHook(() => useEmailDocuments(), { wrapper: wrapper(client) });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(EMAIL_DOCUMENT_POLL_INTERVAL_MS); });
    await flush();
    expect(result.current.error?.message).toBe("Status unavailable");
    expect(result.current.isPolling).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(EMAIL_DOCUMENT_POLL_LIMIT_MS); });
    expect(queryFn).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it("refreshes an infinitely cached email list on revisit and observes already-filed promotions", async () => {
    const filed = document({ state: "filed", promotedKind: "devis", promotedId: 35, isActive: false });
    const queryFn = vi.fn(async () => [filed]);
    const client = createClient(queryFn);
    client.setQueryData(["/api/email-documents"], [document({ state: "not_filed", isActive: false })]);
    client.setQueryData(projectScopedKey(12, "devis"), []);
    client.setQueryData(projectScopedKey(12, "devis-readiness"), {});
    client.setQueryData(projectScopedKey(99, "devis"), []);
    const first = renderHook(() => useEmailDocuments(), { wrapper: wrapper(client) });
    await flush();
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(first.result.current.data?.[0].filing.state).toBe("filed");
    expect(client.getQueryState(projectScopedKey(12, "devis"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(projectScopedKey(12, "devis-readiness"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(projectScopedKey(99, "devis"))?.isInvalidated).toBe(false);
    first.unmount();
    // Simulate a cache repopulated while away. A resumed observation must
    // invalidate it even when the email query still has the same promotion.
    client.setQueryData(projectScopedKey(12, "devis"), []);
    renderHook(() => useEmailDocuments(), { wrapper: wrapper(client) });
    await flush();
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(projectScopedKey(12, "devis"))?.isInvalidated).toBe(true);
    client.clear();
  });

  it("polls pending/processing extraction but never a removed source", () => {
    expect(hasActiveEmailDocuments([document({ isActive: false }, "pending")])).toBe(true);
    expect(hasActiveEmailDocuments([document({ isActive: false }, "processing")])).toBe(true);
    expect(hasActiveEmailDocuments([document({ state: "removed", isActive: false }, "pending")])).toBe(false);
  });
});

describe("targeted project cache invalidation", () => {
  it("invalidates a promotion only once per observation session, including changed targets", () => {
    const client = createClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const observed = new Set<string>();
    const filed = document({ state: "filed", promotedKind: "devis", promotedId: 35, isActive: false });
    observeEmailDocumentPromotions(client, [filed], observed);
    const firstCalls = invalidate.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);
    observeEmailDocumentPromotions(client, [filed, { ...filed }], observed);
    expect(invalidate).toHaveBeenCalledTimes(firstCalls);
    observeEmailDocumentPromotions(client, [{ ...filed, filing: { ...filed.filing, promotedId: 36 } }], observed);
    expect(invalidate.mock.calls.length).toBeGreaterThan(firstCalls);
    client.clear();
  });

  it("invalidates actual invoice/devis/readiness/intake keys, not unrelated project caches", () => {
    const client = createClient();
    const related = [
      projectScopedKey(12),
      projectScopedKey(12, "intake", ""),
      projectScopedKey(12, "intake", "?includeVoid=true"),
      projectScopedKey(12, "invoices"),
      projectScopedKey(12, "devis"),
      projectScopedKey(12, "devis-readiness"),
      projectScopedKey(12, "devis-checks", "open-counts"),
      projectScopedKey(12, "financial-summary"),
      projectScopedKey(12, "accounting-status"),
      ["/api/devis", 35, "invoices"],
      ["/api/invoices", 41, "certificat-preview"],
    ];
    related.forEach((key) => { client.setQueryData<unknown[]>(key, []); });
    client.setQueryData(projectScopedKey(12, "devis"), [{ id: 35 }]);
    client.setQueryData(projectScopedKey(99, "invoices"), []);
    observeEmailDocumentPromotions(client, [document({ state: "filed", promotedKind: "invoice", promotedId: 41, isActive: false })], new Set());
    related.forEach((key) => expect(client.getQueryState(key)?.isInvalidated).toBe(true));
    expect(client.getQueryState(projectScopedKey(99, "invoices"))?.isInvalidated).toBe(false);
    client.clear();
  });

  it("assignment can refresh old and target projects without broad invalidation", () => {
    const client = createClient();
    for (const id of [12, 14, 99]) client.setQueryData(projectScopedKey(id, "intake", ""), []);
    invalidateEmailDocumentProject(client, 12);
    invalidateEmailDocumentProject(client, 14);
    expect(client.getQueryState(projectScopedKey(12, "intake", ""))?.isInvalidated).toBe(true);
    expect(client.getQueryState(projectScopedKey(14, "intake", ""))?.isInvalidated).toBe(true);
    expect(client.getQueryState(projectScopedKey(99, "intake", ""))?.isInvalidated).toBe(false);
    client.clear();
  });
});