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
 * Task #175 — daily reminder digest. Architects who have any
 * reached-but-not-invoiced design-contract milestones older than 7d
 * receive a once-per-24h log entry (full email rendering deferred to
 * the next iteration; the storage method already gates on
 * reminderQuietMs so we won't spam). The dashboard strip
 * (`/api/design-contracts/dashboard-actions`) is the user-facing
 * surface today; this digest path is the cron hook that exists so
 * email integration is a one-line addition later.
 */
async function processDesignContractDigest(): Promise<void> {
  try {
    const overdue = await storage.getReachedUninvoicedMilestones({
      staleAfterMs: 7 * 24 * 60 * 60 * 1000,
      reminderQuietMs: 24 * 60 * 60 * 1000,
    });
    if (overdue.length === 0) return;
    console.log(
      `[PaymentScheduler] Design-contract digest: ${overdue.length} milestone(s) reached >7d ago without invoice`,
    );
    for (const row of overdue) {
      await storage.markDesignContractMilestoneReminderSent(row.milestone.id);
    }
  } catch (err) {
    console.error("[PaymentScheduler] Design-contract digest error:", err);
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
