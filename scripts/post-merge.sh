#!/bin/bash
set -e
npm install
npx tsx scripts/run-migrations.mjs

# Pre-deploy gate (Task #163): catch unjournaled migration files
# (orphan .sql on disk) and journal entries with no matching file
# *before* the replay check runs. The 2026-04-26 archisign incident
# left 0025_archisign_envelope_tracking.sql off the journal for 6
# days; the replay check eventually flagged the resulting column gap,
# but its error surfaced as a downstream column-not-exist failure.
# Running this first gives a clear, actionable orphan diagnostic.
bash scripts/check-journal-orphans.sh

# Pre-deploy gate (Task #124): independently replay every migration
# against a throwaway database and verify tracker == journal AND every
# Drizzle-declared column exists. Catches the silent partial-apply
# class of bug (the original pdf_page_hint incident on 2026-04-23)
# before any deploy artefact is built. Exits non-zero on failure so
# the post-merge run aborts.
bash scripts/check-migration-replay.sh

# Task #126: classify-or-fail wrapper for the maintenance scripts
# below. Replaces the previous `... || echo "swallowed"` pattern that
# converted every non-zero exit (including the column-does-not-exist
# error from the 2026-04-23 incident) into a benign log line. The
# wrapper exits 2 on schema errors (column-not-exist fingerprint) so
# the deploy aborts; AI / ArchiDoc / network transients still let the
# deploy proceed but fire a tagged operator alert.
# shellcheck source=lib/run-or-classify.sh
source "$(dirname "$0")/lib/run-or-classify.sh"

# Idempotent backfill of contractor identifiers (SIRET today, others later) from
# the ArchiDoc mirror. Safe to re-run on every deploy; keeps newly-added
# identifier columns in sync without manual operator action.
run_or_classify "backfill-contractor-identifiers" \
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
  # Task #126: replaced the previous `|| echo` swallow with the
  # classify-or-fail wrapper. Schema errors (column-not-exist) abort
  # the deploy via exit 2; AI / ArchiDoc / network transients still
  # continue the deploy but ship a `[transient]`-tagged operator
  # alert so on-call sees the regression even when nobody is tailing
  # the deploy log.
  run_or_classify "backfill-page-hints" \
    npx tsx scripts/backfill-page-hints.ts --limit "$PAGE_HINT_BACKFILL_LIMIT"
else
  echo "[post-merge] page-hint backfill skipped (PAGE_HINT_BACKFILL_LIMIT=$PAGE_HINT_BACKFILL_LIMIT)"
fi

# Post-deploy smoke gate (Task #125): poll /healthz/deep against the
# freshly-deployed revision and fail the deploy if any modeled table
# is broken (missing column, connectivity loss, etc.). This is the
# enforceable equivalent of a platform-level traffic gate — exit 1
# here aborts post-merge before downstream tooling marks the deploy
# successful, and an operator alert is sent regardless.
#
# Set POST_DEPLOY_SMOKE=0 to skip (e.g. environments with no
# reachable PUBLIC_BASE_URL such as local repls).
POST_DEPLOY_SMOKE="${POST_DEPLOY_SMOKE:-1}"
if [ "$POST_DEPLOY_SMOKE" = "1" ]; then
  npx tsx scripts/post-deploy-smoke.ts
else
  echo "[post-merge] post-deploy smoke skipped (POST_DEPLOY_SMOKE=$POST_DEPLOY_SMOKE)"
fi
