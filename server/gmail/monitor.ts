// Per-user inbox polling — see migration 0030_user_gmail_polling.sql for full
// background. Previously this iterated a single `getUncachableGmailClient()`
// backed by the Replit `google-mail` connector, which only has
// gmail.send + addon scopes (no users.messages.list). Now we iterate every
// architect with a stored Google refresh token (granted via /api/auth/link-gmail)
// and poll each inbox individually using server/gmail/user-client.ts.
//
// Backward-compat: the E2E fake-gmail path (E2E_FAKE_GMAIL=true) still routes
// through the old single-client `getUncachableGmailClient()` so dev/test keeps
// working without needing a real Google login. In that mode we do one polling
// pass per tick (no user iteration) and label everything as user "0".

import { getUncachableGmailClient, isGmailConfigured, isFakeGmailMode } from "./client";
import { getGmailClientForUser } from "./user-client";
import { uploadDocument, isObjectStorageConfigured } from "../storage/object-storage";
import { getEmailIntakeCutoff } from "../services/email-intake-cutoff";
import {
  evaluateEmailPrefilter,
  buildTargetedGmailQueries,
  tierToExtractionStatus,
  type PrefilterContext,
} from "./email-prefilter";
import { scanCertificatReplies } from "../services/certificat-payment-suggestions.service";
import { storage } from "../storage";
import type { gmail_v1 } from "googleapis";
import type { InsertEmailDocument, User } from "@shared/schema";

const LABEL_NAME = "ArchiTrak-Extracted";
// Per-user label-id cache. Cleared on stopPolling() so re-link works cleanly.
const labelIdByUserId = new Map<number, string>();
let isPolling = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastPollTime: Date | null = null;
let lastPollStatus: string = "idle";
let lastPollError: string | null = null;
let lastLinkedUserCount = 0;

export interface GmailMonitorStatus {
  configured: boolean;
  enabled: boolean;
  /** alias of `enabled`, kept for older API consumers */
  polling: boolean;
  running: boolean;
  lastPollTime: string | null;
  lastPollStatus: string;
  lastPollError: string | null;
  intervalMs: number;
  /** Count of users who have linked their inbox via /api/auth/link-gmail. */
  linkedUserCount: number;
}

export function getGmailMonitorStatus(): GmailMonitorStatus {
  return {
    // We no longer depend on the Replit gmail connector for polling — so
    // "configured" now just means object storage is wired up (we need it to
    // store extracted PDFs). Whether anyone has actually linked their inbox
    // is reported separately via linkedUserCount.
    configured: isObjectStorageConfigured(),
    enabled: pollInterval !== null,
    polling: pollInterval !== null,
    running: isPolling,
    lastPollTime: lastPollTime?.toISOString() ?? null,
    lastPollStatus,
    lastPollError,
    intervalMs: 15 * 60 * 1000,
    linkedUserCount: lastLinkedUserCount,
  };
}

export function startPolling(intervalMs: number = 15 * 60 * 1000) {
  if (!isObjectStorageConfigured()) {
    console.log("[Gmail Monitor] Object Storage not configured, skipping poll setup");
    return;
  }
  if (pollInterval) {
    console.log("[Gmail Monitor] Already polling");
    return;
  }

  console.log(`[Gmail Monitor] Starting polling every ${intervalMs / 1000}s`);
  pollInterval = setInterval(() => {
    pollInbox().catch(console.error);
  }, intervalMs);

  setTimeout(() => pollInbox().catch(console.error), 5000);
}

export function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  isPolling = false;
  labelIdByUserId.clear();
  prefilterCtxCache = null;
}

