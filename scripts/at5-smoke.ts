#!/usr/bin/env tsx
/**
 * AT5 outbound smoke tester — one-off CLI for the Archidoc integration
 * round-trip windows (Fri 1 May synthetic warm-up + Sat 2 May live test).
 *
 * Usage:
 *   tsx scripts/at5-smoke.ts work-auth [--envelope-id <id>] [--event-id <uuid>] [--archidoc-project-id <value|null>]
 *   tsx scripts/at5-smoke.ts breach    --envelope-id <id> [--event-id <uuid>]
 *   tsx scripts/at5-smoke.ts dedup     --event-id <existing-uuid>
 *   tsx scripts/at5-smoke.ts status    --event-id <uuid>
 *
 * --archidoc-project-id overrides the fixture's archidocProjectId for the
 * fire. Pass the literal string `null` to send JSON null (Archidoc treats
 * the field as optional per §5.3.1). Pass any other string to send that
 * value verbatim — e.g. `abc-123` to deliberately trigger a 23503 FK
 * violation on Archidoc's staging projects table for dead-letter
 * verification.
 *
 * Modes:
 *   work-auth  Production-realistic — enqueue + immediate dispatch via
 *              the full webhook-delivery orchestrator. Mints a fresh
 *              UUIDv7 eventId by default. Use for T+2 (Sat) and the
 *              Friday-evening synthetic warm-up.
 *   breach     Same orchestrator path, signed_pdf_retention_breach.
 *              Use for T+8 (envelopeId=1234567890, expect 200) and
 *              T+10 (envelopeId=5678, expect 410 unknown envelope).
 *   dedup      Wire-level re-POST of an existing eventId's persisted
 *              payload — bypasses our local row state (which is already
 *              terminal) so the second POST actually hits Archidoc.
 *              Used for T+5: expect Archidoc to return 200 +
 *              {deduplicated:true}. Pass the eventId printed by the
 *              T+2 work-auth invocation.
 *   status     Read-only — print the local webhook_deliveries_out row
 *              for a known eventId (state, attemptCount, last error).
 *
 * Test plan (Sat 2 May 14:00–14:30 CEST):
 *   T+2  : tsx scripts/at5-smoke.ts work-auth --envelope-id 1234567890
 *   T+5  : tsx scripts/at5-smoke.ts dedup --event-id <uuid from T+2>
 *   T+8  : tsx scripts/at5-smoke.ts breach --envelope-id 1234567890
 *   T+10 : tsx scripts/at5-smoke.ts breach --envelope-id 5678
 *   T+12 : tsx scripts/at5-smoke.ts status --event-id <each uuid above>
 *
 * The script intentionally reuses the production code paths
 * (enqueueWebhookDelivery, postWorkAuthorisation) so we exercise the
 * exact same HMAC signing, payload serialisation, retry semantics and
 * row-state machine that real AT4-driven traffic will hit. No mock
 * surfaces; no test seams beyond the explicit eventId/envelopeId
 * overrides documented above.
 */

import { uuidv7 } from "../server/lib/uuidv7";
import { storage } from "../server/storage";
import {
  enqueueWebhookDelivery,
} from "../server/services/webhook-delivery";
import {
  postWorkAuthorisation,
  getWorkAuthorisationUrl,
  isOutboundDeliveryConfigured,
  type OutboundEventType,
} from "../server/services/archidoc-webhook-client";
import workAuthorisedFixture from "../docs/wire-fixtures/work-authorised.json";
import retentionBreachFixture from "../docs/wire-fixtures/signed-pdf-retention-breach.json";

interface ParsedArgs {
  command: string;
  envelopeId?: string;
  eventId?: string;
  // undefined = use fixture value; null = override to JSON null;
  // string = override to that exact string value.
  archidocProjectId?: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [, , command, ...rest] = argv;
  if (!command) {
    printUsageAndExit("Missing command");
  }
  if (command === "--help" || command === "-h") {
    printUsageAndExit();
  }
  const out: ParsedArgs = { command };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--envelope-id") {
      if (!value) printUsageAndExit("--envelope-id requires a value");
      out.envelopeId = value;
      i++;
    } else if (flag === "--event-id") {
      if (!value) printUsageAndExit("--event-id requires a value");
      out.eventId = value;
      i++;
    } else if (flag === "--archidoc-project-id") {
      if (value === undefined || value === "") {
        printUsageAndExit("--archidoc-project-id requires a value (use the literal string `null` to send JSON null)");
      }
      out.archidocProjectId = value === "null" ? null : value;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      printUsageAndExit();
    } else {
      printUsageAndExit(`Unknown flag: ${flag}`);
    }
  }
  return out;
}

