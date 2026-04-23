/**
 * Unit coverage for the post-migrate assertion added in Task #123:
 * after migrate() returns, the row count in drizzle.__drizzle_migrations
 * MUST equal the entry count in migrations/meta/_journal.json. If
 * drizzle silently partial-applies (the 2026-04-23 P0 incident),
 * runMigrations must throw rather than let the app boot with a stale
 * schema.
 *
 * We use an in-memory mock of `pool.query` rather than a real PG so the
 * test stays fast and deterministic. The migration-replay test
 * (server/__tests__/migration-replay.test.ts) provides the
 * end-to-end coverage against a real Postgres.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type pg from "pg";
import { assertJournalMatchesTracker } from "../migrate";

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function makePool(trackerCount: number): MockPool {
  return {
    query: vi.fn(async () => ({
      rows: [{ c: String(trackerCount) }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    })),
  };
}

function writeJournal(entryCount: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-test-"));
  fs.mkdirSync(path.join(dir, "meta"));
  const entries = Array.from({ length: entryCount }, (_, i) => ({
    idx: i,
    version: "7",
    when: 1700000000000 + i,
    tag: `000${i}_test`,
    breakpoints: true,
  }));
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
  return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("assertJournalMatchesTracker", () => {
  it("returns without throwing when journal entry count equals tracker row count (happy path)", async () => {
    const folder = writeJournal(21);
    tempDirs.push(folder);
    const pool = makePool(21);

    await expect(
      assertJournalMatchesTracker({
        pool: pool as unknown as pg.Pool,
        migrationsFolder: folder,
      }),
    ).resolves.toBeUndefined();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("throws a FATAL error naming both counts when journal > tracker (silent partial-apply detected)", async () => {
    const folder = writeJournal(21);
    tempDirs.push(folder);
    // Tracker has only 19 rows — the 2026-04-23 P0 shape (4 of 6
    // pending migrations were silently skipped).
    const pool = makePool(19);

    await expect(
      assertJournalMatchesTracker({
        pool: pool as unknown as pg.Pool,
        migrationsFolder: folder,
      }),
    ).rejects.toThrow(/journal has 21 entries, tracker has 19/);
  });

  it("throws when tracker has more rows than the journal (rolled-back code path)", async () => {
    const folder = writeJournal(20);
    tempDirs.push(folder);
    const pool = makePool(21);

    await expect(
      assertJournalMatchesTracker({
        pool: pool as unknown as pg.Pool,
        migrationsFolder: folder,
      }),
    ).rejects.toThrow(/journal has 20 entries, tracker has 21/);
  });

  it("treats a missing tracker row count as 0 and throws against a non-empty journal", async () => {
    const folder = writeJournal(5);
    tempDirs.push(folder);
    const pool: MockPool = {
      query: vi.fn(async () => ({
        rows: [],
        rowCount: 0,
        command: "SELECT",
        oid: 0,
        fields: [],
      })),
    };

    await expect(
      assertJournalMatchesTracker({
        pool: pool as unknown as pg.Pool,
        migrationsFolder: folder,
      }),
    ).rejects.toThrow(/journal has 5 entries, tracker has 0/);
  });
});