export async function pollInbox(): Promise<{ processed: number; errors: number }> {
  if (isPolling) {
    return { processed: 0, errors: 0 };
  }

  isPolling = true;
  lastPollTime = new Date();
  lastPollStatus = "running";
  lastPollError = null;
  let processed = 0;
  let errors = 0;

  try {
    // Fake-gmail dev/test path — single shared stub client, no user iteration.
    if (isFakeGmailMode()) {
      const fake = await getUncachableGmailClient();
      const r = await pollOneInbox(fake, /*userId*/ 0);
      processed += r.processed;
      errors += r.errors;
      // Task #466 — keep the payment-reply scan on the fake path too so the
      // code path stays exercised in dev (fake threads.get returns empty).
      const scan = await scanCertificatReplies(fake).catch((err) => {
        console.error("[Gmail Monitor] Payment-reply scan failed (fake mode):", err);
        return { scannedThreads: 0, suggestionsCreated: 0, ambiguousCreated: 0, errors: 1 };
      });
      errors += scan.errors;
      lastPollStatus = "completed";
      lastLinkedUserCount = 0;
      return { processed, errors };
    }

    if (!isGmailConfigured()) {
      // Object storage IS configured (checked in startPolling), but the
      // Replit connector envs aren't — that's fine for the per-user path
      // (we don't need the connector at all). We just can't fall back to the
      // legacy single-client mode either, which is also fine.
    }

    const users = await storage.listGmailPollingUsers();
    lastLinkedUserCount = users.length;

    if (users.length === 0) {
      lastPollStatus = "no_linked_users";
      lastPollError = "No architect has linked their Gmail inbox yet. Go to the dashboard and click 'Link my inbox' to start receiving devis emails automatically.";
      console.log("[Gmail Monitor] No users with linked inboxes — nothing to poll");
      // Task #466 — even with no linked users, still attempt the connector
      // scan pass so connector-only deployments get payment-reply coverage.
      errors += await scanConnectorSentThreads();
      return { processed: 0, errors };
    }

    console.log(`[Gmail Monitor] Polling ${users.length} linked inbox(es)`);

    for (const user of users) {
      const startedAt = new Date();
      try {
        const gmail = await getGmailClientForUser(user);
        const r = await pollOneInbox(gmail, user.id);
        processed += r.processed;
        errors += r.errors;
        // Task #466 — after the PDF-intake pass, scan sent-certificat threads
        // for client "paid" replies (needs the same read-scoped user client).
        // Scan errors count toward this user's poll status so failures are
        // visible on the dashboard, never silently swallowed.
        let scanErrors = 0;
        let scanErrorMsg: string | null = null;
        try {
          const scan = await scanCertificatReplies(gmail, user.id);
          if (scan.suggestionsCreated || scan.ambiguousCreated || scan.errors) {
            console.log(
              `[Gmail Monitor] Payment-reply scan (user ${user.id}): ${scan.scannedThreads} threads, ${scan.suggestionsCreated} suggestions, ${scan.ambiguousCreated} ambiguous, ${scan.errors} errors`,
            );
          }
          scanErrors = scan.errors;
          if (scan.errors > 0) scanErrorMsg = `Payment-reply scan: ${scan.errors} thread(s) failed (see server logs)`;
        } catch (scanErr: any) {
          scanErrors = 1;
          scanErrorMsg = `Payment-reply scan failed: ${(scanErr?.message || "unknown error").slice(0, 300)}`;
          console.error(`[Gmail Monitor] Payment-reply scan failed for user ${user.id}:`, scanErr);
        }
        errors += scanErrors;
        await storage.updateUserGmailPollStatus(user.id, {
          gmailLastPollAt: startedAt,
          gmailLastPollStatus: r.errors + scanErrors === 0 ? "completed" : "completed_with_errors",
          gmailLastPollError: scanErrorMsg,
        });
      } catch (err: any) {
        errors++;
        const msg = err?.message || "Unknown error";
        console.error(`[Gmail Monitor] Poll failed for user ${user.id} (${user.email}):`, err);
        // 401 / invalid_grant means the user revoked access in their Google
        // account settings. Mark the row so the dashboard surfaces a re-link
        // CTA, but keep the refresh_token for now (operator can clear it).
        const isAuthFailure = err?.status === 401 || err?.code === 401 ||
          /invalid_grant|invalid_token/i.test(msg);
        await storage.updateUserGmailPollStatus(user.id, {
          gmailLastPollAt: startedAt,
          gmailLastPollStatus: isAuthFailure ? "auth_revoked" : "error",
          gmailLastPollError: msg.slice(0, 500),
        });
      }
    }

    // Task #466 — connector scan pass for legacy/fallback sends
    // (sent_via_user_id IS NULL): those threads live in the shared
    // connector mailbox, which per-user scans can only reach when the
    // architect linked the SAME account. Attempt a direct read here; the
    // Replit connector historically has send-only scopes, so a 403 is
    // expected and logged loudly (per-user probes remain the fallback).
    errors += await scanConnectorSentThreads();

    lastPollStatus = errors === 0 ? "completed" : "completed_with_errors";
    console.log(`[Gmail Monitor] Poll complete: ${processed} processed, ${errors} errors across ${users.length} inbox(es)`);
  } catch (err: any) {
    lastPollStatus = "error";
    lastPollError = err.message || "Unknown error";
    console.error("[Gmail Monitor] Poll failed:", err);
  } finally {
    isPolling = false;
  }

  return { processed, errors };
}

