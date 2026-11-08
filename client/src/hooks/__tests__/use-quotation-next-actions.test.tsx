// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest, ApiError, projectScopedKey } from "@/lib/queryClient";
import { useQuotationNextActions } from "../use-quotation-next-actions";
import type { ProjectNextActions, QuotationNextAction } from "@shared/quotation-next-actions";

vi.mock("@/lib/queryClient", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...original, apiRequest: vi.fn() };
});
const request = vi.mocked(apiRequest);
const action: QuotationNextAction = {
  id: "deposit-17", code: "deposit", label: "Review deposit", why: "Deposit certificate is missing.",
  nextStep: "Review the generation control.", actor: "architect", tone: "action", priority: 10,
  devisId: 17, href: "/projects/4?tab=devis", target: "deposit",
};
const payload = (actions = [action]): ProjectNextActions => ({
  projectId: 4, generatedAt: new Date().toISOString(),
  quotations: { 17: { devisId: 17, actionable: actions.length > 0, actions } }, actionableCount: actions.length ? 1 : 0,
});
const response = (data: unknown) => ({ json: async () => data }) as Response;
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useQuotationNextActions("4"), { wrapper }) };
}
beforeEach(() => { request.mockReset(); request.mockImplementation(async () => response(payload())); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

describe("project quotation guidance", () => {
  it("loads one batch, refetches for dependency changes and does not feed back on its own cache", async () => {
    const { result, client } = setup();
    await waitFor(() => expect(result.current.unknown).toBe(false));
    expect(request).toHaveBeenCalledTimes(1);
    act(() => { client.setQueryData(projectScopedKey("4", "certificats"), [{ id: 42 }]); });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.unknown).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(request).toHaveBeenCalledTimes(2);
    act(() => { client.setQueryData(projectScopedKey("7", "devis"), []); });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("marks cached guidance unknown immediately on a dependency invalidation, before refetch", async () => {
    const { result, client } = setup();
    await waitFor(() => expect(result.current.unknown).toBe(false));
    client.setQueryData(projectScopedKey("4", "payments"), []);
    await waitFor(() => expect(result.current.unknown).toBe(false));
    request.mockImplementation(() => new Promise(() => {}));
    act(() => { void client.invalidateQueries({ queryKey: projectScopedKey("4", "payments"), refetchType: "none" }); });
    await waitFor(() => expect(result.current.unknown).toBe(true));
  });

  it("never treats a failed refresh or stale server timestamp as an all-clear", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.unknown).toBe(false));
    request.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => { await result.current.retry(); });
    await waitFor(() => expect(result.current.unknown).toBe(true));
    request.mockResolvedValueOnce(response({ ...payload([]), generatedAt: new Date(Date.now() - 120_000).toISOString() }));
    await act(async () => { await result.current.retry(); });
    await waitFor(() => expect(result.current.unknown).toBe(true));
    expect(result.current.data?.quotations[17].actions).toHaveLength(1);
  });

  it("revalidates before explanation and refuses a disappeared action without posting", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.unknown).toBe(false));
    request.mockResolvedValueOnce(response(payload([])));
    await act(async () => {
      await expect(result.current.explain(action)).rejects.toThrow("guidance has changed");
    });
    expect(request.mock.calls.map(call => call[0])).toEqual(["GET", "GET"]);
  });

  it("sends only the explanation request after a fresh read and reports 409 guidance changes", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.unknown).toBe(false));
    request.mockImplementation(async method => {
      if (method === "POST") throw new ApiError(409, "Changed", {});
      return response(payload([]));
    });
    request.mockResolvedValueOnce(response(payload()));
    await act(async () => {
      await expect(result.current.explain(action)).rejects.toThrow("no longer current");
    });
    expect(request.mock.calls.filter(call => call[0] === "POST")).toEqual([
      ["POST", "/api/projects/4/quotation-next-actions/explain", { devisId: 17, actionId: "deposit-17" }],
    ]);
    await waitFor(() => expect(result.current.data?.quotations[17].actions).toEqual([]));
  });
});
