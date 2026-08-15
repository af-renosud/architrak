// Task #503 — regression: the poll must page PAST already-processed message
// ids AND must not restart behind an ever-growing processed prefix. When
// label filtering is a no-op (no modify permission), the first pages of
// every query fill with old processed messages; the persistent
// processed-message table plus the durable `before:<oldest processed>`
// backfill query guarantee fresh work is still reached each poll.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { gmail_v1 } from "googleapis";

const processedSet = new Set<string>();

vi.mock("../storage", () => ({
  storage: {
    filterUnprocessedGmailMessageIds: vi.fn(async (_userId: number, ids: string[]) =>
      ids.filter((id) => !processedSet.has(id)),
    ),
  },
}));

import { collectUnprocessedMessageIds } from "../gmail/monitor";

function fakeGmail(pagesByQuery: Record<string, string[][]>): {
  gmail: gmail_v1.Gmail;
  listCalls: Array<{ q: string; pageToken?: string }>;
} {
  const listCalls: Array<{ q: string; pageToken?: string }> = [];
  const gmail = {
    users: {
      messages: {
        list: vi.fn(async (params: { q: string; pageToken?: string }) => {
          listCalls.push({ q: params.q, pageToken: params.pageToken });
          const pages = pagesByQuery[params.q] ?? [];
          const idx = params.pageToken ? Number(params.pageToken) : 0;
          const page = pages[idx] ?? [];
          return {
            data: {
              messages: page.map((id) => ({ id })),
              nextPageToken: idx + 1 < pages.length ? String(idx + 1) : undefined,
            },
          };
        }),
      },
    },
  } as unknown as gmail_v1.Gmail;
  return { gmail, listCalls };
}

