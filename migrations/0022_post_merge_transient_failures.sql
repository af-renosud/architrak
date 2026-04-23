-- Task #130: persistent counter table for the post-merge transient-failure
-- escalation path. Each row tracks one source_tag (e.g. "backfill-page-hints")
-- across consecutive deploys. Successful runs reset consecutive_failures to 0;
-- once it crosses POST_MERGE_ESCALATE_AFTER (default 3) the next failure is
-- reported with subject prefix `[escalated]` instead of `[transient]`.
-- Schema-error aborts (exit 2 from scripts/lib/run-or-classify.sh) NEVER touch
-- this table — they keep their own loud-fail / abort-deploy path from #126.
CREATE TABLE IF NOT EXISTS "post_merge_transient_failures" (
  "source_tag" text PRIMARY KEY NOT NULL,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_exit_code" integer,
  "last_failure_at" timestamp,
  "last_cleared_at" timestamp,
  "recent_failures" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
