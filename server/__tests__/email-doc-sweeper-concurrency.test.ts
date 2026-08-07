// Unit tests for the concurrent-batch email-document sweeper (Task #317).
//
// The sweeper used to process due docs sequentially — each ~45 s AI
// extraction serialised the batch, capping the drain at ~1 doc/min. It now
// runs the batch through Promise.allSettled with a p-limit concurrency
// guard. These tests verify:
//   * docs in a batch actually run concurrently (all in flight at once);
//   * concurrency never exceeds MAX_CONCURRENT_EXTRACTIONS;
//   * a rejecting doc doesn't abort the others (allSettled semantics);
//   * the `sweeping` guard still prevents overlapping ticks.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { storageSpy, parserState } = vi.hoisted(() => {
  const parserState = {
    inFlight: 0,
    maxInFlight: 0,
    started: [] as number[],
    finished: [] as number[],
    resolvers: new Map<number, () => void>(),
    rejectIds: new Set<number>(),
    autoResolve: false,
  };
  const storageSpy = {
    reclaimStaleProcessingEmailDocuments: vi.fn(async () => 0),
    listDueEmailDocuments: vi.fn(async () => [] as Array<{ id: number }>),
  };
  return { storageSpy, parserState };
});

vi.mock("../storage", () => ({ storage: storageSpy }));

vi.mock("../gmail/document-parser", () => ({
  processEmailDocument: vi.fn(async (id: number) => {
    parserState.started.push(id);
    parserState.inFlight++;
    parserState.maxInFlight = Math.max(parserState.maxInFlight, parserState.inFlight);
    try {
      if (!parserState.autoResolve) {
        await new Promise<void>((resolve) => parserState.resolvers.set(id, resolve));
      } else {
        await Promise.resolve();
      }
      if (parserState.rejectIds.has(id)) {
        throw new Error(`boom for doc ${id}`);
      }
      parserState.finished.push(id);
    } finally {
      parserState.inFlight--;
    }
  }),
}));

import {
  sweepPendingEmailDocuments,
  MAX_CONCURRENT_EXTRACTIONS,
} from "../services/email-document-processor.service";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  parserState.inFlight = 0;
  parserState.maxInFlight = 0;
  parserState.started = [];
  parserState.finished = [];
  parserState.resolvers = new Map();
  parserState.rejectIds = new Set();
  parserState.autoResolve = false;
  storageSpy.reclaimStaleProcessingEmailDocuments.mockResolvedValue(0);
  storageSpy.listDueEmailDocuments.mockResolvedValue([]);
});

describe("sweepPendingEmailDocuments — concurrent batch (Task #317)", () => {
  it("processes all docs in a batch concurrently, not sequentially", async () => {
    storageSpy.listDueEmailDocuments.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const sweep = sweepPendingEmailDocuments();
    await vi.waitFor(() => expect(parserState.started.length).toBe(3));

    // All three started before any finished — that's concurrency; the old
    // sequential loop would only have started doc 1 at this point.
    expect(parserState.started).toEqual([1, 2, 3]);
    expect(parserState.inFlight).toBe(3);

    for (const id of [1, 2, 3]) parserState.resolvers.get(id)!();
    await sweep;
    expect(parserState.finished.sort()).toEqual([1, 2, 3]);
  });

  it("caps in-flight extractions at MAX_CONCURRENT_EXTRACTIONS", async () => {
    const docs = Array.from({ length: MAX_CONCURRENT_EXTRACTIONS + 3 }, (_, i) => ({ id: i + 1 }));
    storageSpy.listDueEmailDocuments.mockResolvedValue(docs);

    const sweep = sweepPendingEmailDocuments();
    await vi.waitFor(() => expect(parserState.inFlight).toBe(MAX_CONCURRENT_EXTRACTIONS));

    // Release everything as it becomes available.
    while (parserState.finished.length < docs.length) {
      for (const [id, resolve] of [...parserState.resolvers]) {
        parserState.resolvers.delete(id);
        resolve();
      }
      await tick();
    }
    await sweep;
    expect(parserState.maxInFlight).toBe(MAX_CONCURRENT_EXTRACTIONS);
    expect(parserState.finished.length).toBe(docs.length);
  });

  it("a rejecting doc doesn't abort the rest of the batch", async () => {
    storageSpy.listDueEmailDocuments.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    parserState.rejectIds.add(2);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const sweep = sweepPendingEmailDocuments();
    await vi.waitFor(() => expect(parserState.started.length).toBe(3));
    for (const id of [1, 2, 3]) parserState.resolvers.get(id)!();
    await sweep;

    expect(parserState.finished.sort()).toEqual([1, 3]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("email document 2"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("the sweeping guard still prevents overlapping ticks", async () => {
    storageSpy.listDueEmailDocuments.mockResolvedValue([{ id: 1 }]);

    const first = sweepPendingEmailDocuments();
    await vi.waitFor(() => expect(parserState.started).toEqual([1]));

    // Second tick while the first is still extracting: must no-op.
    await sweepPendingEmailDocuments();
    expect(storageSpy.listDueEmailDocuments).toHaveBeenCalledTimes(1);
    expect(parserState.started).toEqual([1]);

    parserState.resolvers.get(1)!();
    await first;

    // After the first sweep completes, the guard releases.
    parserState.autoResolve = true;
    await sweepPendingEmailDocuments();
    expect(storageSpy.listDueEmailDocuments).toHaveBeenCalledTimes(2);
  });
});
