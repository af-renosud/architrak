// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDocumentBatch, useBulkDocuments, type BulkDocument } from "../use-bulk-documents";

afterEach(cleanup);
const items: BulkDocument[] = [
  { id: 11, name: "Menuiserie.pdf", eligible: true },
  { id: 12, name: "Façade.pdf", eligible: true },
  { id: 13, name: "Signed.pdf", eligible: false },
];

describe("bulk document selection", () => {
  it("selects only current eligible records, shows indeterminate, prunes hidden records and resets project/filter scopes", () => {
    const { result, rerender } = renderHook(({ records, scope }) => useBulkDocuments({
      items: records, scope, execute: vi.fn(), onSettled: vi.fn(),
    }), { initialProps: { records: items, scope: "project:1:all" } });
    act(() => result.current.toggle(11, true));
    expect(result.current.allChecked).toBe("indeterminate");
    act(() => result.current.selectAll(true));
    expect(Array.from(result.current.ids)).toEqual([11, 12]);
    expect(result.current.allChecked).toBe(true);
    rerender({ records: [items[1]], scope: "project:1:all" });
    expect(Array.from(result.current.ids)).toEqual([12]);
    rerender({ records: items, scope: "project:2:all" });
    expect(result.current.ids.size).toBe(0);
    act(() => result.current.selectAll(true));
    rerender({ records: items, scope: "project:2:drafts" });
    expect(result.current.ids.size).toBe(0);
  });

  it("runs sequentially, reports each failure, retains failed selection and refreshes once", async () => {
    const execute = vi.fn(async (id: number) => { if (id === 12) throw new Error("Protected payment evidence"); });
    const onSettled = vi.fn();
    const { result } = renderHook(() => useBulkDocuments({ items, scope: "project:1", execute, onSettled }));
    act(() => result.current.selectAll(true));
    act(() => result.current.openConfirmation());
    await act(async () => { await result.current.confirm("Rejected extraction"); });
    expect(execute.mock.calls).toEqual([[11, "Rejected extraction"], [12, "Rejected extraction"]]);
    expect(Array.from(result.current.ids)).toEqual([12]);
    expect(result.current.result).toMatchObject({ succeeded: 1, failures: [{ id: 12, name: "Façade.pdf", message: "Protected payment evidence" }] });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("does not execute hidden/ineligible confirmed rows or confirmations from another project", async () => {
    const execute = vi.fn();
    const { result, rerender } = renderHook(({ records, scope }) => useBulkDocuments({ items: records, scope, execute, onSettled: vi.fn() }),
      { initialProps: { records: items, scope: "project:1" } });
    act(() => result.current.selectAll(true));
    act(() => result.current.openConfirmation());
    rerender({ records: [{ ...items[0], eligible: false }], scope: "project:1" });
    await act(async () => { await result.current.confirm(""); });
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.result?.failures).toHaveLength(2);
    rerender({ records: items, scope: "project:1" });
    act(() => result.current.selectAll(true));
    act(() => result.current.openConfirmation());
    rerender({ records: items, scope: "project:2" });
    await act(async () => { await result.current.confirm(""); });
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.confirmationOpen).toBe(false);
  });

  it("bounds concurrency at one and ignores double confirmation while a request is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => gate);
    const { result } = renderHook(() => useBulkDocuments({ items, scope: "project:1", execute, onSettled: vi.fn() }));
    act(() => result.current.selectAll(true));
    act(() => result.current.openConfirmation());
    let operation!: Promise<void>;
    act(() => { operation = result.current.confirm(""); });
    expect(execute).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.confirm(""); });
    expect(execute).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await operation; });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("continues after errors and does not claim failures as successful", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("409 locked")).mockResolvedValueOnce(undefined);
    const outcome = await runDocumentBatch(items.slice(0, 2), execute);
    expect(outcome.succeeded).toEqual([12]);
    expect(outcome.failures).toEqual([{ id: 11, name: "Menuiserie.pdf", message: "409 locked" }]);
  });
});
