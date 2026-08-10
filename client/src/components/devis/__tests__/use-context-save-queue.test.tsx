// @vitest-environment jsdom
//
// Regression coverage for false "edited elsewhere" conflicts (Task 364).
//
// The context editor's save queue must:
//  - re-sync its revision baseline when fresher server data (matching what
//    this client last saved) arrives via props, so a single-client save
//    never carries a stale baseRevision;
//  - treat a flush of an already-saved snapshot as a no-op (blur + unmount
//    dedupe);
//  - on 409, re-fetch and compare before declaring a cross-window conflict:
//    a self-conflict (server already holds our content, or matches our last
//    save) reconciles silently with NO toast;
//  - still surface the conflict toast for genuine two-window edits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: vi.fn() },
  apiRequest: vi.fn(),
}));

import { useContextSaveQueue } from "../useContextSaveQueue";
import type { DevisLineContext } from "@shared/schema";
import type { ContextDoc } from "@shared/context-doc";

const fetchMock = vi.fn();

function doc(text: string): ContextDoc {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } as ContextDoc;
}

function ctx(revision: number, document: ContextDoc): DevisLineContext {
  return { id: 1, devisId: 7, devisLineItemId: 100, document, revision } as unknown as DevisLineContext;
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  toastMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Extract PUT calls (method PUT to the line-context save URL). */
function putCalls() {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
  );
}

describe("useContextSaveQueue (Task 364)", () => {
  it("saves normally and records the new revision", async () => {
    const initial = ctx(3, doc("old"));
    fetchMock.mockResolvedValueOnce(jsonRes(ctx(4, doc("new"))));
    const { result } = renderHook(() => useContextSaveQueue(7, 100, initial));

    act(() => result.current.enqueue(doc("new")));
    await waitFor(() => expect(result.current.saveState).toBe("saved"));

    const [, init] = putCalls()[0];
    expect(JSON.parse((init as RequestInit).body as string).baseRevision).toBe(3);
    expect(result.current.revisionRef.current).toBe(4);
  });

  it("re-syncs the revision when fresher server data matching our last save arrives", async () => {
    const d = doc("saved");
    const { result, rerender } = renderHook(
      ({ context }: { context: DevisLineContext }) => useContextSaveQueue(7, 100, context),
      { initialProps: { context: ctx(2, d) } },
    );

    // Fresher server data with the SAME document (our own save echoed back).
    rerender({ context: ctx(5, d) });

    fetchMock.mockResolvedValueOnce(jsonRes(ctx(6, doc("newer"))));
    act(() => result.current.enqueue(doc("newer")));
    await waitFor(() => expect(result.current.saveState).toBe("saved"));

    const body = JSON.parse((putCalls()[0][1] as RequestInit).body as string);
    expect(body.baseRevision).toBe(5); // NOT the stale mount-time 2
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("does NOT adopt a fresher revision carrying a foreign document (keeps genuine conflicts detectable)", async () => {
    const { result, rerender } = renderHook(
      ({ context }: { context: DevisLineContext }) => useContextSaveQueue(7, 100, context),
      { initialProps: { context: ctx(2, doc("mine")) } },
    );
    rerender({ context: ctx(5, doc("someone else's edit")) });
    expect(result.current.revisionRef.current).toBe(2);
  });

  it("flushing an already-saved snapshot is a no-op (blur + unmount dedupe)", async () => {
    const d = doc("content");
    fetchMock.mockResolvedValueOnce(jsonRes(ctx(2, d)));
    const { result } = renderHook(() => useContextSaveQueue(7, 100, ctx(1, doc("old"))));

    act(() => result.current.enqueue(d));
    await waitFor(() => expect(result.current.saveState).toBe("saved"));
    expect(putCalls()).toHaveLength(1);

    // Duplicate flush (e.g. blur then unmount) — must not PUT again.
    act(() => result.current.enqueue(d));
    await new Promise((r) => setTimeout(r, 20));
    expect(putCalls()).toHaveLength(1);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("reconciles a self-conflict silently when the server already holds our content", async () => {
    const d = doc("mine");
    // PUT -> 409; GET latest -> server document IS our content at rev 9.
    fetchMock
      .mockResolvedValueOnce(jsonRes({ message: "stale" }, 409))
      .mockResolvedValueOnce(jsonRes({ contexts: [ctx(9, d)] }));
    const { result } = renderHook(() => useContextSaveQueue(7, 100, ctx(1, doc("old"))));

    act(() => result.current.enqueue(d));
    await waitFor(() => expect(result.current.saveState).toBe("saved"));

    expect(result.current.revisionRef.current).toBe(9);
    expect(putCalls()).toHaveLength(1); // no retry PUT needed
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("retries silently when the server matches our LAST save (stale baseRevision only)", async () => {
    const last = doc("last saved");
    const next = doc("next edit");
    // PUT(next) -> 409; GET -> server holds `last` at rev 4 (our own save);
    // retry PUT(next) with rev 4 -> success.
    fetchMock
      .mockResolvedValueOnce(jsonRes({ message: "stale" }, 409))
      .mockResolvedValueOnce(jsonRes({ contexts: [ctx(4, last)] }))
      .mockResolvedValueOnce(jsonRes(ctx(5, next)));
    const { result } = renderHook(() => useContextSaveQueue(7, 100, ctx(2, last)));

    act(() => result.current.enqueue(next));
    await waitFor(() => expect(result.current.saveState).toBe("saved"));

    expect(putCalls()).toHaveLength(2);
    const retryBody = JSON.parse((putCalls()[1][1] as RequestInit).body as string);
    expect(retryBody.baseRevision).toBe(4);
    expect(retryBody.document).toEqual(next);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("still surfaces the toast for a genuine two-window conflict", async () => {
    const foreign = doc("someone else's content");
    fetchMock
      .mockResolvedValueOnce(jsonRes({ message: "stale" }, 409))
      .mockResolvedValueOnce(jsonRes({ contexts: [ctx(4, foreign)] }))
      .mockResolvedValueOnce(jsonRes(ctx(5, doc("mine"))));
    const { result } = renderHook(() => useContextSaveQueue(7, 100, ctx(2, doc("base"))));

    act(() => result.current.enqueue(doc("mine")));
    await waitFor(() => expect(result.current.saveState).toBe("saved"));

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Context edited elsewhere" }),
    );
    expect(putCalls()).toHaveLength(2); // rebase + retry (deliberate LWW with notice)
  });

  it("declares a hard conflict after two consecutive genuine 409s", async () => {
    const foreign1 = doc("foreign one");
    const foreign2 = doc("foreign two");
    fetchMock
      .mockResolvedValueOnce(jsonRes({ message: "stale" }, 409))
      .mockResolvedValueOnce(jsonRes({ contexts: [ctx(4, foreign1)] }))
      .mockResolvedValueOnce(jsonRes({ message: "stale again" }, 409));
    const { result } = renderHook(() => useContextSaveQueue(7, 100, ctx(2, doc("base"))));

    act(() => result.current.enqueue(doc("mine")));
    await waitFor(() => expect(result.current.saveState).toBe("conflict"));

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Context changed elsewhere", variant: "destructive" }),
    );
    void foreign2;
  });
});
