/**
 * Task #322 — the single source of truth for the email-intake watermark.
 *
 * Emails received before this instant must never be ingested (Gmail
 * monitor) nor processed (background email-document sweeper). Configurable
 * via EMAIL_INTAKE_MIN_RECEIVED_AT; the default marks the beta reset on
 * Monday 2026-08-10 09:00 Europe/Paris, after the pre-existing backlog was
 * dumped (data migration 0057).
 */
import { env } from "../env";

export function getEmailIntakeCutoff(): Date {
  // env validation already guarantees this parses.
  return new Date(env.EMAIL_INTAKE_MIN_RECEIVED_AT);
}