// Task #466 — scan legacy/fallback connector-sent certificat threads
// (sent_via_user_id IS NULL) with the shared connector client itself.
// Returns the error count to fold into the poll totals. A 403 scope denial
// (the Replit connector historically lacks any read scope) aborts the pass
// with ONE loud log line — never silently.
let connectorScopeDeniedLogged = false;
async function scanConnectorSentThreads(): Promise<number> {
  if (!isGmailConfigured()) return 0;
  try {
    const unowned = await storage.getCertificatCommunicationsAwaitingPayment("unowned");
    if (unowned.length === 0) return 0;
    const connector = await getUncachableGmailClient();
    const scan = await scanCertificatReplies(connector, "unowned");
    if (scan.scopeDenied) {
      if (!connectorScopeDeniedLogged) {
        connectorScopeDeniedLogged = true;
        console.error(
          "[Gmail Monitor] Connector mailbox refuses thread reads (403, send-only scopes): replies to connector-sent certificats can only be detected if an architect links the SAME Gmail account. Link the sending inbox on the dashboard.",
        );
      }
      return scan.errors;
    }
    if (scan.suggestionsCreated || scan.ambiguousCreated || scan.errors) {
      console.log(
        `[Gmail Monitor] Payment-reply scan (connector): ${scan.scannedThreads} threads, ${scan.suggestionsCreated} suggestions, ${scan.ambiguousCreated} ambiguous, ${scan.errors} errors`,
      );
    }
    return scan.errors;
  } catch (err) {
    console.error("[Gmail Monitor] Connector payment-reply scan failed:", err);
    return 1;
  }
}

// Per-poll work budget and paging bounds. The persistent processed-message
// exclusion alone is not enough: with `maxResults` capped, the FIRST page of
// each query can consist entirely of already-handled ids (e.g. when label
// filtering is a no-op for lack of permission), so the poll must PAGE PAST
// locally-processed messages until it finds real work or exhausts the bound.
const POLL_UNPROCESSED_TARGET = 10;
const POLL_PAGE_SIZE = 10;
const POLL_MAX_PAGES_PER_QUERY = 10;
// Slots always reserved for the broad backstop and the backfill query, so a
// sustained flood of high-evidence mail can never permanently starve
// unknown-sender/keyword-only PDFs (backstop) or old backlog (backfill).
// Both are issued unconditionally on every poll when applicable.
const POLL_BROAD_RESERVE = 3;
const POLL_BACKFILL_RESERVE = 3;
// Page cap for the boundary-bucket backfill query only: its result set is
// bounded to a single second of mail, so a generous cap (300 messages)
// guarantees the bucket is drained rather than restarting behind its own
// processed prefix each poll.
const POLL_BUCKET_MAX_PAGES = 30;

