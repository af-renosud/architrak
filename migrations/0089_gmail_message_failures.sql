-- Task #506 — per-message failure counter for the Gmail poll.
-- When processMessage() throws repeatedly for the same message id (e.g. a
-- corrupt attachment), the error fires every 15-minute poll with no
-- operator visibility.  This table counts consecutive poll failures so the
-- dashboard can surface stuck messages and let the architect skip them.
--
-- skipped_at / skip_reason: operator sets these to stop future polling.
-- A skipped row is ALSO inserted into gmail_processed_messages so the
-- poll's filterUnprocessedGmailMessageIds call permanently excludes it.
CREATE TABLE IF NOT EXISTS "gmail_message_failures" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"message_id" text NOT NULL,
	"fail_count" integer NOT NULL DEFAULT 1,
	"last_failed_at" timestamp NOT NULL,
	"skipped_at" timestamp,
	"skip_reason" text,
	CONSTRAINT "gmail_message_failures_user_message_unique" UNIQUE("user_id","message_id")
);
