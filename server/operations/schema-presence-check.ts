/**
 * Schema-presence boot invariant (Task #136).
 *
 * Complements `assertJournalMatchesTracker` (#123) by walking the
 * journal and verifying, for every migration, that the live schema
 * agrees with what the tracker says was applied:
 *
 *   - tracker row present  → representative schema artifact MUST exist
 *   - tracker row absent   → representative schema artifact MUST NOT exist
 *
 * This catches the "tracker behind / schema fully forward" drift that
 * broke production this week (the inverse of the 2026-04-23 partial
 * apply): the count check passes only AFTER drizzle's migrate() has
 * already crashed re-running 0019/0020. This check runs first, against
 * the live DB at startup, and fails loudly with the offending tag and
 * artifact name BEFORE any migration is attempted.
 *
 * It also catches the rarer inverse direction — tracker says applied
 * but someone manually `DROP COLUMN`-ed the artifact — by failing the
 * "tracker present → artifact present" leg.
 *
 * Pure-data migrations (no schema artifact) are listed but skipped
 * for the artifact probe; they still benefit from the count invariant
 * in #123. Drop-only migrations are likewise data-only here because
 * "absence of column X" is fragile to subsequent re-introductions.
 *
 * The check list is intentionally data-driven: adding a new migration
 * means appending one entry to MIGRATION_ARTIFACTS. The migration-
 * replay test (#124) calls this same assertion against the throwaway
 * replay DB so CI catches drift before deploy.
 */
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { resolveMigrationsFolder } from "../migrate";

export type ArtifactKind =
  | { kind: "table"; table: string }
  | { kind: "column"; table: string; column: string }
  | { kind: "data_only"; reason: string };

export interface MigrationArtifact {
  tag: string;
  artifact: ArtifactKind;
}

/**
 * One entry per migration. The artifact must be something the
 * migration creates (table / column) — drop-only and data-only
 * migrations are tagged `data_only` because schema-state checks for
 * "absence of X" are fragile to later reintroductions.
 *
 * Adding a new migration MUST add a row here; the assertion throws if
 * the tracker has a hash that the journal lists but this table does
 * not cover.
 */
export const MIGRATION_ARTIFACTS: readonly MigrationArtifact[] = [
  { tag: "0000_baseline", artifact: { kind: "table", table: "ai_model_settings" } },
  { tag: "0001_regular_leo", artifact: { kind: "column", table: "projects", column: "archived_at" } },
  { tag: "0002_lot_catalog", artifact: { kind: "table", table: "lot_catalog" } },
  { tag: "0003_devis_translations", artifact: { kind: "table", table: "devis_translations" } },
  { tag: "0004_slimy_the_spike", artifact: { kind: "column", table: "devis_translations", column: "approved_at" } },
  { tag: "0005_gray_leech", artifact: { kind: "column", table: "lot_catalog", column: "description_uk" } },
  { tag: "0006_milky_starjammers", artifact: { kind: "table", table: "devis_ref_edits" } },
  { tag: "0007_document_parsing_model_refresh", artifact: { kind: "data_only", reason: "AI model setting UPDATE; no schema artifact" } },
  { tag: "0008_wakeful_masked_marvel", artifact: { kind: "column", table: "contractors", column: "archidoc_orphaned_at" } },
  { tag: "0009_slow_slyde", artifact: { kind: "table", table: "invoice_ref_edits" } },
  { tag: "0010_contractors_siret_check", artifact: { kind: "data_only", reason: "SIRET normalisation + check constraint; covered by #129 follow-up for constraint drift" } },
  { tag: "0011_wooden_selene", artifact: { kind: "data_only", reason: "archidoc_contractors SIRET constraint addition; covered by #129 follow-up" } },
  { tag: "0012_messy_black_queen", artifact: { kind: "table", table: "archidoc_siret_issues" } },
  { tag: "0013_bent_cardiac", artifact: { kind: "table", table: "wish_list_items" } },
  { tag: "0014_handy_wolfsbane", artifact: { kind: "data_only", reason: "DROP COLUMN only; absence-checks fragile to later reintroduction" } },
  { tag: "0015_little_ender_wiggin", artifact: { kind: "table", table: "devis_check_messages" } },
  { tag: "0016_next_human_cannonball", artifact: { kind: "column", table: "devis_check_tokens", column: "expires_at" } },
  { tag: "0017_backfill_devis_check_token_expiry", artifact: { kind: "data_only", reason: "expires_at backfill UPDATE; no schema artifact" } },
  { tag: "0018_outstanding_kinsey_walden", artifact: { kind: "table", table: "rate_limit_buckets" } },
  { tag: "0019_numerous_drax", artifact: { kind: "column", table: "devis_line_items", column: "pdf_page_hint" } },
  { tag: "0020_per_line_pdf_bbox", artifact: { kind: "column", table: "devis_line_items", column: "pdf_bbox" } },
  { tag: "0021_reapply_pdf_page_hint_and_bbox", artifact: { kind: "data_only", reason: "Idempotent re-apply of 0019/0020 columns; same artifacts as those entries" } },
  { tag: "0022_post_merge_transient_failures", artifact: { kind: "table", table: "post_merge_transient_failures" } },
  { tag: "0023_database_identity", artifact: { kind: "table", table: "__database_identity" } },
  { tag: "0024_devis_signoff_workflow", artifact: { kind: "table", table: "client_checks" } },
  { tag: "0025_archisign_envelope_tracking", artifact: { kind: "column", table: "devis", column: "archisign_access_url" } },
  { tag: "0026_archidoc_mirror_reconciliation", artifact: { kind: "column", table: "archidoc_contractors", column: "source_base_url" } },
  { tag: "0027_design_contracts", artifact: { kind: "table", table: "design_contracts" } },
  { tag: "0028_design_contract_parties", artifact: { kind: "column", table: "design_contracts", column: "client_name" } },
  { tag: "0029_devis_structured_lot_code", artifact: { kind: "column", table: "devis", column: "lot_ref_text" } },
  { tag: "0030_user_gmail_polling", artifact: { kind: "column", table: "users", column: "gmail_refresh_token" } },
  { tag: "0031_wish_list_images", artifact: { kind: "column", table: "wish_list_items", column: "image_storage_keys" } },
  { tag: "0032_drive_auto_upload", artifact: { kind: "column", table: "lots", column: "drive_folder_id" } },
];

