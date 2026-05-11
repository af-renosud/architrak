import { env } from "../env";
import { getUncachableGmailClient, isGmailConfigured } from "../gmail/client";
import { getOutstandingFeesGlobal } from "../services/outstanding-fees.service";
import {
  buildFeeInvoiceDescription,
  type OutstandingFeeSummary,
} from "@shared/fee-description";
import { formatCurrencyNoSymbol } from "@shared/financial-utils";

// Weekly outstanding architect-fee digest.
//
// Mirrors the data the in-app `OutstandingFeesPanel` shows (totals,
// aging buckets, per-project rollup, per-entry copy paragraphs built by
// `buildFeeInvoiceDescription`) and emails it to the accounting team
// every Monday morning so they can work without logging in.
//
// Schedule: ticks hourly, sends once when the local clock first reaches
// `OUTSTANDING_FEES_DIGEST_HOUR` on a Monday. The "already sent today"
// guard is in-memory only — after a Monday-morning restart the digest
// could fire twice, which is acceptable noise vs. building DB
// persistence for a once-per-week job. The dedupe key is a LOCAL-time
// date string (`YYYY-MM-DD` from getFullYear/Month/Date) so it stays
// aligned with the local-time `getDay()` / `getHours()` predicates and
// cannot roll over at UTC midnight on non-UTC servers.
//
// Recipients come from `OUTSTANDING_FEES_DIGEST_RECIPIENTS` (CSV).
// Unset → scheduler still runs but skips with a log notice; this keeps
// dev and CI quiet without disabling the wiring.

const SEND_DAY = 1; // Monday (Sun=0)

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastSentIsoDate: string | null = null;

export function parseDigestRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function localDateKey(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function shouldSendDigest(
  now: Date,
  lastSent: string | null,
  sendHour: number,
): boolean {
  if (now.getDay() !== SEND_DAY) return false;
  if (now.getHours() < sendHour) return false;
  if (lastSent === localDateKey(now)) return false;
  return true;
}

export function buildOutstandingFeesDigest(
  summary: OutstandingFeeSummary,
  now: Date = new Date(),
): { subject: string; body: string } {
  const dateStr = now.toISOString().slice(0, 10);
  const totalHt = formatCurrencyNoSymbol(summary.totalFeeHt);
  const entryWord = summary.totalCount === 1 ? "entry" : "entries";
  const subject =
    `[Architrak] Outstanding architect fees — ${summary.totalCount} ` +
    `${entryWord} (${totalHt} HT) — ${dateStr}`;

  const lines: string[] = [];
  lines.push(
    `Outstanding architect Project-Management fees as of ${dateStr}.`,
  );
  lines.push("");
  lines.push(`Total: ${summary.totalCount} ${entryWord}, ${totalHt} HT.`);
  lines.push("");
  lines.push("Aging buckets:");
  for (const b of summary.buckets) {
    lines.push(
      `  - ${b.label} days: ${b.count} entry(ies), ` +
        `${formatCurrencyNoSymbol(b.totalFeeHt)} HT`,
    );
  }
  lines.push("");

  if (summary.byProject.length > 0) {
    lines.push(`By project (${summary.byProject.length}):`);
    for (const p of summary.byProject) {
      lines.push(
        `  - [${p.projectCode}] ${p.projectName}: ${p.count} entry(ies), ` +
          `${formatCurrencyNoSymbol(p.totalFeeHt)} HT, oldest ${p.oldestAgeDays}d`,
      );
    }
    lines.push("");
  }

  if (summary.entries.length > 0) {
    lines.push("Per-entry detail:");
    lines.push("");
    for (const e of summary.entries) {
      lines.push(
        `[${e.projectCode}] ${e.projectName} — age ${e.ageDays}d`,
      );
      lines.push(
        buildFeeInvoiceDescription({
          contractorName: e.contractorName,
          invoiceNumber: e.invoiceNumber,
          devisCode: e.devisCode,
          amountHt: e.amountHt,
          amountTtc: e.amountTtc,
          feePercentage: e.feePercentage,
        }),
      );
      lines.push("");
    }
  }

  lines.push("Open the in-app monitor: /dashboard");

  return { subject, body: lines.join("\n") };
}

async function sendDigestEmail(
  recipients: string[],
  subject: string,
  body: string,
): Promise<void> {
  const gmail = await getUncachableGmailClient();
  const raw = [
    "From: me",
    `To: ${recipients.join(", ")}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    body,
  ].join("\r\n");
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: Buffer.from(raw).toString("base64url") },
  });
}

export async function processOutstandingFeesDigest(
  now: Date = new Date(),
): Promise<void> {
  if (!shouldSendDigest(now, lastSentIsoDate, env.OUTSTANDING_FEES_DIGEST_HOUR)) {
    return;
  }

  const today = localDateKey(now);
  const recipients = parseDigestRecipients(env.OUTSTANDING_FEES_DIGEST_RECIPIENTS);

  if (recipients.length === 0) {
    console.warn(
      "[outstanding-fees-digest] OUTSTANDING_FEES_DIGEST_RECIPIENTS not set — skipping Monday digest",
    );
    lastSentIsoDate = today;
    return;
  }
  if (!isGmailConfigured()) {
    console.warn(
      "[outstanding-fees-digest] Gmail connector not configured — skipping Monday digest",
    );
    lastSentIsoDate = today;
    return;
  }

  try {
    const summary = await getOutstandingFeesGlobal();
    if (summary.totalCount === 0) {
      console.log(
        "[outstanding-fees-digest] no outstanding entries — nothing to send",
      );
      lastSentIsoDate = today;
      return;
    }
    const { subject, body } = buildOutstandingFeesDigest(summary, now);
    await sendDigestEmail(recipients, subject, body);
    lastSentIsoDate = today;
    console.log(
      `[outstanding-fees-digest] delivered to ${recipients.length} recipient(s), ` +
        `${summary.totalCount} entries, ${formatCurrencyNoSymbol(summary.totalFeeHt)} HT`,
    );
  } catch (err) {
    console.error("[outstanding-fees-digest] error:", err);
  }
}

export function startOutstandingFeesDigestScheduler(
  intervalMs: number = 60 * 60 * 1000,
): void {
  if (schedulerInterval) return;
  console.log(
    `[outstanding-fees-digest] scheduler started, checking every ${intervalMs / 1000}s ` +
      `for Monday ${env.OUTSTANDING_FEES_DIGEST_HOUR.toString().padStart(2, "0")}:00 send`,
  );
  schedulerInterval = setInterval(() => {
    processOutstandingFeesDigest().catch((err) =>
      console.error("[outstanding-fees-digest] tick error:", err),
    );
  }, intervalMs);
}

export function stopOutstandingFeesDigestScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

export function __resetOutstandingFeesDigestForTests(): void {
  lastSentIsoDate = null;
  stopOutstandingFeesDigestScheduler();
}
