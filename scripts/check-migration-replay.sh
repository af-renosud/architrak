#!/bin/bash
# Pre-deploy gate (Task #124): replay every migration against a
# throwaway Postgres database and verify (a) tracker row count equals
# journal entry count, and (b) every column declared in
# shared/schema.ts exists on the replayed schema.
#
# Wired into scripts/post-merge.sh so a silent partial-apply in
# `npx tsx scripts/run-migrations.mjs` cannot make it past the merge
# gate. Exit non-zero on any failure (or any vitest error).
set -e
echo "[check-migration-replay] starting"
npx vitest run server/__tests__/migration-replay.test.ts --reporter=default
echo "[check-migration-replay] done"