export interface PollQuerySet {
  /** Targeted live-client queries (may be empty). */
  targeted: string[];
  /** Broad completeness/audit backstop — always issued. */
  backstop: string;
  /**
   * Deep backfill query (`backstop + before:<cursor second, exclusive>`).
   * Gmail search is second-granular while internalDate is ms-granular, so
   * everything this lists is in a strictly OLDER second than the oldest
   * processed message — its first page is guaranteed fresh work, no matter
   * how deep the processed prefix grew. Bounded paging cannot starve it.
   */
  backfill?: string | null;
  /**
   * Boundary-bucket query bracketing the cursor's own second
   * (`after:<cursor-1> before:<cursor+1>`). The deep query excludes that
   * second entirely, so this query — whose result set is bounded to one
   * second of mail — is paged until EXHAUSTED (higher page cap) to drain
   * any partially-processed bucket pinning the cursor.
   */
  backfillBucket?: string | null;
}

/**
 * Walk each Gmail query's result pages, excluding message ids already
 * durably processed (gmail_processed_messages) and deduplicating across
 * queries, until the unprocessed-work target is met or pages run out.
 * Exported for tests.
 */
export async function collectUnprocessedMessageIds(
  gmail: gmail_v1.Gmail,
  userId: number,
  querySet: PollQuerySet,
): Promise<{ unprocessed: string[]; alreadyHandled: number; listErrors: number }> {
  const seen = new Set<string>();
  const unprocessed: string[] = [];
  let alreadyHandled = 0;
  let listErrors = 0;

  const hasBackfill = !!querySet.backfill;
  const backfillReserve = hasBackfill ? POLL_BACKFILL_RESERVE : 0;
  const targetedCap = Math.max(1, POLL_UNPROCESSED_TARGET - POLL_BROAD_RESERVE - backfillReserve);
  const broadCap = Math.max(targetedCap + 1, POLL_UNPROCESSED_TARGET - backfillReserve);

  const runQuery = async (q: string, cap: number, maxPages = POLL_MAX_PAGES_PER_QUERY): Promise<void> => {
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages && unprocessed.length < cap; page++) {
      let response;
      try {
        response = await gmail.users.messages.list({
          userId: "me",
          q,
          maxResults: POLL_PAGE_SIZE,
          ...(pageToken ? { pageToken } : {}),
        });
      } catch (err) {
        listErrors++;
        console.error(`[Gmail Monitor] User ${userId}: message list failed for query "${q.slice(0, 120)}…" (page ${page + 1}):`, err);
        return;
      }
      const pageIds: string[] = [];
      for (const msg of response.data.messages || []) {
        if (msg.id && !seen.has(msg.id)) {
          seen.add(msg.id);
          pageIds.push(msg.id);
        }
      }
      if (pageIds.length > 0) {
        const fresh = await storage.filterUnprocessedGmailMessageIds(userId, pageIds);
        alreadyHandled += pageIds.length - fresh.length;
        unprocessed.push(...fresh);
      }
      pageToken = response.data.nextPageToken ?? undefined;
      if (!pageToken) return;
    }
  };

  // Overshoot trim between phases: trimmed ids are not recorded as
  // processed, so they are re-found and handled on the next poll.
  for (const q of querySet.targeted) {
    if (unprocessed.length >= targetedCap) break;
    await runQuery(q, targetedCap);
  }
  if (unprocessed.length > targetedCap) unprocessed.length = targetedCap;

  // The broad backstop ALWAYS runs so low-evidence mail keeps flowing into
  // the parked buckets even when high-evidence mail floods the budget.
  await runQuery(querySet.backstop, broadCap);
  if (unprocessed.length > broadCap) unprocessed.length = broadCap;

  // Boundary bucket first: one second of mail, paged until exhausted (its
  // processed prefix is bounded by that second's volume, so a higher page
  // cap guarantees progress even if 100+ processed messages share the
  // cursor second).
  if (querySet.backfillBucket) {
    await runQuery(querySet.backfillBucket, POLL_UNPROCESSED_TARGET, POLL_BUCKET_MAX_PAGES);
  }
  // Deep backfill ALWAYS runs (when a cursor exists): it lists only seconds
  // strictly older than every processed message, so page one is fresh work
  // no matter how deep the processed prefix grew.
  if (querySet.backfill) {
    await runQuery(querySet.backfill, POLL_UNPROCESSED_TARGET);
  }

  return { unprocessed: unprocessed.slice(0, POLL_UNPROCESSED_TARGET), alreadyHandled, listErrors };
}

