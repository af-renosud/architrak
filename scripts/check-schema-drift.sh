#!/usr/bin/env bash
set -euo pipefail

# Verifies that shared/schema.ts is in sync with the committed migrations.
# Runs `drizzle-kit generate` against a dummy DATABASE_URL (the generate
# command does not actually connect) and then checks whether any new files
# were produced or any meta files changed. Any drift fails the build.

export DATABASE_URL="${DATABASE_URL:-postgres://drift:check@localhost:5432/drift}"

echo "==> Running drizzle-kit generate to detect schema drift..."
npx drizzle-kit generate --name __schema_drift_check__ >/tmp/drizzle-drift.log 2>&1 || {
  cat /tmp/drizzle-drift.log
  echo "ERROR: drizzle-kit generate failed." >&2
  exit 2
}

# Detect any new or modified files in the migrations directory.
DRIFT="$(git status --porcelain -- migrations/ || true)"

if [[ -n "$DRIFT" ]]; then
  echo "ERROR: schema drift detected — shared/schema.ts has changes that are not"
  echo "captured in the committed migrations/ directory."
  echo
  echo "Uncommitted migration artifacts:"
  echo "$DRIFT"
  echo
  echo "To fix locally:"
  echo "  1. Run: npx drizzle-kit generate --name <change-summary>"
  echo "  2. Review the generated SQL in migrations/"
  echo "  3. Commit the new migration file and the updated migrations/meta/ files."
  echo
  echo "drizzle-kit output:"
  cat /tmp/drizzle-drift.log

  # Restore the working tree so subsequent CI steps see a clean checkout.
  # Skipped outside CI to avoid clobbering a developer's intentional edits.
  if [[ "${CI:-}" == "true" ]]; then
    git checkout -- migrations/ 2>/dev/null || true
    git clean -fd -- migrations/ 2>/dev/null || true
  else
    echo
    echo "(local run: leaving generated migration artifacts in place — review and either commit or 'git checkout -- migrations/ && git clean -fd migrations/')"
  fi

  exit 1
fi

echo "==> OK: schema and migrations are in sync."
