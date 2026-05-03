#!/bin/bash
# Pre-merge gate (Task #163): catch unjournaled migration files (and
# the inverse — journal tags with no SQL file) before they reach
# production.
#
# Background: on 2026-04-26, migrations/0025_archisign_envelope_tracking.sql
# was committed without a matching entry in migrations/meta/_journal.json.
# Drizzle's runtime migrator is journal-driven, so the file was silently
# skipped on every deploy for ~6 days. Five `devis` columns and a CHECK
# constraint declared in shared/schema.ts never landed in dev OR prod.
# Task #124's post-merge schema-parity replay eventually caught it, but
# only after merge.
#
# This check runs *ahead* of check-migration-replay.sh in
# scripts/post-merge.sh so the orphan is reported with a clear,
# actionable error rather than as a downstream column-not-exist
# failure from the replay.
#
# Exits non-zero on any mismatch in either direction.
set -euo pipefail

JOURNAL="migrations/meta/_journal.json"
MIG_DIR="migrations"

if [ ! -f "$JOURNAL" ]; then
  echo "[check-journal-orphans] FATAL: $JOURNAL not found" >&2
  exit 1
fi

# Tags listed in _journal.json (sorted, unique).
journal_tags=$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const e of j.entries) console.log(e.tag);
' "$JOURNAL" | sort -u)

# Tags inferred from migrations/NNNN_*.sql filenames (sorted, unique).
file_tags=$(find "$MIG_DIR" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' \
  -printf '%f\n' | sed 's/\.sql$//' | sort -u)

# Files on disk but not in journal — the 0025 incident class.
orphans_on_disk=$(comm -23 <(echo "$file_tags") <(echo "$journal_tags") || true)
# Journal entries with no matching SQL file — would crash the migrator.
orphans_in_journal=$(comm -13 <(echo "$file_tags") <(echo "$journal_tags") || true)

fail=0

if [ -n "$orphans_on_disk" ]; then
  fail=1
  echo "[check-journal-orphans] FAIL: SQL file(s) present on disk but missing from $JOURNAL:" >&2
  echo "$orphans_on_disk" | sed 's/^/  - migrations\//; s/$/.sql/' >&2
  echo "" >&2
  echo "  These migrations will be silently skipped at deploy time." >&2
  echo "  Re-run \`npx drizzle-kit generate\` or add the entry to _journal.json." >&2
fi

if [ -n "$orphans_in_journal" ]; then
  fail=1
  echo "[check-journal-orphans] FAIL: $JOURNAL references tag(s) with no matching .sql file:" >&2
  echo "$orphans_in_journal" | sed 's/^/  - /' >&2
  echo "" >&2
  echo "  The Drizzle migrator will crash trying to read the missing file." >&2
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

count=$(echo "$file_tags" | grep -c . || true)
echo "[check-journal-orphans] OK ($count migrations, journal and disk in sync)"
