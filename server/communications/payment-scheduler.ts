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

/**
 * Daily reminder digest for design-contract milestones whose status is
 * `reached` and whose reachedAt is older than 7 days without a matching
 * invoice. Per-architect: results are grouped by uploadedByUserId and one
 * digest email is sent per architect (to their Google account email) via
 * the existing Gmail send infrastructure. The storage layer enforces a
 * 24h reminder quiet period so a single milestone can't be re-sent more
 * than once per day. The dashboard strip surfaces the same data
 * immediately at `/api/design-contracts/dashboard-actions`.
 */
async function processDesignContractDigest(): Promise<void> {
  try {
    const overdue = await storage.getReachedUninvoicedMilestones({
      staleAfterMs: 7 * 24 * 60 * 60 * 1000,
      reminderQuietMs: 24 * 60 * 60 * 1000,
    });
    if (overdue.length === 0) return;

    const byArchitect = new Map<number, typeof overdue>();
    for (const row of overdue) {
      const uid = row.contract.uploadedByUserId;
      if (uid == null) continue;
      const list = byArchitect.get(uid) ?? [];
      list.push(row);
      byArchitect.set(uid, list);
    }

    const gmailReady = isGmailConfigured();

    for (const [architectUserId, rows] of Array.from(byArchitect.entries())) {
      const user = await storage.getUser(architectUserId);
      const recipient = user?.email ?? null;

      console.log(
        `[design-digest] user=${architectUserId} email=${recipient ?? "(unknown)"} milestones=${rows.length}`,
      );

      if (gmailReady && recipient) {
        try {
          await sendDesignDigestEmail(recipient, rows);
        } catch (err) {
          console.error(
            `[design-digest] gmail send failed for user=${architectUserId}:`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
      } else {
        for (const row of rows) {
          console.log(
            `[design-digest]   project=${row.project.code} "${row.milestone.labelFr}" amount=${row.milestone.amountTtc}`,
          );
        }
      }

      for (const row of rows) {
        await storage.markDesignContractMilestoneReminderSent(row.milestone.id);
      }
    }
  } catch (err) {
    console.error("[design-digest] error:", err);
  }
}

async function sendDesignDigestEmail(
  recipient: string,
  rows: Awaited<ReturnType<typeof storage.getReachedUninvoicedMilestones>>,
): Promise<void> {
  const gmail = await getUncachableGmailClient();
  const lines = rows.map(
    (r) =>
      `  - [${r.project.code}] ${r.project.name} — "${r.milestone.labelFr}" · ${r.milestone.amountTtc} € TTC` +
      (r.milestone.reachedAt ? ` · reached ${new Date(r.milestone.reachedAt).toISOString().slice(0, 10)}` : ""),
  );
  const body = [
    `You have ${rows.length} design-contract milestone(s) reached more than 7 days ago that have not yet been invoiced:`,
    "",
    ...lines,
    "",
    "Open the dashboard to invoice them: /dashboard",
  ].join("\n");
  const subject = `[Architrak] ${rows.length} design-contract milestone(s) awaiting invoice`;

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
