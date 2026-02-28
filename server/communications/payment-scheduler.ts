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
  schedulerInterval = setInterval(() => processDueReminders().catch(console.error), intervalMs);

  setTimeout(() => processDueReminders().catch(console.error), 30000);
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
