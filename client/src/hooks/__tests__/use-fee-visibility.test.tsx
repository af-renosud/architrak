// @vitest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateFeeReads, useFeeVisibility } from "../use-fee-visibility";

vi.mock("@/lib/queryClient", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/queryClient")>(),
  apiRequest: vi.fn(),
}));
const request = vi.mocked(apiRequest);
beforeEach(() => { request.mockReset(); queryClient.clear(); });
afterEach(() => { cleanup(); queryClient.clear(); });
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
describe("visibility API boundaries and fee read invalidation", () => {
  it("reports a missing visibility API without inventing active states", async () => {
    request.mockRejectedValue(new Error("404: Visibility service unavailable"));
    const { result } = renderHook(() => useFeeVisibility("8"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error?.message).toContain("Visibility service unavailable");
  });
  it("reports an invalid visibility response instead of treating it as no archives", async () => {
    request.mockResolvedValue({ json: async () => ({}) } as Response);
    const { result } = renderHook(() => useFeeVisibility("8"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain("No archive states have been inferred");
  });
  it("invalidates fees, entries, by-phase, outstanding, visibility and contract after changes", () => {
    const keys = [
      ["/api/projects", "8", "fees"],
      ["/api/projects", "8", "fees", "by-phase"],
      ["/api/projects", "8", "fees", "outstanding"],
      ["/api/projects", "8", "fee-entries"],
      ["/api/projects", "8", "fee-visibility"],
      ["/api/projects", "8", "design-contract"],
      ["/api/fees/outstanding"],
    ];
    for (const key of keys) queryClient.setQueryData(key, {});
    queryClient.setQueryData(["/api/projects", "9", "fees"], {});
    invalidateFeeReads("8");
    for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["/api/projects", "9", "fees"])?.isInvalidated).toBe(false);
  });
});