interface JournalFile {
  entries: Array<{ tag: string; when: number }>;
}

function readJournal(migrationsFolder: string): JournalFile {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  return JSON.parse(fs.readFileSync(journalPath, "utf-8")) as JournalFile;
}

async function tableExists(pool: pg.Pool, table: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [table],
  );
  return r.rows[0]?.exists === true;
}

async function columnExists(
  pool: pg.Pool,
  table: string,
  column: string,
): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return r.rows[0]?.exists === true;
}

function describe(a: ArtifactKind): string {
  switch (a.kind) {
    case "table":
      return `table public.${a.table}`;
    case "column":
      return `column public.${a.table}.${a.column}`;
    case "data_only":
      return `<data-only: ${a.reason}>`;
  }
}

async function probe(pool: pg.Pool, a: ArtifactKind): Promise<boolean> {
  switch (a.kind) {
    case "table":
      return tableExists(pool, a.table);
    case "column":
      return columnExists(pool, a.table, a.column);
    case "data_only":
      // No artifact to probe; treat as "true" so absence/presence
      // checks always agree with whatever the tracker says.
      return true;
  }
}

export interface SchemaPresenceOptions {
  pool: pg.Pool;
  migrationsFolder?: string;
}

/**
 * Walk the journal in order and assert schema-vs-tracker agreement.
 *
 * Throws on the first mismatch with a precise message naming the
 * offending migration tag, the artifact, and which direction the
 * drift is in. Aborts the boot.
 */