/**
 * Scan one user's inbox for unprocessed PDF attachments. Extracted from the
 * old monolithic pollInbox so it can run once per linked user. Returns
 * processed/error counts for that single inbox.
 */
async function pollOneInbox(
  gmail: gmail_v1.Gmail,
  userId: number,
): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;

  const baseQuery = `has:attachment filename:pdf -label:${LABEL_NAME}`;

  // Task #503 — targeted live-client batches run FIRST (known sender
  // addresses + live project/client names) so high-confidence mail is
  // captured with priority; the broad query stays as the completeness/audit
  // backstop. Message ids are deduplicated across batches.
  const ctx = await getPrefilterContext();
  // Durable backfill cursor: oldest internalDate ever processed. `before:`
  // is date-exclusive, so +1s keeps same-second messages listable (the
  // processed-id filter dedupes any overlap). Clamped to the intake
  // watermark: mail older than the cutoff is never captured, so once the
  // cursor reaches it the backlog is fully drained and backfill stops.
  // Pre-watermark processed rows are excluded from the cursor minimum so
  // they can never collapse the cursor below the cutoff and starve valid
  // post-cutoff backlog.
  const cursor = await storage.getGmailBackfillCursor(userId, getEmailIntakeCutoff());
  const cutoffSec = Math.floor(getEmailIntakeCutoff().getTime() / 1000);
  const cursorSec = cursor ? Math.floor(cursor.getTime() / 1000) : null;
  const hasBackfill = cursorSec !== null && cursorSec > cutoffSec;
  // Deep query: strictly older SECONDS than the cursor — page one is
  // prefix-free because nothing older than the minimum was processed.
  const backfill = hasBackfill
    ? `${baseQuery} before:${cursorSec} after:${cutoffSec}`
    : null;
  // Bucket query: brackets the cursor's own second, paged until exhausted,
  // so 100+ processed messages sharing that second can't pin the cursor.
  const backfillBucket = hasBackfill
    ? `${baseQuery} after:${cursorSec! - 1} before:${cursorSec! + 1}`
    : null;

  const { unprocessed: messageIds, alreadyHandled, listErrors } =
    await collectUnprocessedMessageIds(gmail, userId, {
      targeted: buildTargetedGmailQueries(
        { contractors: ctx.contractors, projects: ctx.projects, knownEmails: ctx.knownEmails },
        baseQuery,
      ),
      backstop: baseQuery,
      backfill,
      backfillBucket,
    });
  errors += listErrors;

  const canModify = await ensureLabelSafe(gmail, userId);

  if (messageIds.length > 0) {
    console.log(`[Gmail Monitor] User ${userId}: found ${messageIds.length} unprocessed emails with PDFs (${alreadyHandled} already handled)`);
  }

  for (const id of messageIds) {
    try {
      const messageDate = await processMessage(gmail, id, canModify, userId);
      // Disposition is durable (docs stored / message labeled or skipped) —
      // record it (with the message date, feeding the backfill cursor) so a
      // label failure can never wedge the poll on this id.
      await storage.recordGmailMessageProcessed(userId, id, messageDate);
      processed++;
    } catch (err) {
      errors++;
      console.error(`[Gmail Monitor] User ${userId}: error processing message ${id}:`, err);
    }
  }

  return { processed, errors };
}

// Task #323 — capture-time pre-filter context (contractors, projects, linked
// inboxes), cached briefly so one poll pass doesn't reload it per message.
let prefilterCtxCache: { ctx: PrefilterContext; fetchedAt: number } | null = null;
const PREFILTER_CTX_TTL_MS = 60_000;

