#!/bin/bash
set -e
npm install
npx tsx scripts/run-migrations.mjs

# Pre-deploy gate (Task #124): independently replay every migration
# against a throwaway database and verify tracker == journal AND every
# Drizzle-declared column exists. Catches the silent partial-apply
# class of bug (the original pdf_page_hint incident on 2026-04-23)
# before any deploy artefact is built. Exits non-zero on failure so
# the post-merge run aborts.
bash scripts/check-migration-replay.sh

# Idempotent backfill of contractor identifiers (SIRET today, others later) from
# the ArchiDoc mirror. Safe to re-run on every deploy; keeps newly-added
# identifier columns in sync without manual operator action.
npx tsx scripts/backfill-contractor-identifiers.ts

# Opportunistic backfill of `devis_line_items.pdf_page_hint` for older devis
# that pre-date Task #111's click-to-jump. Each devis processed re-invokes the
# AI document parser (cost + latency), so we cap the per-deploy batch via
# PAGE_HINT_BACKFILL_LIMIT (default 25). Devis already fully hinted are skipped
# without an AI call inside the script, so successive deploys naturally chip
# away at the historic backlog without blowing the AI budget. Set the env var
# to 0 to disable the post-deploy run entirely (e.g. when running a manual
# bulk pass out-of-band).
PAGE_HINT_BACKFILL_LIMIT="${PAGE_HINT_BACKFILL_LIMIT:-25}"
if [ "$PAGE_HINT_BACKFILL_LIMIT" -gt 0 ] 2>/dev/null; then
  # Never abort the deploy if the AI parser is rate-limited or transiently
  # unavailable — the next deploy / scheduled run will pick up where this one
  # left off (the script is fully idempotent). Failures are still surfaced via
  # the `[backfill-page-hints]` log lines for operator visibility.
  npx tsx scripts/backfill-page-hints.ts --limit "$PAGE_HINT_BACKFILL_LIMIT" \
    || echo "[post-merge] page-hint backfill exited non-zero — continuing deploy; will retry next cycle"
else
  echo "[post-merge] page-hint backfill skipped (PAGE_HINT_BACKFILL_LIMIT=$PAGE_HINT_BACKFILL_LIMIT)"
fi
