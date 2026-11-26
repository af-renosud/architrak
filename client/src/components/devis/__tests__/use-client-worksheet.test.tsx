// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/queryClient";
import { useWorksheet, worksheetKey, type WorksheetDetail } from "../use-client-worksheet";

vi.mock("@/lib/queryClient", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...original, apiRequest: vi.fn() };
});
const request = vi.mocked(apiRequest);
const response = (data: unknown) => ({ json: async () => data }) as Response;
const detail = (id: number, revision: number, lineIds = [11, 12]): WorksheetDetail => ({
  worksheet: { id, devisId: 5, title: `W${id}`, meetingDate: null, revision, duplicatedFromId: null, createdAt: "", updatedAt: "", createdBy: null, depositPercent: null },
  quotation: { id: 5, code: "Q", number: null, date: null, projectId: 1, projectName: "P", projectCode: null, clientName: null, contractorName: "C", amountHt: "0", amountTtc: "0" },
  lines: lineIds.map(l => ({ id: l } as any)), computed: {} as any, readOnlyReason: null, history: [],
});
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(worksheetKey(1), detail(1, 3));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useWorksheet(1, 5), { wrapper }) };
}
beforeEach(() => request.mockReset());
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); });

describe("client worksheet editing", () => {
  it("duplicates without a revision and caches the copy under its own id, leaving the source intact", async () => {
    request.mockResolvedValue(response(detail(2, 1, [21, 22])));
    const { result, client } = setup();
    let copy: WorksheetDetail | undefined;
    await act(async () => { copy = await result.current.duplicate("Copy"); });
    expect(request).toHaveBeenCalledWith("POST", "/api/worksheets/1/duplicate", { title: "Copy" });
    expect(copy?.worksheet.id).toBe(2);
    expect(client.getQueryData<WorksheetDetail>(worksheetKey(2))?.lines.map(l => l.id)).toEqual([21, 22]);
    expect(client.getQueryData<WorksheetDetail>(worksheetKey(1))).toMatchObject({ worksheet: { id: 1, revision: 3 }, lines: [{ id: 11 }, { id: 12 }] });
  });

  it("waits for a slow save before an export can start, and refuses after a failed save", async () => {
    let finish!: () => void;
    request.mockImplementationOnce(() => new Promise(res => { finish = () => res(response(detail(1, 4))); }));
    const { result, client } = setup();
    let saved = false, flushed = false;
    act(() => { result.current.send("PATCH", "/lines/11", { clientQuantity: "2" }).then(() => { saved = true; }); });
    const flushing = result.current.flush().then(() => { flushed = true; });
    await waitFor(() => expect(request).toHaveBeenCalledWith("PATCH", "/api/worksheets/1/lines/11", { clientQuantity: "2", expectedRevision: 3 }));
    await new Promise(r => setTimeout(r, 20));
    expect(flushed).toBe(false);
    await act(async () => { finish(); await flushing; });
    expect(saved && flushed).toBe(true);
    expect(client.getQueryData<WorksheetDetail>(worksheetKey(1))?.worksheet.revision).toBe(4);

    request.mockRejectedValueOnce(new Error("409: changed elsewhere"));
    await act(async () => { await result.current.send("PATCH", "/lines/12", { clientQuantity: "0" }).catch(() => undefined); });
    await expect(result.current.flush()).rejects.toThrow("changed elsewhere");
    // After the failure has been reported, a fresh export is allowed again.
    await expect(result.current.flush()).resolves.toBeUndefined();
  });
});
