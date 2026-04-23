import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #130 — verifies the consecutive-failure escalation logic that turns
// the post-merge classifier's `[transient]` alerts into `[escalated]` once a
// source tag fails on N consecutive deploys.
//
// Coverage:
//   - first failure: counter=1, NOT escalated (default threshold 3)
//   - Nth consecutive failure: counter increments, escalated=true at threshold
//   - clear() after a streak: counter resets to 0; the next failure starts
//     fresh at counter=1, NOT escalated (one-off blips never escalate)
//   - clear() with no row is a no-op (sources that have never failed don't
//     get sentinel rows inserted)
//   - parseEscalateAfter env parsing (defaults, garbage, < 1)
//   - formatEscalationHistory layout (skips the just-recorded entry)
//   - history is bounded by historyLimit (no unbounded jsonb growth)

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: new Map<string, {
      sourceTag: string;
      consecutiveFailures: number;
      lastExitCode: number | null;
      lastFailureAt: Date | null;
      lastClearedAt: Date | null;
      recentFailures: unknown;
      updatedAt: Date;
    }>(),
  },
}));

// Drizzle chain mock that supports the exact 3 ops the tracker uses:
//   db.select().from(table).where(eq(...))
//   db.update(table).set(...).where(eq(...))
//   db.insert(table).values(...)
// `where(eq(...))` is approximated by capturing the most recent literal arg
// via vi.fn so we can match by sourceTag — sufficient because the tracker
// only ever filters on the primary key.
let lastWhereTag: string | null = null;

vi.mock("../db", () => {
  const select = () => ({
    from: () => ({
      where: (predicate: { __sourceTag?: string }) => {
        const tag = predicate.__sourceTag ?? lastWhereTag;
        if (tag && dbState.rows.has(tag)) {
          return Promise.resolve([dbState.rows.get(tag)]);
        }
        return Promise.resolve([]);
      },
    }),
  });

  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: (predicate: { __sourceTag?: string }) => {
        const tag = predicate.__sourceTag ?? lastWhereTag;
        if (!tag) return Promise.resolve();
        const existing = dbState.rows.get(tag);
        if (!existing) return Promise.resolve();
        dbState.rows.set(tag, { ...existing, ...values } as typeof existing);
        return Promise.resolve();
      },
    }),
  });

  const insert = () => ({
    values: (values: Record<string, unknown>) => {
      const v = values as {
        sourceTag: string;
        consecutiveFailures: number;
        lastExitCode: number;
        lastFailureAt: Date;
        recentFailures: unknown;
        updatedAt: Date;
      };
      dbState.rows.set(v.sourceTag, {
        sourceTag: v.sourceTag,
        consecutiveFailures: v.consecutiveFailures,
        lastExitCode: v.lastExitCode,
        lastFailureAt: v.lastFailureAt,
        lastClearedAt: null,
        recentFailures: v.recentFailures,
        updatedAt: v.updatedAt,
      });
      return Promise.resolve();
    },
  });

  return {
    db: { select, update, insert },
  };
});

// drizzle-orm `eq(col, value)` returns an opaque object; we just need to know
// which sourceTag was filtered. The mock above reads `lastWhereTag`.
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>(
    "drizzle-orm",
  );
  return {
    ...actual,
    eq: (_col: unknown, value: unknown) => {
      lastWhereTag = typeof value === "string" ? value : null;
      return { __sourceTag: lastWhereTag } as { __sourceTag: string | null };
    },
  };
});

import {
  recordTransientFailure,
  clearTransientFailures,
  formatEscalationHistory,
  parseEscalateAfter,
} from "../operations/post-merge-failure-tracker";

beforeEach(() => {
  dbState.rows.clear();
  lastWhereTag = null;
});