describe("collectUnprocessedMessageIds (Task #503)", () => {
  beforeEach(() => processedSet.clear());

  it("advances to page two when the entire first page is already processed", async () => {
    const page1 = Array.from({ length: 10 }, (_, i) => `old-${i}`);
    for (const id of page1) processedSet.add(id);
    const { gmail, listCalls } = fakeGmail({ broad: [page1, ["new-1", "new-2"]] });

    const res = await collectUnprocessedMessageIds(gmail, 1, { targeted: [], backstop: "broad" });

    expect(res.unprocessed).toEqual(["new-1", "new-2"]);
    expect(res.alreadyHandled).toBe(10);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1].pageToken).toBe("1");
  });

  it("backfill query rescues backlog behind a processed prefix DEEPER than the page budget (>100 ids)", async () => {
    // 15 full pages (150 ids) of already-processed messages sit in front of
    // the broad query — beyond the 10-page in-poll budget. The durable
    // cursor's `before:` query starts past all of them: page one is fresh.
    const broadPages = Array.from({ length: 15 }, (_, p) =>
      Array.from({ length: 10 }, (_, i) => `done-${p}-${i}`),
    );
    for (const page of broadPages) for (const id of page) processedSet.add(id);
    const { gmail, listCalls } = fakeGmail({
      broad: broadPages,
      "broad before:123": [["backlog-1", "backlog-2"]],
    });

    const res = await collectUnprocessedMessageIds(gmail, 1, {
      targeted: [],
      backstop: "broad",
      backfill: "broad before:123",
    });

    expect(res.unprocessed).toEqual(["backlog-1", "backlog-2"]);
    // Broad stopped at its page budget; backfill still reached fresh work
    // with a single request.
    expect(listCalls.filter((c) => c.q === "broad").length).toBeLessThanOrEqual(10);
    expect(listCalls.filter((c) => c.q === "broad before:123")).toHaveLength(1);
  });

  it("boundary bucket is drained past >100 processed ids sharing the cursor second", async () => {
    // 11 full pages (110 ids) of processed messages share the cursor's
    // second; a fresh one hides on page 12. The bucket query's higher page
    // cap must reach it — the deep query excludes that second entirely.
    const bucketPages = Array.from({ length: 11 }, (_, p) =>
      Array.from({ length: 10 }, (_, i) => `bucket-done-${p}-${i}`),
    );
    for (const page of bucketPages) for (const id of page) processedSet.add(id);
    bucketPages.push(["bucket-fresh-1"]);
    const { gmail, listCalls } = fakeGmail({
      broad: [Array.from({ length: 10 }, (_, i) => { const id = `top-${i}`; processedSet.add(id); return id; })],
      "bucket-q": bucketPages,
      "deep-q": [["older-1"]],
    });

    const res = await collectUnprocessedMessageIds(gmail, 1, {
      targeted: [],
      backstop: "broad",
      backfill: "deep-q",
      backfillBucket: "bucket-q",
    });

    expect(res.unprocessed).toContain("bucket-fresh-1");
    expect(res.unprocessed).toContain("older-1");
    expect(listCalls.filter((c) => c.q === "bucket-q")).toHaveLength(12);
  });

  it("stops paging once the work budget is reached", async () => {
    const page1 = Array.from({ length: 10 }, (_, i) => `fresh-${i}`);
    const { gmail, listCalls } = fakeGmail({ broad: [page1, ["never-fetched"]] });

    const res = await collectUnprocessedMessageIds(gmail, 1, { targeted: [], backstop: "broad" });

    expect(res.unprocessed).toHaveLength(10);
    expect(listCalls).toHaveLength(1);
  });

  it("dedupes ids across targeted and backstop queries", async () => {
    processedSet.add("old-1");
    const { gmail } = fakeGmail({
      targeted: [["dup-1", "old-1"]],
      backstop: [["dup-1", "new-9"]],
    });

    const res = await collectUnprocessedMessageIds(gmail, 1, { targeted: ["targeted"], backstop: "backstop" });

    expect(res.unprocessed).toEqual(["dup-1", "new-9"]);
    expect(res.alreadyHandled).toBe(1);
  });

  it("a failing query is logged and the remaining queries still run", async () => {
    const { gmail } = fakeGmail({ ok: [["a-1"]] });
    (gmail.users.messages.list as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    const res = await collectUnprocessedMessageIds(gmail, 1, { targeted: ["broken"], backstop: "ok" });

    expect(res.listErrors).toBe(1);
    expect(res.unprocessed).toEqual(["a-1"]);
  });

  it("broad backstop AND backfill both run even when targeted queries flood the budget", async () => {
    const flood = Array.from({ length: 10 }, (_, i) => `targeted-${i}`);
    const { gmail, listCalls } = fakeGmail({
      targeted: [flood, flood.map((id) => `${id}-b`)],
      backstop: [["broad-only-1"]],
      backfill: [["backlog-only-1"]],
    });

    const res = await collectUnprocessedMessageIds(gmail, 1, {
      targeted: ["targeted"],
      backstop: "backstop",
      backfill: "backfill",
    });

    expect(listCalls.some((c) => c.q === "backstop")).toBe(true);
    expect(listCalls.some((c) => c.q === "backfill")).toBe(true);
    expect(res.unprocessed).toContain("broad-only-1");
    expect(res.unprocessed).toContain("backlog-only-1");
    expect(res.unprocessed.length).toBeLessThanOrEqual(10);
  });

  it("bounded paging: never loops forever on an endless result set", async () => {
    const endlessPage = Array.from({ length: 10 }, (_, i) => `e-${i}`);
    for (const id of endlessPage) processedSet.add(id);
    let calls = 0;
    const gmail = {
      users: {
        messages: {
          list: vi.fn(async (params: { pageToken?: string }) => {
            calls++;
            return {
              data: {
                messages: endlessPage.map((id) => ({ id })),
                nextPageToken: String((Number(params.pageToken) || 0) + 1),
              },
            };
          }),
        },
      },
    } as unknown as gmail_v1.Gmail;

    const res = await collectUnprocessedMessageIds(gmail, 1, { targeted: [], backstop: "q" });
    expect(res.unprocessed).toEqual([]);
    expect(calls).toBeLessThanOrEqual(10);
  });
});