async function getPrefilterContext(): Promise<PrefilterContext> {
  const now = Date.now();
  if (prefilterCtxCache && now - prefilterCtxCache.fetchedAt < PREFILTER_CTX_TTL_MS) {
    return prefilterCtxCache.ctx;
  }
  const [contractors, allProjects, linkedUsers] = await Promise.all([
    storage.getContractors(),
    storage.getProjects({ includeArchived: true }),
    storage.listGmailPollingUsers().catch(() => []),
  ]);
  // Task #503 — live vs archived split: only LIVE projects grant high-tier
  // relevance; archived ones quarantine as 'archived_project_candidate'.
  const projects = allProjects.filter((p) => p.archivedAt == null);
  const archivedProjects = allProjects.filter((p) => p.archivedAt != null);
  // Task #425/#503 — firm identity is a capture-time signal too, so the
  // firm's own fee invoices are never demoted to low relevance at capture.
  let firm: PrefilterContext["firm"];
  try {
    const { getFirmProfile, getFirmEmailDomains } = await import(
      "../services/architect-fee-invoice.service"
    );
    firm = { legalNames: getFirmProfile().legalNames, domains: getFirmEmailDomains() };
  } catch (err) {
    console.error("[Gmail Monitor] Firm profile unavailable for prefilter context:", err);
  }
  const ctx: PrefilterContext = {
    contractors,
    projects,
    archivedProjects,
    knownEmails: linkedUsers.map((u) => u.email),
    firm,
  };
  prefilterCtxCache = { ctx, fetchedAt: now };
  return ctx;
}

async function ensureLabelSafe(gmail: gmail_v1.Gmail, userId: number): Promise<boolean> {
  if (labelIdByUserId.has(userId)) return true;

  try {
    const labelsRes = await gmail.users.labels.list({ userId: "me" });
    const existing = labelsRes.data.labels?.find((l) => l.name === LABEL_NAME);
    if (existing && existing.id) {
      labelIdByUserId.set(userId, existing.id);
      return true;
    }

    const createRes = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: LABEL_NAME,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    if (createRes.data.id) {
      labelIdByUserId.set(userId, createRes.data.id);
      console.log(`[Gmail Monitor] User ${userId}: created label ${LABEL_NAME}`);
      return true;
    }
    return false;
  } catch (err: any) {
    if (err?.status === 403 || err?.code === 403) {
      console.warn(`[Gmail Monitor] User ${userId}: cannot create/manage labels — insufficient permissions. Skipping label operations.`);
      return false;
    }
    console.error(`[Gmail Monitor] User ${userId}: failed to create label:`, err);
    return false;
  }
}

async function applyLabel(gmail: gmail_v1.Gmail, messageId: string, userId: number): Promise<void> {
  const lid = labelIdByUserId.get(userId);
  if (!lid) return;
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { addLabelIds: [lid] },
    });
  } catch (err) {
    console.error(`[Gmail Monitor] User ${userId}: failed to apply label to ${messageId}:`, err);
  }
}

/**
 * Returns the message's authoritative date (internalDate, falling back to
 * the parsed header date) so the caller can persist it with the
 * processed-message record — it feeds the durable backfill cursor.
 */