describe("recordTransientFailure", () => {
  it("first failure starts the counter at 1 and does NOT escalate", async () => {
    const result = await recordTransientFailure(
      "backfill-page-hints",
      1,
      "log tail",
      3,
      { now: new Date("2026-04-23T10:00:00Z") },
    );

    expect(result.consecutiveFailures).toBe(1);
    expect(result.escalated).toBe(false);
    expect(result.recentFailures).toHaveLength(1);
    expect(result.recentFailures[0]).toMatchObject({
      timestamp: "2026-04-23T10:00:00.000Z",
      exitCode: 1,
      logTail: "log tail",
    });

    const row = dbState.rows.get("backfill-page-hints");
    expect(row?.consecutiveFailures).toBe(1);
    expect(row?.lastExitCode).toBe(1);
  });

  it("escalates only AFTER the source has failed on N consecutive deploys", async () => {
    // Per spec (Task #130): with threshold=3, failures 1/2/3 still ship as
    // [transient] (the source has failed on N consecutive deploys but the
    // ALERT FOR THAT FAILURE shouldn't escalate yet). The NEXT failure —
    // the 4th — is the first that ships as [escalated].

    // Deploys 1-3: still transient (the source has now failed on 3
    // consecutive deploys but each individual alert is the first/second/
    // third in the streak).
    let r = await recordTransientFailure("src", 1, "tail-1", 3, {
      now: new Date("2026-04-20T00:00:00Z"),
    });
    expect(r.consecutiveFailures).toBe(1);
    expect(r.escalated).toBe(false);

    r = await recordTransientFailure("src", 1, "tail-2", 3, {
      now: new Date("2026-04-21T00:00:00Z"),
    });
    expect(r.consecutiveFailures).toBe(2);
    expect(r.escalated).toBe(false);

    r = await recordTransientFailure("src", 2, "tail-3", 3, {
      now: new Date("2026-04-22T00:00:00Z"),
    });
    expect(r.consecutiveFailures).toBe(3);
    expect(r.escalated).toBe(false);

    // Deploy 4: NOW escalated. The recent-failure history must include
    // the prior 3 timestamps so the on-call can see the streak shape.
    r = await recordTransientFailure("src", 1, "tail-4", 3, {
      now: new Date("2026-04-23T00:00:00Z"),
    });
    expect(r.consecutiveFailures).toBe(4);
    expect(r.escalated).toBe(true);
    expect(r.recentFailures).toHaveLength(4);
    // newest first
    expect(r.recentFailures[0].logTail).toBe("tail-4");
    expect(r.recentFailures[3].logTail).toBe("tail-1");
    // The escalation body must list the 3 prior failures (the current one
    // is implicit in the alert that triggered the format).
    const body = formatEscalationHistory(r.recentFailures);
    expect(body).toContain("2026-04-22T00:00:00.000Z");
    expect(body).toContain("2026-04-21T00:00:00.000Z");
    expect(body).toContain("2026-04-20T00:00:00.000Z");
    expect(body).not.toContain("2026-04-23T00:00:00.000Z");

    // Deploy 5: stays escalated.
    r = await recordTransientFailure("src", 1, "tail-5", 3, {
      now: new Date("2026-04-24T00:00:00Z"),
    });
    expect(r.consecutiveFailures).toBe(5);
    expect(r.escalated).toBe(true);
  });

  it("respects a custom historyLimit (no unbounded jsonb growth)", async () => {
    for (let i = 0; i < 5; i++) {
      await recordTransientFailure("src", 1, `tail-${i}`, 99, {
        now: new Date(`2026-04-2${i}T00:00:00Z`),
        historyLimit: 3,
      });
    }
    const row = dbState.rows.get("src");
    const history = row?.recentFailures as Array<{ logTail: string }>;
    expect(history).toHaveLength(3);
    // newest first → tail-4, tail-3, tail-2
    expect(history[0].logTail).toBe("tail-4");
    expect(history[2].logTail).toBe("tail-2");
  });
});

describe("clearTransientFailures", () => {
  it("resets the counter so a future blip starts fresh and does NOT escalate", async () => {
    // Build up a streak just shy of escalation.
    await recordTransientFailure("src", 1, "tail-1", 3, {
      now: new Date("2026-04-20T00:00:00Z"),
    });
    await recordTransientFailure("src", 1, "tail-2", 3, {
      now: new Date("2026-04-21T00:00:00Z"),
    });
    expect(dbState.rows.get("src")?.consecutiveFailures).toBe(2);

    // Successful deploy clears.
    const cleared = await clearTransientFailures("src", {
      now: new Date("2026-04-22T00:00:00Z"),
    });
    expect(cleared.previousConsecutiveFailures).toBe(2);
    expect(dbState.rows.get("src")?.consecutiveFailures).toBe(0);
    expect(dbState.rows.get("src")?.lastClearedAt).toEqual(
      new Date("2026-04-22T00:00:00Z"),
    );

    // A subsequent failure starts at 1, NOT 3 — the streak was broken.
    const next = await recordTransientFailure("src", 1, "tail-3", 3, {
      now: new Date("2026-04-23T00:00:00Z"),
    });
    expect(next.consecutiveFailures).toBe(1);
    expect(next.escalated).toBe(false);
  });

  it("is a no-op (no row inserted) when the source has never failed", async () => {
    const r = await clearTransientFailures("never-failed");
    expect(r.previousConsecutiveFailures).toBe(0);
    expect(dbState.rows.has("never-failed")).toBe(false);
  });
});

describe("parseEscalateAfter", () => {
  it("returns 3 by default and rejects garbage / < 1", () => {
    expect(parseEscalateAfter(undefined)).toBe(3);
    expect(parseEscalateAfter("")).toBe(3);
    expect(parseEscalateAfter("not-a-number")).toBe(3);
    expect(parseEscalateAfter("0")).toBe(3);
    expect(parseEscalateAfter("-2")).toBe(3);
    expect(parseEscalateAfter("5")).toBe(5);
    expect(parseEscalateAfter("1")).toBe(1);
  });
});

describe("formatEscalationHistory", () => {
  it("skips the just-recorded entry (index 0) and lists prior failures", () => {
    const out = formatEscalationHistory([
      { timestamp: "2026-04-23T00:00:00.000Z", exitCode: 1, logTail: "" },
      { timestamp: "2026-04-22T00:00:00.000Z", exitCode: 2, logTail: "" },
      { timestamp: "2026-04-21T00:00:00.000Z", exitCode: 1, logTail: "" },
    ]);
    expect(out).toContain("Previous consecutive transient failures");
    expect(out).toContain("2026-04-22T00:00:00.000Z — exit 2");
    expect(out).toContain("2026-04-21T00:00:00.000Z — exit 1");
    // The just-recorded failure must NOT be listed (would be confusing — it
    // is implicit in the alert that triggered this format).
    expect(out).not.toContain("2026-04-23T00:00:00.000Z");
  });

  it("returns empty string when there is no prior history", () => {
    expect(formatEscalationHistory([])).toBe("");
    expect(
      formatEscalationHistory([
        { timestamp: "2026-04-23T00:00:00.000Z", exitCode: 1, logTail: "" },
      ]),
    ).toBe("");
  });
});
