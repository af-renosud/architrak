import { env } from "../env";
import { getUncachableGmailClient, isGmailConfigured } from "../gmail/client";

// Lightweight operator-alert plumbing for post-deploy maintenance scripts.
// Designed to be reused by every backfill / repair job that runs out of
// `scripts/post-merge.sh`, so a sustained failure (AI quota burn, parser
// regression, ArchiDoc outage, ...) lands in an actual inbox instead of
// scrolling past in the deploy log.
//
// Channel: Gmail via the existing connector. Recipient is configured via
// the `OPERATOR_ALERT_EMAIL` env var (comma-separated for multiple
// addressees). When the var is unset OR the Gmail connector isn't
// available (e.g. local dev, CI), `sendOperatorAlert` is a best-effort
// no-op that logs the alert payload to stderr and returns
// `{ delivered: false, reason }` instead of throwing — callers MUST NOT
// let alerting failures abort the underlying maintenance job.

export interface OperatorAlert {
  /** Short tag identifying the source script (e.g. "backfill-page-hints"). */
  source: string;
  /** Human-readable subject. The recipient name + source is prepended. */
  subject: string;
  /** Plain-text body. A deploy/timestamp footer is appended automatically. */
  body: string;
}

export interface OperatorAlertResult {
  delivered: boolean;
  /** Why the alert was not delivered (only set when `delivered=false`). */
  reason?: string;
  /** Recipient list actually used (parsed from OPERATOR_ALERT_EMAIL). */
  recipients: string[];
}

export function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildAlertFooter(now: Date = new Date()): string {
  const deployId =
    env.REPLIT_DEPLOYMENT_ID || env.REPL_ID || env.REPL_SLUG || "unknown";
  return `\n\n--\nDeploy: ${deployId}\nTimestamp: ${now.toISOString()}`;
}

export async function sendOperatorAlert(
  alert: OperatorAlert,
): Promise<OperatorAlertResult> {
  const recipients = parseRecipients(env.OPERATOR_ALERT_EMAIL);
  const fullBody = `${alert.body}${buildAlertFooter()}`;
  const fullSubject = `[ops:${alert.source}] ${alert.subject}`;

  if (recipients.length === 0) {
    console.warn(
      `[operator-alert] OPERATOR_ALERT_EMAIL not set — alert from ${alert.source} not delivered. ` +
        `Subject: ${alert.subject}`,
    );
    return { delivered: false, reason: "no-recipients", recipients: [] };
  }
  if (!isGmailConfigured()) {
    console.warn(
      `[operator-alert] Gmail connector not configured — alert from ${alert.source} not delivered. ` +
        `Subject: ${alert.subject}`,
    );
    return { delivered: false, reason: "gmail-not-configured", recipients };
  }

  try {
    const gmail = await getUncachableGmailClient();
    const raw = [
      `From: me`,
      `To: ${recipients.join(", ")}`,
      `Subject: ${fullSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      fullBody,
    ].join("\r\n");
    const encoded = Buffer.from(raw).toString("base64url");
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded },
    });
    console.log(
      `[operator-alert] delivered alert from ${alert.source} to ${recipients.length} recipient(s).`,
    );
    return { delivered: true, recipients };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[operator-alert] failed to deliver alert from ${alert.source}: ${reason}`,
    );
    return { delivered: false, reason, recipients };
  }
}