function printUsageAndExit(error?: string): never {
  if (error) console.error(`error: ${error}\n`);
  console.error(
    [
      "Usage:",
      "  tsx scripts/at5-smoke.ts work-auth [--envelope-id <id>] [--event-id <uuid>] [--archidoc-project-id <value|null>]",
      "  tsx scripts/at5-smoke.ts breach    --envelope-id <id> [--event-id <uuid>]",
      "  tsx scripts/at5-smoke.ts dedup     --event-id <existing-uuid>",
      "  tsx scripts/at5-smoke.ts status    --event-id <uuid>",
      "",
      "See script header for the Saturday test plan.",
    ].join("\n"),
  );
  process.exit(error ? 1 : 0);
}

function nowIso(): string {
  return new Date().toISOString();
}

function banner(label: string): void {
  console.log("");
  console.log(`==== ${label} @ ${nowIso()} ====`);
}

function preflight(): void {
  if (!isOutboundDeliveryConfigured()) {
    console.error(
      [
        "AT5 outbound surface is NOT fully configured.",
        "Required env vars:",
        "  - ARCHITRAK_WEBHOOK_SECRET (HMAC signing key, shared with Archidoc)",
        "  - ARCHIDOC_BASE_URL or ARCHIDOC_WORK_AUTH_URL (receiver URL)",
        "Refusing to fire the smoke without both.",
      ].join("\n"),
    );
    process.exit(2);
  }
  console.log(`[preflight] target URL : ${getWorkAuthorisationUrl()}`);
  console.log(`[preflight] secret     : present (${process.env.ARCHITRAK_WEBHOOK_SECRET?.length ?? 0} chars)`);
}

/**
 * Build a work_authorised payload from the fixture, with optional
 * eventId / envelopeId overrides. The rest of the fixture is preserved
 * byte-for-byte so Archidoc receives a contract-§5.3.1-compliant body.
 */
function buildWorkAuthorisedPayload(opts: {
  eventId: string;
  envelopeId?: string;
  archidocProjectId?: string | null;
}): {
  eventId: string;
  eventType: OutboundEventType;
} & Record<string, unknown> {
  const fixture = JSON.parse(JSON.stringify(workAuthorisedFixture)) as Record<string, unknown>;
  fixture.eventId = opts.eventId;
  fixture.eventType = "work_authorised";
  if (opts.envelopeId !== undefined) {
    fixture.archisignEnvelopeId = opts.envelopeId;
  }
  // archidocProjectId override: undefined preserves fixture value; null sends
  // JSON null; any string is sent verbatim. JSON null is contract-compliant
  // per §5.3.1 and is the supported shape for synthetic test fires when the
  // receiver's projects table doesn't have a matching row.
  if (opts.archidocProjectId !== undefined) {
    fixture.archidocProjectId = opts.archidocProjectId;
  }
  return fixture as { eventId: string; eventType: OutboundEventType } & Record<string, unknown>;
}

/**
 * Build a signed_pdf_retention_breach payload from the fixture. The
 * `originalSignedAt` is preserved verbatim from the fixture — Archidoc
 * correlates breaches against the prior work_authorised by byte-equality
 * on this field per §5.3.2.
 */
function buildRetentionBreachPayload(opts: { eventId: string; envelopeId: string }): {
  eventId: string;
  eventType: OutboundEventType;
} & Record<string, unknown> {
  const fixture = JSON.parse(JSON.stringify(retentionBreachFixture)) as Record<string, unknown>;
  fixture.eventId = opts.eventId;
  fixture.eventType = "signed_pdf_retention_breach";
  fixture.archisignEnvelopeId = opts.envelopeId;
  return fixture as { eventId: string; eventType: OutboundEventType } & Record<string, unknown>;
}

async function runWorkAuth(args: ParsedArgs): Promise<void> {
  const eventId = args.eventId ?? uuidv7();
  const payload = buildWorkAuthorisedPayload({
    eventId,
    envelopeId: args.envelopeId,
    archidocProjectId: args.archidocProjectId,
  });
  banner(
    `work-auth eventId=${eventId} envelopeId=${payload.archisignEnvelopeId} ` +
      `archidocProjectId=${JSON.stringify(payload.archidocProjectId)}`,
  );
  console.log(`[fire] enqueue + immediate dispatch via orchestrator`);
  const result = await enqueueWebhookDelivery({
    eventId,
    eventType: "work_authorised",
    payload,
  });
  console.log(
    `[result] enqueued=${result.enqueued} skipped=${result.skipped ?? "no"} ` +
      `deliveryId=${result.delivery.id} state=${result.delivery.state}`,
  );
  // Brief settle so the fire-and-forget attempt has time to land + persist.
  await sleep(2000);
  await printRowStatus(eventId);
}

