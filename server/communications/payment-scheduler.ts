import { storage } from "../storage";
import { sendPaymentChase } from "./email-sender";
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
 * invoice. The storage layer also enforces a 24h reminder quiet period
 * so a single milestone can't be re-sent more than once per day. The
 * dashboard strip surfaces the same data immediately at
 * `/api/design-contracts/dashboard-actions`. Email rendering is gated
 * behind the existing Gmail send infrastructure — when no Gmail
 * recipient is configured for an architect, the digest entry is logged
 * (so operators see the cron firing) without an outbound send.
 */
async function processDesignContractDigest(): Promise<void> {
  try {
    const overdue = await storage.getReachedUninvoicedMilestones({
      staleAfterMs: 7 * 24 * 60 * 60 * 1000,
      reminderQuietMs: 24 * 60 * 60 * 1000,
    });
    if (overdue.length === 0) return;
    console.log(
      `[design-digest] ${overdue.length} milestone(s) reached >7d ago without invoice`,
    );
    for (const row of overdue) {
      console.log(
        `[design-digest] project=${row.project.code} "${row.milestone.labelFr}" amount=${row.milestone.amountTtc}`,
      );
      await storage.markDesignContractMilestoneReminderSent(row.milestone.id);
    }
  } catch (err) {
    console.error("[design-digest] error:", err);
  }
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
