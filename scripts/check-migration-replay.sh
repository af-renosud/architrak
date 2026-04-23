#!/bin/bash
# Pre-deploy gate (Task #124): replay every migration against a
# throwaway Postgres database and verify (a) tracker row count equals
# journal entry count, and (b) every column declared in
# shared/schema.ts exists on the replayed schema.
#
# Wired into scripts/post-merge.sh so a silent partial-apply in
# `npx tsx scripts/run-migrations.mjs` cannot make it past the merge
# gate. Exit non-zero on any failure (or any vitest error).
#
# STRICT_MIGRATION_REPLAY=1 forces the test to fail (not skip) when
# DATABASE_URL is unset or the role cannot CREATE DATABASE — so
# privilege/config drift cannot silently disable the gate. The boot-
# time assertion in server/migrate.ts (Task #123) is the runtime
# fallback, but here we want the deploy itself to abort.
set -e
echo "[check-migration-replay] starting (STRICT mode)"
STRICT_MIGRATION_REPLAY=1 npx vitest run \
  server/__tests__/migration-replay.test.ts \
  --reporter=default
echo "[check-migration-replay] done"
