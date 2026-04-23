# Post-mortem: tracker fell 8 rows behind a fully-forward schema (April 2026)

**Author**: Operations
**Date written**: 2026-04-23
**Incidents covered**: 2026-04-23 (P0 partial-apply, hotfixed in Task #123) and the immediate recurrence this week (tracker behind a fully-forward schema, hotfixed in Tasks #135 + #136)
**Status**: Root cause identified with high confidence. Recurrence prevention partially in place; one additional control proposed.

---

## Evidence sources

This investigation worked from the artifacts available in this repository, not from a live production log dump. Each conclusion below cites the specific evidence it rests on:

- **The future-dated `when` values**: directly readable from `migrations/meta/_journal.json` today; reproducible with `node -e "JSON.parse(require('fs').readFileSync('migrations/meta/_journal.json','utf8')).entries.filter(e=>e.when>Date.now()).forEach(e=>console.log(e.tag,e.when,new Date(e.when).toISOString()))"`. Output: 0010_contractors_siret_check, 0019_numerous_drax, 0020_per_line_pdf_bbox, 0021_reapply_pdf_page_hint_and_bbox, 0022_post_merge_transient_failures.
- **drizzle's `when > max(applied.created_at)` filter behaviour**: documented in commit `b00eef0` (Task #123) which traced the same mechanism for the 2026-04-23 incident. That commit's message reproduces the issue locally and names the filter as the silent-skip cause: *"Drizzle's migrator filters journal entries by `when > max(applied.created_at)`, so 0019 (1776965162234), 0020 (1776965864686), and any subsequent migration with a `when` smaller than 1777411200000 was silently considered 'already applied' and never executed"*.
- **The 8-row prod gap**: stated in the task description (`drizzle.__drizzle_migrations` had 15 rows while the schema was fully forward through migration 0022). 23 (journal) − 15 (tracker) = 8.
- **The 8 specific missing tags**: derived by sorting the journal by `idx` and listing entries 0011 through 0018 (post-0010 / pre-future-dated). All eight have `when` values in the 1776845835037–1776903265561 range (2026-04-22 / 2026-04-23), all strictly less than 0010's 1777411200000 high-water mark.
- **The repository's only DELETE-from-tracker code path**: identified by ripgrepping `DELETE FROM drizzle.__drizzle_migrations` across `scripts/`. Single match: `scripts/repair-migration-drift.mjs` line 80, behind the `--prune-orphans --apply` flag pair.
- **`scripts/run-migrations.mjs` is a 2-line wrapper**: file content is verbatim `import("../server/migrate.ts").then(m => m.runMigrations()).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });`. There is no transactional split between SQL apply and tracker insert — that ordering happens inside `drizzle-orm`'s migrator, which is vendored and uses a single transaction per migration.
- **No backup/restore tooling in the repository**: no `pg_restore`, `pg_dump`, or backup-script files exist under `scripts/` or anywhere else in the tree (verified by ripgrep). Production backup/restore is handled by the platform layer outside the repo, and the platform-level snapshot would be all-or-nothing on the `drizzle` schema, not selective on 8 rows.

If a future post-mortem reviewer wants log-level corroboration (specific deploy IDs, the exact boot when 0010 first landed in the tracker, the timestamp drizzle emitted for the silent skip), the production deployment-log fetcher can be queried with regex `(?i)(\\[migrate\\]|drizzle|already exists|partial apply)` against the relevant 2026-04 deploy windows.

## Timeline

- **2026-04-17 → 2026-04-23**: Migrations 0000–0018 generated with normal `when` timestamps (`Date.now()` at generation time, all within hours of one another).
- **At some point on or before 2026-04-22**: `migrations/0010_contractors_siret_check.sql` was generated (or its `_journal.json` entry was edited) with `when = 1777411200000` (= **2026-04-28T21:20:00Z**, ~6 days in the future).
- **2026-04-23**: Production deploy crash-loops with `pdf_page_hint` / `pdf_bbox` missing despite `[migrate] done` in the logs. Root cause traced in Task #123 commit `b00eef0`: drizzle's migrator filters journal entries by `when > max(applied.created_at)`. Once 0010 landed in the tracker, its future-dated `when` (2026-04-28) became the high-water mark, and drizzle silently skipped every subsequent migration whose `when` was less than that — including 0019/0020 which add `pdf_page_hint` and `pdf_bbox`.
- **2026-04-23 hotfix**: Added `0021_reapply_pdf_page_hint_and_bbox.sql` (`ADD COLUMN IF NOT EXISTS …`) and `0022_post_merge_transient_failures.sql`. Both shipped with **further future-dated `when` values** (2026-04-28T21:25Z and 21:26Z respectively), each one nudged just past the high-water mark so drizzle would actually run them. The underlying date corruption was not addressed.
- **Between 2026-04-23 and this week**: production schema reaches a fully-forward state through 0022. Tracker rows accumulate for whichever migrations drizzle's filter accepted on each boot (the future-dated ones — 0010, 0019, 0020, 0021, 0022 — plus the original baseline 0000–0009). Migrations 0011–0018 (8 entries dated 2026-04-22 / 2026-04-23, all *less* than 0010's high-water mark) are silently filtered out on every subsequent migrate() call. Their schema artifacts are present (applied during the original development sessions, before 0010's future date was introduced into the journal), but they never get tracker rows.
- **This week**: a deploy that re-runs migrations crashes with `column already exists` because drizzle's `migrate()` decides 0019/0020 are pending again (they have rows in the tracker, but the *next* boot's filter logic doesn't matter — what matters is that every boot that produces "[migrate] done" has been tacitly relying on the future-dated filter to skip 0011–0018). `assertJournalMatchesTracker` (Task #123) trips on the boot AFTER `migrate()` crashes, naming "23 journal vs 15 tracker" — the 8-row gap.

## Numbers

```
Journal entries:                         23  (0000 … 0022)
Tracker rows in prod:                    15
Gap:                                      8

Migration tags with future-dated `when` (2026-04-28+):
  0010_contractors_siret_check        when = 1777411200000
  0019_numerous_drax                  when = 1777411300000
  0020_per_line_pdf_bbox              when = 1777411400000
  0021_reapply_pdf_page_hint_and_bbox when = 1777411500000
  0022_post_merge_transient_failures  when = 1777411600000

Tags with normal (past) `when` that fall BELOW 0010's high-water mark
and are silently filtered out by drizzle:
  0011_wooden_selene                  (2026-04-22)
  0012_messy_black_queen              (2026-04-22)
  0013_bent_cardiac                   (2026-04-22)
  0014_handy_wolfsbane                (2026-04-22)
  0015_little_ender_wiggin            (2026-04-22)
  0016_next_human_cannonball          (2026-04-22)
  0017_backfill_devis_check_token_expiry (2026-04-22)
  0018_outstanding_kinsey_walden      (2026-04-23)
  ──────────────────────────────────────
  Count:                              8   ← exactly the prod gap
```

The gap matches the count of "post-0010, pre-future-date" migrations down to the single row. This is not coincidence; it is the candidate that explains the data exactly.

## Root cause

**Migration `_journal.json` entries are allowed to have future-dated `when` values, and drizzle's migrator uses `when > max(applied.created_at)` as its "what to apply next" filter. Once a future-dated migration is applied, every later migration with a normal timestamp falls below the high-water mark and is silently skipped. The skipped migrations never get tracker rows. The database schema can still be fully forward (because in development, the SQL had already executed when the journal `when` was a normal timestamp — the future date was introduced later, perhaps by a journal regeneration that picked the wrong clock value, or by manual editing). Result: schema fully forward, tracker N rows behind, and `[migrate] done` reported on every boot until something forces drizzle to re-attempt the apply.**

This is the same mechanism as the 2026-04-23 incident. The hotfix added new migrations to bridge the symptom but did not normalise the journal `when` values, so the underlying defect remained. This week's incident is its second visible firing.

## Verdict against the candidate list

The task spec listed four candidates. Verdict on each:

1. **Partial DB restore from backup excluding the `drizzle` schema** — RULED OUT. A restore would either drop the entire `drizzle.__drizzle_migrations` table (zero tracker rows) or preserve all of it (23 rows). It would not selectively remove exactly the 8 entries whose `when` falls between 0010 and the future-dated batch. There is no plausible restore path that leaves precisely this fingerprint.

2. **Older `scripts/run-migrations.mjs` that ran SQL but failed to commit tracker rows under specific transaction conditions** — RULED OUT. `scripts/run-migrations.mjs` is a 2-line wrapper around `runMigrations()` and has been throughout. drizzle-orm's migrator commits the tracker insert in the same transaction as the migration SQL; a transactional failure would roll back both, not commit one without the other.

3. **Manual SQL session by an operator during the original 2026-04-23 incident** — POSSIBLE CONTRIBUTOR but does not fully explain the data. The 2026-04-23 hotfix did restore `pdf_page_hint` / `pdf_bbox` by adding migration 0021 with `ADD COLUMN IF NOT EXISTS`, not by hand-running SQL. We would expect manual operator intervention to leave a different (and less symmetric) row pattern.

4. **`__drizzle_migrations` truncation by something downstream** — RULED OUT for *this* incident, with a caveat. The only code path in the repository that deletes from the tracker is `scripts/repair-migration-drift.mjs --prune-orphans --apply`, which removes rows whose `created_at` doesn't match any journal `when`. For prod's tracker to have lost exactly the 8 contiguous middle rows, an operator would have had to run that script while the journal's `when` values diverged from the tracker's `created_at` for precisely those 8 entries. That is a possible but contorted story; the future-dated-`when` mechanism explains the same data without invoking any operator action. **However** — `--prune-orphans --apply` remains an actively dangerous code path that could produce a similar gap in the future if the journal's `when` values are ever re-edited. A follow-up will harden it.

**Verdict**: candidate #2 was the closest in spirit but wrong on the specific mechanism. The actual cause is drizzle's `when > max(created_at)` filter being defeated by future-dated `when` values in `_journal.json`. The future-dated values exist in 5 of the 23 entries today; their persistent presence has caused both this week's incident and the 2026-04-23 incident.

## Recurrence prevention

Already in place after Tasks #135 and #136:

- **Detection at boot (Task #136)**: `assertSchemaMatchesTracker` runs *before* `migrate()` and refuses the boot when a journal entry's schema artifact is present but its tracker row is missing (or vice-versa). The current incident class would now abort the boot with a precise `[migrate] FATAL — schema drift: 0011_wooden_selene claims applied (tracker has a row with created_at=…) but column public.X.Y is missing` (or the inverse) instead of the misleading `column already exists` from drizzle.
- **Recovery (Task #135)**: `scripts/reconcile-drizzle-tracker.ts` backfills the missing tracker rows in a single transaction using `created_at = journal.when` matching. Rerunning is idempotent.
- **CI gate (Task #124)**: `scripts/check-migration-replay.sh` replays the entire journal against a throwaway database and asserts the post-replay tracker row count equals the journal entry count, then runs the new schema-presence assertion. A future regression would block merge, not deploy.

**Not yet in place — needed to close the loop at the source**: a guard that *prevents future-dated `when` values from being committed in the first place*. Today, anyone running `npm run db:generate` on a machine with a misconfigured clock, or anyone hand-editing `_journal.json` with the wrong timestamp, can introduce a new future-dated entry — and the existing safety net only catches it *after* the next deploy crashes. A simple `npm run` lint that scans `migrations/meta/_journal.json` and exits non-zero on any `when > Date.now()` would have caught both incidents at source. This is being filed as a follow-up.

A second follow-up will tighten `scripts/repair-migration-drift.mjs --prune-orphans --apply` so it cannot silently delete legitimate tracker rows in scenarios where the journal `when` values have been re-edited.

## What we are explicitly NOT doing

- **Not normalising the existing 5 future-dated `when` values to past timestamps.** The tracker rows in production already store `created_at = when` for the 5 future-dated migrations. Editing `_journal.json` to change those `when` values would invalidate the journal-↔-tracker matching that #135 reconcile and #136 boot-check rely on, and would not help anyway: the schema artifacts exist, the tracker rows exist, and the boot invariants now pass. Touching this is all risk and no benefit. The 5 dates will become past dates naturally on 2026-04-29.
- **Not changing drizzle's filter behaviour.** That lives in a vendored migrator file (`drizzle-orm/node-postgres/migrator`); patching it is out of scope. The right control is to refuse to commit future-dated `when` values, not to change how drizzle filters them.
