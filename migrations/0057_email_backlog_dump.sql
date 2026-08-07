-- Task #322 — one-shot backlog dump (data-only, prod-side action).
-- Architrak is in beta: the ~428 email documents captured before the
-- intake reset (Monday 2026-08-10 09:00 Europe/Paris = 07:00 UTC) are not
-- worth the AI tokens. Move every still-queued doc received before the
-- watermark to the terminal 'skipped' state so the background processor
-- never picks them up and no extraction is attempted. Rows are kept for
-- audit — nothing is deleted.
--
-- Guards: only pending/processing docs (terminal states untouched), only
-- pre-watermark receipts (anything newer keeps flowing), NULL received-at
-- treated as old (those rows predate reliable capture). Idempotent by
-- construction; a no-op on databases with no backlog.
UPDATE "email_documents"
SET "extraction_status" = 'skipped',
    "next_process_attempt_at" = NULL,
    "notes" = 'Backlog abandonné le 2026-08-10 (reset beta) — non traité automatiquement.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "extraction_status" IN ('pending', 'processing')
  AND ("email_received_at" IS NULL OR "email_received_at" < '2026-08-10T07:00:00Z');
