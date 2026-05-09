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
      return { processed: 0, errors: 0 };
    }

    console.log(`[Gmail Monitor] Polling ${users.length} linked inbox(es)`);

    for (const user of users) {
      const startedAt = new Date();
      try {
        const gmail = await getGmailClientForUser(user);
        const r = await pollOneInbox(gmail, user.id);
        processed += r.processed;
        errors += r.errors;
        await storage.updateUserGmailPollStatus(user.id, {
          gmailLastPollAt: startedAt,
          gmailLastPollStatus: r.errors === 0 ? "completed" : "completed_with_errors",
          gmailLastPollError: null,
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

  const query = `has:attachment filename:pdf -label:${LABEL_NAME}`;
  const response = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 10,
  });

  const canModify = await ensureLabelSafe(gmail, userId);

  const messages = response.data.messages || [];
  if (messages.length > 0) {
    console.log(`[Gmail Monitor] User ${userId}: found ${messages.length} unprocessed emails with PDFs`);
  }

  for (const msg of messages) {
    try {
      await processMessage(gmail, msg.id!, canModify, userId);
      processed++;
    } catch (err) {
      errors++;
      console.error(`[Gmail Monitor] User ${userId}: error processing message ${msg.id}:`, err);
    }
  }

  return { processed, errors };
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

async function processMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
  canModify: boolean,
  userId: number,
): Promise<void> {
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
  const emailReceivedAt = dateStr ? new Date(dateStr) : new Date();
  const emailLink = `https://mail.google.com/mail/u/0/#inbox/${messageId}`;

  const parts = flattenParts(msgDetail.data.payload);
  const pdfParts = parts.filter(
    (p) =>
      p.filename &&
      p.filename.toLowerCase().endsWith(".pdf") &&
      p.body?.attachmentId,
  );

  if (pdfParts.length === 0) {
    if (canModify) await applyLabel(gmail, messageId, userId);
    return;
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
    if (!data) continue;

    const buffer = Buffer.from(data, "base64url");

    const storageKey = await uploadDocument(null, fileName, buffer, "application/pdf");

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
      extractionStatus: "pending",
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
