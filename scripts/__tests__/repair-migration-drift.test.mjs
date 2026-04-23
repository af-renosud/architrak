import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runInsertMissing,
  runPruneOrphans,
} from "../repair-migration-drift.mjs";

// In-memory tracker that mimics the relevant slice of
// drizzle.__drizzle_migrations: rows keyed by created_at, plus a hash blob.
function makeFakeTracker(initialRows = []) {
  const rows = [...initialRows];
  const calls = [];

  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const trimmed = sql.trim().toUpperCase();

      if (trimmed.startsWith("DELETE FROM DRIZZLE.__DRIZZLE_MIGRATIONS")) {
        const [createdAt] = params;
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (Number(rows[i].created_at) === Number(createdAt)) rows.splice(i, 1);
        }
        return { rowCount: before - rows.length, rows: [] };
      }

      if (trimmed.startsWith("INSERT INTO DRIZZLE.__DRIZZLE_MIGRATIONS")) {
        const [hash, createdAt] = params;
        rows.push({ hash, created_at: Number(createdAt) });
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected SQL in fake pool: ${sql}`);
    },
  };

  return { pool, rows, calls };
}

// Builds a fake `drift` module whose checkMigrationDrift() reads the live
// state of the fake tracker on each call. This lets us assert that the
// "after-repair" check the script performs reflects mutations made by the
// repair itself, instead of returning a stale snapshot.
function makeFakeDrift(journal, getRows) {
  return {
    async checkMigrationDrift() {
      if (journal === null) {
        return {
          ok: true,
          reason: "no-journal",
          journalCount: 0,
          appliedCount: 0,
          missingFromDb: [],
          orphanInDb: [],
        };
      }
      if (getRows === null) {
        return {
          ok: true,
          reason: "no-tracker",
          journalCount: journal.length,
          appliedCount: 0,
          missingFromDb: [],
          orphanInDb: [],
        };
      }
      const rows = getRows();
      const appliedWhens = new Set(rows.map((r) => Number(r.created_at)));
      const journalWhens = new Set(journal.map((e) => e.when));
      const missingFromDb = journal.filter((e) => !appliedWhens.has(e.when));
      const orphanInDb = [...appliedWhens]
        .filter((w) => !journalWhens.has(w))
        .map((w) => ({ created_at: w }));
      const inSync = missingFromDb.length === 0 && orphanInDb.length === 0;
      return {
        ok: inSync,
        reason: inSync ? "in-sync" : "drift",
        journalCount: journal.length,
        appliedCount: rows.length,
        missingFromDb,
        orphanInDb,
      };
    },
  };
}

// Lays down an ephemeral migrations folder so the script's SQL-file lookup
// (used to compute the hash for INSERTed rows) finds real files on disk.
function makeMigrationsFolder(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-drift-"));
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
  for (const e of entries) {
    fs.writeFileSync(path.join(dir, `${e.tag}.sql`), `-- ${e.tag}\n`);
  }
  return dir;
}

function expectedHash(tag) {
  return crypto.createHash("sha256").update(`-- ${tag}\n`).digest("hex");
}

const j = (idx, when, tag) => ({ idx, tag, when });

describe("repair-migration-drift", () => {
  let migrationsFolder;
  let prevFolderEnv;
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    consoleLog.mockClear();
    consoleWarn.mockClear();
    consoleError.mockClear();
    prevFolderEnv = process.env.MIGRATIONS_FOLDER;
  });

  afterEach(() => {
    if (migrationsFolder) {
      fs.rmSync(migrationsFolder, { recursive: true, force: true });
      migrationsFolder = undefined;
    }
    if (prevFolderEnv === undefined) delete process.env.MIGRATIONS_FOLDER;
    else process.env.MIGRATIONS_FOLDER = prevFolderEnv;
  });

  describe("runInsertMissing", () => {
    it("dry-run never mutates the tracker", async () => {
      const journal = [j(0, 1000, "0000_a"), j(1, 2000, "0001_b")];
      migrationsFolder = makeMigrationsFolder(journal);
      process.env.MIGRATIONS_FOLDER = migrationsFolder;

      const tracker = makeFakeTracker([{ hash: "h0", created_at: 1000 }]);
      const drift = makeFakeDrift(journal, () => tracker.rows);

      const code = await runInsertMissing(drift, tracker.pool, false);

      expect(code).toBe(0);
      expect(tracker.rows).toHaveLength(1);
      expect(tracker.calls).toHaveLength(0);
    });

    it("--apply inserts each missing journal row with the journal's `when` and the SQL hash", async () => {
      const journal = [
        j(0, 1000, "0000_a"),
        j(1, 2000, "0001_b"),
        j(2, 3000, "0002_c"),
      ];
      migrationsFolder = makeMigrationsFolder(journal);
      process.env.MIGRATIONS_FOLDER = migrationsFolder;

      const tracker = makeFakeTracker([{ hash: "h0", created_at: 1000 }]);
      const drift = makeFakeDrift(journal, () => tracker.rows);

      const code = await runInsertMissing(drift, tracker.pool, true);

      expect(code).toBe(0);
      const inserts = tracker.calls.filter((c) =>
        c.sql.includes("INSERT INTO drizzle.__drizzle_migrations"),
      );
      expect(inserts).toHaveLength(2);
      expect(inserts[0].params).toEqual([expectedHash("0001_b"), 2000]);
      expect(inserts[1].params).toEqual([expectedHash("0002_c"), 3000]);
      // tracker now in-sync
      expect(tracker.rows.map((r) => r.created_at).sort()).toEqual([1000, 2000, 3000]);
    });

    it("--apply aborts with exit code 2 when a journal entry has no SQL file", async () => {
      const journal = [j(0, 1000, "0000_a"), j(1, 2000, "0001_missing")];
      // Only create the SQL for entry 0; leave 0001_missing.sql off disk.
      migrationsFolder = makeMigrationsFolder([journal[0]]);
      // Re-write the journal so the script sees both entries even though
      // only one file exists.
      fs.writeFileSync(
        path.join(migrationsFolder, "meta", "_journal.json"),
        JSON.stringify({ version: "7", dialect: "postgresql", entries: journal }),
      );
      process.env.MIGRATIONS_FOLDER = migrationsFolder;

      const tracker = makeFakeTracker([{ hash: "h0", created_at: 1000 }]);
      const drift = makeFakeDrift(journal, () => tracker.rows);

      const code = await runInsertMissing(drift, tracker.pool, true);

      expect(code).toBe(2);
      expect(tracker.calls).toHaveLength(0);
      expect(tracker.rows).toHaveLength(1);
    });

    it("returns 0 without writes when the tracker is already in-sync", async () => {
      const journal = [j(0, 1000, "0000_a")];
      migrationsFolder = makeMigrationsFolder(journal);
      process.env.MIGRATIONS_FOLDER = migrationsFolder;

      const tracker = makeFakeTracker([{ hash: "h0", created_at: 1000 }]);
      const drift = makeFakeDrift(journal, () => tracker.rows);

      const code = await runInsertMissing(drift, tracker.pool, true);

      expect(code).toBe(0);
      expect(tracker.calls).toHaveLength(0);
    });

    it("does not delete orphan rows even with --apply (insert-only mode)", async () => {
      const journal = [j(0, 1000, "0000_a")];
      migrationsFolder = makeMigrationsFolder(journal);
      process.env.MIGRATIONS_FOLDER = migrationsFolder;

      // Tracker has the journal row PLUS an orphan that the journal
      // doesn't know about. insert-missing must leave it alone.
      const tracker = makeFakeTracker([
        { hash: "h0", created_at: 1000 },
        { hash: "horph", created_at: 9999 },
      ]);
      const drift = makeFakeDrift(journal, () => tracker.rows);

      const code = await runInsertMissing(drift, tracker.pool, true);

      // Nothing to insert (journal entry already in tracker), and orphan
      // must still be present.
      expect(code).toBe(0);
      expect(tracker.calls.filter((c) => /DELETE/i.test(c.sql))).toHaveLength(0);
      expect(tracker.rows.find((r) => r.created_at === 9999)).toBeTruthy();
    });

    it("returns 0 when no journal exists", async () => {
      const tracker = makeFakeTracker();
      const drift = makeFakeDrift(null, null);
      const code = await runInsertMissing(drift, tracker.pool, true);
      expect(code).toBe(0);
      expect(tracker.calls).toHaveLength(0);
    });

    it("returns 0 when tracker table is not present yet", async () => {
      const journal = [j(0, 1000, "0000_a")];
      const tracker = makeFakeTracker();
      const drift = makeFakeDrift(journal, null);
      const code = await runInsertMissing(drift, tracker.pool, true);
      expect(code).toBe(0);
      expect(tracker.calls).toHaveLength(0);
    });
  });

  describe("runPruneOrphans", () => {
    it("dry-run never mutates the tracker, even when orphans are present", async () => {
      const journal = [j(0, 1000, "0000_a")];
      const tracker = makeFakeTracker([
        { hash: "h0", created_at: 1000 },
        { hash: "horph1", created_at: 8888 },
        { hash: "horph2", created_at: 9999 },
      ]);
      const drift = makeFakeDrift(journal, () => tracker.rows);

      const code = await runPruneOrphans(drift, tracker.pool, false);

      expect(code).toBe(0);
      expect(tracker.calls).toHaveLength(0);
      expect(tracker.rows).toHaveLength(3);
    });

    it("--apply deletes each orphan row by created_at", async () => {
      const journal = [j(0, 1000, "0000_a")];
      const tracker = makeFakeTracker([
        { hash: "h0", created_at: 1000 },
        { hash: "horph1", created_at: 8888 },
        { hash: "horph2", created_at: 9999 },
      ]);
      const drift = makeFakeDrift(journal, () => tracker.rows);

      const code = await runPruneOrphans(drift, tracker.pool, true);

      expect(code).toBe(0);
      const deletes = tracker.calls.filter((c) => /DELETE/i.test(c.sql));
      expect(deletes).toHaveLength(2);
      const deletedWhens = deletes.map((d) => d.params[0]).sort();
      expect(deletedWhens).toEqual([8888, 9999]);
      // Real journal row is preserved.
      expect(tracker.rows).toEqual([{ hash: "h0", created_at: 1000 }]);
    });

    it("does not insert missing journal rows even with --apply (delete-only mode)", async () => {
      // Journal has two entries; tracker has only the first plus an orphan.
      // Prune mode should delete the orphan but NEVER insert the missing one.
      const journal = [j(0, 1000, "0000_a"), j(1, 2000, "0001_b")];
      const tracker = makeFakeTracker([
        { hash: "h0", created_at: 1000 },
        { hash: "horph", created_at: 9999 },
      ]);
      const drift = makeFakeDrift(journal, () => tracker.rows);

      const code = await runPruneOrphans(drift, tracker.pool, true);

      // Drift remains after prune (the missing row is still missing) so
      // the script returns 1 to surface the residual problem.
      expect(code).toBe(1);
      const inserts = tracker.calls.filter((c) => /INSERT/i.test(c.sql));
      expect(inserts).toHaveLength(0);
      const deletes = tracker.calls.filter((c) => /DELETE/i.test(c.sql));
      expect(deletes).toHaveLength(1);
      expect(deletes[0].params).toEqual([9999]);
      expect(tracker.rows).toEqual([{ hash: "h0", created_at: 1000 }]);
    });

    it("returns 0 with no writes when there are no orphans to prune", async () => {
      const journal = [j(0, 1000, "0000_a")];
      const tracker = makeFakeTracker([{ hash: "h0", created_at: 1000 }]);
      const drift = makeFakeDrift(journal, () => tracker.rows);

      const code = await runPruneOrphans(drift, tracker.pool, true);
      expect(code).toBe(0);
      expect(tracker.calls).toHaveLength(0);
    });

    it("returns 0 when no journal exists", async () => {
      const tracker = makeFakeTracker();
      const drift = makeFakeDrift(null, null);
      const code = await runPruneOrphans(drift, tracker.pool, true);
      expect(code).toBe(0);
      expect(tracker.calls).toHaveLength(0);
    });

    it("returns 0 when tracker table is not present yet", async () => {
      const journal = [j(0, 1000, "0000_a")];
      const tracker = makeFakeTracker();
      const drift = makeFakeDrift(journal, null);
      const code = await runPruneOrphans(drift, tracker.pool, true);
      expect(code).toBe(0);
      expect(tracker.calls).toHaveLength(0);
    });
  });
});