async function runBreach(args: ParsedArgs): Promise<void> {
  if (!args.envelopeId) {
    printUsageAndExit("breach requires --envelope-id");
  }
  const eventId = args.eventId ?? uuidv7();
  const payload = buildRetentionBreachPayload({
    eventId,
    envelopeId: args.envelopeId,
  });
  banner(`breach eventId=${eventId} envelopeId=${args.envelopeId}`);
  console.log(`[fire] enqueue + immediate dispatch via orchestrator`);
  const result = await enqueueWebhookDelivery({
    eventId,
    eventType: "signed_pdf_retention_breach",
    payload,
  });
  console.log(
    `[result] enqueued=${result.enqueued} skipped=${result.skipped ?? "no"} ` +
      `deliveryId=${result.delivery.id} state=${result.delivery.state}`,
  );
  await sleep(2000);
  await printRowStatus(eventId);
}

async function runDedup(args: ParsedArgs): Promise<void> {
  if (!args.eventId) {
    printUsageAndExit("dedup requires --event-id (the eventId from a prior work-auth fire)");
  }
  const existing = await storage.getWebhookDeliveryOutByEventId(args.eventId);
  if (!existing) {
    console.error(
      `error: no local webhook_deliveries_out row for eventId=${args.eventId}. ` +
        `Run \`work-auth --event-id ${args.eventId}\` first, or use the eventId printed by an earlier fire.`,
    );
    process.exit(3);
  }
  banner(`dedup re-POST eventId=${args.eventId}`);
  console.log(
    `[context] local row id=${existing.id} state=${existing.state} ` +
      `attemptCount=${existing.attemptCount} eventType=${existing.eventType}`,
  );
  console.log(
    `[fire] direct wire-level POST (bypassing orchestrator) — Archidoc should ` +
      `respond 200 + {deduplicated:true} per §3.9 idempotency contract`,
  );
  const payload = existing.payload as { eventId: string; eventType: OutboundEventType } & Record<string, unknown>;
  const outcome = await postWorkAuthorisation({
    payload,
    targetUrl: existing.targetUrl,
  });
  if (outcome.ok) {
    console.log(
      `[result] OK httpStatus=${outcome.httpStatus} deduplicated=${outcome.deduplicated} ` +
        (outcome.deduplicated
          ? "✅ Archidoc acknowledged duplicate"
          : "⚠ Archidoc returned 200 but did NOT signal deduplication — investigate"),
    );
  } else {
    console.log(
      `[result] FAIL httpStatus=${outcome.httpStatus ?? "n/a"} retryable=${outcome.retryable} ` +
        `error=${outcome.error}`,
    );
  }
}

async function runStatus(args: ParsedArgs): Promise<void> {
  if (!args.eventId) {
    printUsageAndExit("status requires --event-id");
  }
  await printRowStatus(args.eventId);
}

async function printRowStatus(eventId: string): Promise<void> {
  const row = await storage.getWebhookDeliveryOutByEventId(eventId);
  if (!row) {
    console.log(`[status] no local row for eventId=${eventId}`);
    return;
  }
  console.log(
    [
      `[status] eventId       : ${row.eventId}`,
      `         eventType     : ${row.eventType}`,
      `         deliveryId    : ${row.id}`,
      `         state         : ${row.state}`,
      `         attemptCount  : ${row.attemptCount}`,
      `         lastAttemptAt : ${row.lastAttemptAt?.toISOString() ?? "(none)"}`,
      `         succeededAt   : ${row.succeededAt?.toISOString() ?? "(none)"}`,
      `         deadLetteredAt: ${row.deadLetteredAt?.toISOString() ?? "(none)"}`,
      `         lastError     : ${row.lastErrorBody ? truncate(row.lastErrorBody, 200) : "(none)"}`,
    ].join("\n"),
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n}]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  preflight();
  switch (args.command) {
    case "work-auth":
      await runWorkAuth(args);
      break;
    case "breach":
      await runBreach(args);
      break;
    case "dedup":
      await runDedup(args);
      break;
    case "status":
      await runStatus(args);
      break;
    default:
      printUsageAndExit(`Unknown command: ${args.command}`);
  }
}

main().then(
  () => {
    // Allow async DB connections / fire-and-forget attempts to settle
    // before we tear the process down.
    setTimeout(() => process.exit(0), 500);
  },
  (err) => {
    console.error(`[fatal] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  },
);
