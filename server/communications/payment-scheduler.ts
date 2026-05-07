import { storage } from "../storage";
import { sendPaymentChase } from "./email-sender";
import { getUncachableGmailClient, isGmailConfigured } from "../gmail/client";
import type { InsertPaymentReminder } from "@shared/schema";

const REMINDER_SCHEDULE = [
  { type: "first", daysAfter: 7 },
  { type: "second", daysAfter: 14 },
  { type: "final", daysAfter: 21 },
  { type: "overdue", daysAfter: 30 },
] as const;

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export async function scheduleReminders(certificatId: number, recipientEmail: string): Promise<void> {
  const certificat = await storage.getCertificat(certificatId);
  if (!certificat) throw new Error(`Certificat ${certificatId} not found`);

  const baseDate = certificat.dateIssued ? new Date(certificat.dateIssued) : new Date();

  for (const schedule of REMINDER_SCHEDULE) {
    const scheduledDate = new Date(baseDate);
    scheduledDate.setDate(scheduledDate.getDate() + schedule.daysAfter);

    const reminder: InsertPaymentReminder = {
      projectId: certificat.projectId,
      certificatId,
      recipientType: "client",
      recipientEmail,
      reminderType: schedule.type,
      scheduledDate: scheduledDate.toISOString().split("T")[0],
      status: "scheduled",
    };

    await storage.createPaymentReminder(reminder);
  }

  console.log(`[PaymentScheduler] Scheduled ${REMINDER_SCHEDULE.length} reminders for certificat ${certificatId}`);
}

export function startScheduler(intervalMs: number = 60 * 60 * 1000) {
  if (schedulerInterval) return;

  console.log(`[PaymentScheduler] Starting scheduler, checking every ${intervalMs / 1000}s`);
  schedulerInterval = setInterval(() => {
    processDueReminders().catch(console.error);
    processDesignContractDigest().catch(console.error);
  }, intervalMs);

  setTimeout(() => {
    processDueReminders().catch(console.error);
    processDesignContractDigest().catch(console.error);
  }, 30000);
}

type DigestRow = Awaited<ReturnType<typeof storage.getReachedUninvoicedMilestones>>[number];

const OVERDUE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const IMMINENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const REMINDER_QUIET_MS = 24 * 60 * 60 * 1000;

// Splits rows into overdue (>7d) and imminent (≤14d). Exported for tests.
export function partitionDigestRows(
  rows: readonly DigestRow[],
  now: Date = new Date(),
): { overdue: DigestRow[]; imminent: DigestRow[] } {
  const nowMs = now.getTime();
  const overdue: DigestRow[] = [];
  const imminent: DigestRow[] = [];
  for (const r of rows) {
    if (!r.milestone.reachedAt) continue;
    const ageMs = nowMs - new Date(r.milestone.reachedAt).getTime();
    if (ageMs > OVERDUE_THRESHOLD_MS) overdue.push(r);
    else if (ageMs >= 0 && ageMs <= IMMINENT_WINDOW_MS) imminent.push(r);
  }
  return { overdue, imminent };
}

// Group rows by uploader. Rows without an uploader are dropped.
export function groupRowsByArchitect(
  rows: readonly DigestRow[],
): Map<number, DigestRow[]> {
  const out = new Map<number, DigestRow[]>();
  for (const row of rows) {
    const uid = row.contract.uploadedByUserId;
    if (uid == null) continue;
    const list = out.get(uid) ?? [];
    list.push(row);
    out.set(uid, list);
  }
  return out;
}

async function processDesignContractDigest(): Promise<void> {
  try {
    const allDue = await storage.getReachedUninvoicedMilestones({
      staleAfterMs: 0,
      reminderQuietMs: REMINDER_QUIET_MS,
    });
    if (allDue.length === 0) return;

    const byArchitect = groupRowsByArchitect(allDue);
    const gmailReady = isGmailConfigured();

    for (const [architectUserId, rows] of Array.from(byArchitect.entries())) {
      const { overdue, imminent } = partitionDigestRows(rows);
      if (overdue.length === 0 && imminent.length === 0) continue;

      const user = await storage.getUser(architectUserId);
      const recipient = user?.email ?? null;

      console.log(
        `[design-digest] user=${architectUserId} email=${recipient ?? "(unknown)"} ` +
          `overdue=${overdue.length} imminent=${imminent.length}`,
      );

      if (gmailReady && recipient) {
        try {
          await sendDesignDigestEmail(recipient, overdue, imminent);
        } catch (err) {
          console.error(
            `[design-digest] gmail send failed for user=${architectUserId}:`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
      } else {
        for (const row of [...overdue, ...imminent]) {
          console.log(
            `[design-digest]   project=${row.project.code} "${row.milestone.labelFr}" amount=${row.milestone.amountTtc}`,
          );
        }
      }

      for (const row of [...overdue, ...imminent]) {
        await storage.markDesignContractMilestoneReminderSent(row.milestone.id);
      }
    }
  } catch (err) {
    console.error("[design-digest] error:", err);
  }
}

export function buildDigestBody(
  overdue: readonly DigestRow[],
  imminent: readonly DigestRow[],
): { subject: string; body: string } {
  const fmt = (r: DigestRow) =>
    `  - [${r.project.code}] ${r.project.name} — "${r.milestone.labelFr}" · ${r.milestone.amountTtc} € TTC` +
    (r.milestone.reachedAt
      ? ` · reached ${new Date(r.milestone.reachedAt).toISOString().slice(0, 10)}`
      : "");
  const total = overdue.length + imminent.length;
  const sections: string[] = [
    `You have ${total} design-contract milestone(s) awaiting invoicing.`,
    "",
  ];
  if (overdue.length > 0) {
    sections.push(`OVERDUE — reached more than 7 days ago (${overdue.length}):`);
    sections.push(...overdue.map(fmt));
    sections.push("");
  }
  if (imminent.length > 0) {
    sections.push(`UPCOMING — reached within last 14 days (${imminent.length}):`);
    sections.push(...imminent.map(fmt));
    sections.push("");
  }
  sections.push("Open the dashboard to invoice them: /dashboard");
  return {
    subject: `[Architrak] ${total} design-contract milestone(s) awaiting invoice`,
    body: sections.join("\n"),
  };
}

async function sendDesignDigestEmail(
  recipient: string,
  overdue: readonly DigestRow[],
  imminent: readonly DigestRow[],
): Promise<void> {
  const gmail = await getUncachableGmailClient();
  const { subject, body } = buildDigestBody(overdue, imminent);
  const raw = [
    `From: me`,
    `To: ${recipient}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    body,
  ].join("\r\n");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: Buffer.from(raw).toString("base64url") },
  });
}

export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

async function processDueReminders(): Promise<void> {
  try {
    const today = new Date().toISOString().split("T")[0];
    const dueReminders = await storage.getDuePaymentReminders(today);

    if (dueReminders.length === 0) return;

    console.log(`[PaymentScheduler] Processing ${dueReminders.length} due reminders`);

    for (const reminder of dueReminders) {
      try {
        await sendPaymentChase(reminder.id);
      } catch (err) {
        console.error(`[PaymentScheduler] Failed to send reminder ${reminder.id}:`, err);
      }
    }
  } catch (err) {
    console.error("[PaymentScheduler] Error processing reminders:", err);
  }
}