export async function assertSchemaMatchesTracker(
  opts: SchemaPresenceOptions,
): Promise<void> {
  const migrationsFolder = opts.migrationsFolder ?? resolveMigrationsFolder();
  const journal = readJournal(migrationsFolder);

  // Coverage check: every journal entry must be in MIGRATION_ARTIFACTS.
  const covered = new Set(MIGRATION_ARTIFACTS.map((m) => m.tag));
  const uncovered = journal.entries.filter((e) => !covered.has(e.tag));
  if (uncovered.length > 0) {
    const tags = uncovered.map((e) => e.tag).join(", ");
    const msg = `[migrate] FATAL — schema-presence check missing artifact entry for journal tag(s): ${tags}. Add one entry per migration to MIGRATION_ARTIFACTS in server/operations/schema-presence-check.ts.`;
    console.error(msg);
    throw new Error(msg);
  }

  // The tracker table may not exist on a brand-new database: drizzle
  // creates it inside migrate(), and we run before migrate(). In that
  // case treat the "applied" set as empty — every artifact must also
  // be absent for the check to pass, which is the correct invariant
  // for a fresh DB. Use to_regclass to probe without throwing.
  const trackerTable = await opts.pool.query<{ reg: string | null }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS reg`,
  );
  const trackerExists = trackerTable.rows[0]?.reg != null;
  // Read all tracker created_at values once. We match by created_at
  // (which drizzle sets to the journal entry's `when` value — see
  // drizzle-orm/migrator.cjs `folderMillis`) rather than by hash,
  // because hashes change whenever a migration .sql file is edited
  // post-application (idempotency tweaks, comment fixes, line-ending
  // normalisation). The `when` value is the journal's immutable
  // identifier and survives such edits, so matching on it gives a
  // stable "was this migration applied?" signal that doesn't false-
  // positive on benign file rewrites.
  const trackerWhens = new Set<number>();
  if (trackerExists) {
    const trackerRows = await opts.pool.query<{ created_at: string | null }>(
      `SELECT created_at FROM drizzle.__drizzle_migrations`,
    );
    for (const r of trackerRows.rows) {
      const v = r.created_at == null ? null : Number(r.created_at);
      if (v != null && Number.isFinite(v)) trackerWhens.add(v);
    }
  }

  // For each journal entry, decide whether the tracker claims it
  // applied (by `when` ↔ `created_at`) and probe the artifact.
  // We collect both directions of drift so we can decide between
  // self-heal (only "tracker behind, schema forward" entries) and
  // hard-abort (any "tracker forward, schema behind" entries).
  const trackerBehindEntries: Array<{ tag: string; artifact: ArtifactKind }> = [];
  const trackerForwardEntries: Array<{ tag: string; artifact: ArtifactKind; when: number }> = [];

  for (const entry of journal.entries) {
    const artifact = MIGRATION_ARTIFACTS.find((m) => m.tag === entry.tag)!.artifact;
    if (artifact.kind === "data_only") continue;

    const trackerSaysApplied = trackerWhens.has(entry.when);
    const present = await probe(opts.pool, artifact);

    if (trackerSaysApplied && !present) {
      trackerForwardEntries.push({ tag: entry.tag, artifact, when: entry.when });
    } else if (!trackerSaysApplied && present) {
      trackerBehindEntries.push({ tag: entry.tag, artifact });
    }
  }

  // "Tracker forward, schema behind" is genuine drift (the artifact
  // was dropped manually after the tracker recorded the apply, or a
  // partial-apply lost the DDL between drizzle's tracker insert and
  // the SQL commit). We have no safe automatic remediation — abort.
  if (trackerForwardEntries.length > 0) {
    const first = trackerForwardEntries[0];
    const msg = `[migrate] FATAL — schema drift: ${first.tag} claims applied (tracker has a row with created_at=${first.when}) but ${describe(first.artifact)} is missing. Either restore the artifact or remove the tracker row, then redeploy.`;
    console.error(msg);
    throw new Error(msg);
  }

  // "Tracker behind, schema forward" is the recoverable direction:
  // Replit's publish-time DDL applied the schema but did not insert
  // the corresponding rows into drizzle.__drizzle_migrations. We
  // self-heal by invoking the same reconcile script the operator
  // would have run by hand (per the original FATAL message). Safe
  // because:
  //   1. reconcileTracker only writes to drizzle.__drizzle_migrations,
  //      never to schema.
  //   2. It refuses to write if the tracker contains hashes not in
  //      the journal (would mean an unknown migration was applied).
  //   3. It only inserts rows whose hashes are derived from .sql
  //      files already on disk in this deployment, so the tracker
  //      ends up consistent with what subsequent migrate() runs would
  //      consider "already applied".
  // After self-heal, re-read the tracker and re-verify; if either
  // direction of drift remains, abort.
  if (trackerBehindEntries.length > 0) {
    const tags = trackerBehindEntries.map((e) => e.tag).join(", ");
    console.warn(
      `[migrate] tracker-behind drift detected for ${trackerBehindEntries.length} migration(s) (${tags}); attempting self-heal via reconcileTracker.`,
    );
    const { reconcileTracker } = await import(
      "../../scripts/reconcile-drizzle-tracker"
    );
    const result = await reconcileTracker({
      pool: opts.pool,
      migrationsFolder,
      apply: true,
      log: (m) => console.log(m),
    });
    console.log(
      `[migrate] self-heal complete — inserted ${result.toInsert.length} tracker row(s); tracker now has ${result.trackerCountAfter} rows (journal: ${result.journalCount}).`,
    );
    // Re-verify after self-heal: read the tracker fresh and confirm
    // every previously-behind entry is now present.
    const reread = await opts.pool.query<{ created_at: string | null }>(
      `SELECT created_at FROM drizzle.__drizzle_migrations`,
    );
    const healedWhens = new Set<number>();
    for (const r of reread.rows) {
      const v = r.created_at == null ? null : Number(r.created_at);
      if (v != null && Number.isFinite(v)) healedWhens.add(v);
    }
    for (const entry of journal.entries) {
      if (!healedWhens.has(entry.when)) {
        const msg = `[migrate] FATAL — self-heal did not insert tracker row for ${entry.tag} (when=${entry.when}); aborting.`;
        console.error(msg);
        throw new Error(msg);
      }
    }
  }
}
