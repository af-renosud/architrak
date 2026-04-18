#!/bin/bash
# Apply the current shared/schema.ts directly to a throwaway scratch database
# using `drizzle-kit push`. This bypasses migration history and can drop
# columns silently — it MUST NEVER be run against the shared dev, staging,
# or production database.
#
# Usage:
#   ALLOW_DESTRUCTIVE_PUSH=true \
#   DATABASE_URL=postgres://localhost:5432/architrak_scratch \
#     bash scripts/db-push-scratch.sh
#
# The script refuses to run unless ALLOW_DESTRUCTIVE_PUSH=true is set, and it
# refuses any DATABASE_URL whose host looks like a managed/shared environment.
set -euo pipefail

if [ "${ALLOW_DESTRUCTIVE_PUSH:-}" != "true" ]; then
  echo "refusing to push: set ALLOW_DESTRUCTIVE_PUSH=true to acknowledge" >&2
  echo "this command bypasses migration history and is only for scratch DBs." >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "refusing to push: DATABASE_URL is not set" >&2
  exit 1
fi

case "$DATABASE_URL" in
  *neon.tech*|*neon.build*|*supabase.co*|*rds.amazonaws.com*|*render.com*|*railway.app*|*replit.dev*|*replit.app*|*helium*|*pooler*)
    echo "refusing to push: DATABASE_URL looks like a hosted/shared database." >&2
    echo "drizzle-kit push is only allowed against a local scratch database." >&2
    exit 1
    ;;
esac

REDACTED_URL=$(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@]*@#://***@#; s#\?.*$##')
echo "pushing shared/schema.ts directly to ${REDACTED_URL}"
exec npx drizzle-kit push