async function processMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
  canModify: boolean,
  userId: number,
): Promise<Date | null> {
  const msgDetail = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = msgDetail.data.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value || "";

  const from = getHeader("From");
  const subject = getHeader("Subject");
  const dateStr = getHeader("Date");
  const threadId = msgDetail.data.threadId || "";
  // Task #322 — prefer Gmail's authoritative internalDate (server-side
  // arrival time, epoch ms) over the forgeable/malformed RFC Date header;
  // fall back to the header, then to "now".
  const internalMs = Number(msgDetail.data.internalDate);
  const headerDate = dateStr ? new Date(dateStr) : null;
  const emailReceivedAt =
    Number.isFinite(internalMs) && internalMs > 0
      ? new Date(internalMs)
      : headerDate && !Number.isNaN(headerDate.getTime())
        ? headerDate
        : new Date();
  const emailLink = `https://mail.google.com/mail/u/0/#inbox/${messageId}`;

  // Task #322 — intake watermark. Emails received before the beta-reset
  // cutoff are never captured, even if Gmail's search surfaces them again
  // (e.g. label loss, re-link, restart). Label the message so it stops
  // matching the unprocessed query, but store nothing.
  if (emailReceivedAt < getEmailIntakeCutoff()) {
    console.log(`[Gmail Monitor] User ${userId}: skipping pre-watermark email ${messageId} (received ${emailReceivedAt.toISOString()})`);
    if (canModify) await applyLabel(gmail, messageId, userId);
    return emailReceivedAt;
  }

  const parts = flattenParts(msgDetail.data.payload);
  const pdfParts = parts.filter(
    (p) =>
      p.filename &&
      p.filename.toLowerCase().endsWith(".pdf") &&
      p.body?.attachmentId,
  );

  if (pdfParts.length === 0) {
    if (canModify) await applyLabel(gmail, messageId, userId);
    return emailReceivedAt;
  }

  for (const part of pdfParts) {
    const attachmentId = part.body!.attachmentId!;
    const fileName = part.filename || "document.pdf";

    const existing = await storage.getEmailDocumentByMessageId(`${messageId}_${fileName}`);
    if (existing) continue;

    const attachRes = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });

    const data = attachRes.data.data;
    // Task #503 — a declared PDF part with no payload must FAIL the message,
    // not skip silently: the caller only records a message as durably
    // processed on success, so throwing here guarantees this message is
    // re-fetched and retried on the next poll instead of being suppressed
    // forever with the PDF never captured.
    if (!data) {
      throw new Error(`Attachment payload missing for declared PDF part "${fileName}" (message ${messageId})`);
    }

    const buffer = Buffer.from(data, "base64url");

    const storageKey = await uploadDocument(null, fileName, buffer, "application/pdf");

    // Task #323/#503 — cheap deterministic pre-filter at capture time, now
    // evidence-TIERED: only high-tier docs are stored 'pending' (AI runs);
    // generic-keyword-only mail parks as 'low_relevance', archived-project
    // matches as 'archived_project_candidate', no-signal mail as
    // 'unmatched_sender'. The background sweeper only drains 'pending', so
    // none of the parked tiers ever spends AI tokens. All stay visible +
    // rescuable in the email queue, with the reason persisted in notes.
    const prefilter = evaluateEmailPrefilter(
      { emailFrom: from, emailSubject: subject, attachmentFileName: fileName },
      await getPrefilterContext(),
    );
    const captureStatus = tierToExtractionStatus(prefilter.tier);
    if (!prefilter.pass) {
      console.log(`[Gmail Monitor] User ${userId}: parking ${messageId}/${fileName} as ${captureStatus} (no AI call): ${prefilter.reason}`);
    }

    const doc: InsertEmailDocument = {
      emailMessageId: `${messageId}_${fileName}`,
      emailThreadId: threadId,
      emailFrom: from,
      emailSubject: subject,
      emailReceivedAt,
      emailLink,
      attachmentFileName: fileName,
      storageKey,
      documentType: "unknown",
      extractionStatus: captureStatus,
      ...(prefilter.pass ? {} : { notes: prefilter.reason }),
      gmailLabelApplied: canModify,
    };

    await storage.createEmailDocument(doc);
  }

  if (canModify) {
    await applyLabel(gmail, messageId, userId);
    try {
      await storage.updateEmailDocumentLabelStatus(messageId);
    } catch (_) {}
  }

  return emailReceivedAt;
}

interface MessagePart {
  filename?: string | null;
  body?: { attachmentId?: string | null } | null;
  parts?: MessagePart[] | null;
}

function flattenParts(payload: MessagePart | null | undefined): MessagePart[] {
  const result: MessagePart[] = [];
  if (!payload) return result;

  if (payload.filename && payload.body?.attachmentId) {
    result.push(payload);
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      result.push(...flattenParts(p));
    }
  }
  return result;
}

// Reference unused User import to keep the type available for callers that
// may want to iterate via getGmailMonitorStatus + listGmailPollingUsers.
export type { User };
