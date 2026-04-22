#!/bin/bash
set -e
npm install
npx tsx scripts/run-migrations.mjs
# Idempotent backfill of contractor identifiers (SIRET today, others later) from
# the ArchiDoc mirror. Safe to re-run on every deploy; keeps newly-added
# identifier columns in sync without manual operator action.
npx tsx scripts/backfill-contractor-identifiers.ts
