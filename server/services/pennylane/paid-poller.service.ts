/**
 * Hourly Pennylane paid-status poller (Task #214 phase E).
 *
 * Walks every fee_entry whose `pennylane_invoice_id` is set and
 * `pennylane_paid_at` is null, hits GET /customer_invoices/{id},
 * and writes `paid_at` + `paid_amount` + `status` back when Pennylane
 * reports the invoice as paid. Feature-gated on PENNYLANE_PUSH_ENABLED
 * — turning the flag off freezes the poller as a no-op.
 *
 * One-pass-per-tick design (no parallel batch fetches): the unpaid
 * cohort is small (a few dozen at most for one architect firm) and
 * the v2 API rate-limits per-second; serial calls keep us well under
 * the budget without burning a token bucket on every tick.
 */

import { storage } from "../../storage";
import {
  isPennylanePushEnabled,
  isPennylaneDryRun,
  pennylaneRequest,
  PennylaneApiError,
} from "./client";
import type { FeeEntry } from "@shared/schema";

let pollerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Default poll cadence — once per hour (per spec). Operator can call
 * `pollPennylanePaidStatus()` directly from the admin surface for a
 * manual sweep without waiting for the next tick.
 */
export const PAID_POLLER_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Per-tick batch ceiling. Far above the realistic unpaid cohort but
 * keeps a runaway poll from spending the full v2 rate budget if the
 * mirror columns ever desync.
 */
const PAID_POLLER_BATCH_LIMIT = 200;

interface PennylaneInvoiceStatusResponse {
  id?: number | string;
  invoice?: {
    id?: number | string;
    status?: string;
    paid_at?: string | null;
    paid_amount?: number | string | null;
    total_amount?: number | string | null;
  };
  status?: string;
  paid_at?: string | null;
  paid_amount?: number | string | null;
  total_amount?: number | string | null;
}

interface PaidPollSummary {
  scanned: number;
  paidUpdated: number;
  statusUpdated: number;
  failed: number;
  skipped: number;
}

export async function pollPennylanePaidStatus(): Promise<PaidPollSummary> {
  const summary: PaidPollSummary = { scanned: 0, paidUpdated: 0, statusUpdated: 0, failed: 0, skipped: 0 };
  if (!isPennylanePushEnabled()) return summary;
  if (isPennylaneDryRun()) {
    // No real invoice ids on Pennylane to poll. Bail cleanly.
    return summary;
  }

  const cohort = await storage.listFeeEntriesWithPennylaneInvoice({
    onlyUnpaid: true,
    limit: PAID_POLLER_BATCH_LIMIT,
  });
  summary.scanned = cohort.length;

  for (const entry of cohort) {
    if (!entry.pennylaneInvoiceId) {
      summary.skipped += 1;
      continue;
    }
    try {
      const fresh = await pennylaneRequest<PennylaneInvoiceStatusResponse>({
        method: "GET",
        path: `/customer_invoices/${entry.pennylaneInvoiceId}`,
      });
      const updated = await applyPaidUpdate(entry, fresh);
      if (updated === "paid") summary.paidUpdated += 1;
      else if (updated === "status") summary.statusUpdated += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      const transient = err instanceof PennylaneApiError ? err.transient : false;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[PennylanePaidPoller] fee_entry ${entry.id} (invoice ${entry.pennylaneInvoiceId}) failed (${transient ? "transient" : "permanent"}): ${msg}`,
      );
      // We intentionally do NOT dead-letter the row — the next tick
      // will re-attempt. Repeated permanent failures (e.g. invoice
      // deleted in Pennylane) show up in admin logs and are resolved
      // manually.
    }
  }
  return summary;
}

type UpdateOutcome = "paid" | "status" | "noop";

async function applyPaidUpdate(
  entry: FeeEntry,
  res: PennylaneInvoiceStatusResponse,
): Promise<UpdateOutcome> {
  const status = res.invoice?.status ?? res.status ?? null;
  const paidAtRaw = res.invoice?.paid_at ?? res.paid_at ?? null;
  const paidAmountRaw = res.invoice?.paid_amount ?? res.paid_amount ?? null;

  if (paidAtRaw && !entry.pennylanePaidAt) {
    const paidAt = new Date(paidAtRaw);
    if (Number.isNaN(paidAt.getTime())) {
      console.warn(
        `[PennylanePaidPoller] fee_entry ${entry.id} got unparseable paid_at "${paidAtRaw}" — skipping`,
      );
      return "noop";
    }
    const paidAmount = paidAmountRaw === null || paidAmountRaw === undefined
      ? null
      : Number(paidAmountRaw);
    await storage.setFeeEntryPennylanePaid({
      feeEntryId: entry.id,
      paidAt,
      paidAmount: paidAmount !== null && Number.isFinite(paidAmount) ? paidAmount : null,
      pennylaneStatus: status ?? "paid",
    });
    console.log(
      `[PennylanePaidPoller] fee_entry ${entry.id} marked paid at ${paidAt.toISOString()} (${paidAmount ?? "?"} €)`,
    );
    return "paid";
  }

  // Status drift (sent → overdue, etc.) without a paid_at. Write
  // through so the UI / admin views reflect Pennylane's truth.
  if (status && status !== entry.pennylaneStatus) {
    await storage.setFeeEntryPennylanePaid({
      feeEntryId: entry.id,
      paidAt: entry.pennylanePaidAt,
      paidAmount: entry.pennylanePaidAmount === null ? null : Number(entry.pennylanePaidAmount),
      pennylaneStatus: status,
    });
    return "status";
  }
  return "noop";
}

export function startPennylanePaidPoller(
  intervalMs: number = PAID_POLLER_INTERVAL_MS,
): void {
  if (pollerInterval) return;
  if (!isPennylanePushEnabled()) {
    console.log("[PennylanePaidPoller] not started — feature disabled");
    return;
  }
  pollerInterval = setInterval(() => {
    pollPennylanePaidStatus()
      .then((s) => {
        if (s.scanned > 0) {
          console.log(
            `[PennylanePaidPoller] tick complete — scanned=${s.scanned} paid=${s.paidUpdated} status=${s.statusUpdated} failed=${s.failed}`,
          );
        }
      })
      .catch((err) => console.error("[PennylanePaidPoller] tick crashed:", err));
  }, intervalMs);
  console.log(`[PennylanePaidPoller] started (every ${Math.round(intervalMs / 60000)} min)`);
}

export function stopPennylanePaidPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}
