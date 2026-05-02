#!/usr/bin/env tsx
/**
 * One-off: invoke the DLQ retry orchestrator path against a given
 * webhook_deliveries_out row id. Mirrors what
 * `POST /api/admin/webhook-dlq/:id/retry` does, minus the auth/HTTP
 * layer. EventId is preserved by storage.resetWebhookDeliveryForRetry.
 *
 * Usage: tsx scripts/at5-dlq-retry.ts <deliveryId>
 */
import { storage } from "../server/storage";
import { attemptDelivery } from "../server/services/webhook-delivery";

async function main(): Promise<void> {
  const id = Number(process.argv[2]);
  if (!Number.isFinite(id) || id <= 0) {
    console.error("usage: tsx scripts/at5-dlq-retry.ts <deliveryId>");
    process.exit(1);
  }
  const before = await storage.getWebhookDeliveryOutById(id);
  if (!before) {
    console.error(`[fatal] no webhook_deliveries_out row for id=${id}`);
    process.exit(1);
  }
  console.log(`==== DLQ retry id=${id} @ ${new Date().toISOString()} ====`);
  console.log(
    `[before] eventId=${before.eventId} state=${before.state} attempts=${before.attemptCount}`,
  );
  const reset = await storage.resetWebhookDeliveryForRetry(id);
  if (!reset) {
    console.error("[fatal] reset failed");
    process.exit(1);
  }
  console.log(
    `[reset]  state=${reset.state} attempts=${reset.attemptCount} eventIdPreserved=${reset.eventId === before.eventId}`,
  );
  const after = await attemptDelivery(id);
  console.log(`[after]  state=${after.state} attempts=${after.attemptCount}`);
  console.log(
    `[after]  succeededAt=${after.succeededAt?.toISOString() ?? "(none)"}  deadLetteredAt=${after.deadLetteredAt?.toISOString() ?? "(none)"}`,
  );
  console.log(
    `[after]  lastError=${after.lastErrorBody ? after.lastErrorBody.slice(0, 250) : "(none)"}`,
  );
}

main().then(
  () => setTimeout(() => process.exit(0), 300),
  (err) => {
    console.error(`[fatal] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  },
);
