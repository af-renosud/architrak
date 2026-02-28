import { getUncachableGmailClient, isGmailConfigured } from "./client";
import { uploadDocument, isObjectStorageConfigured } from "../storage/object-storage";
import { storage } from "../storage";
import type { InsertEmailDocument } from "@shared/schema";

const LABEL_NAME = "ArchiTrak-Extracted";
let labelId: string | null = null;
let isPolling = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastPollTime: Date | null = null;
let lastPollStatus: string = "idle";
let lastPollError: string | null = null;

export function getGmailMonitorStatus() {
  return {
    configured: isGmailConfigured() && isObjectStorageConfigured(),
    polling: isPolling,
    lastPollTime: lastPollTime?.toISOString() ?? null,
    lastPollStatus,
    lastPollError,
    intervalMs: 15 * 60 * 1000,
  };
}

export function startPolling(intervalMs: number = 15 * 60 * 1000) {
  if (!isGmailConfigured()) {
    console.log("[Gmail Monitor] Gmail not configured, skipping poll setup");
    return;
  }
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
    if (lastPollStatus === "insufficient_permissions") {
      return;
    }
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
    const gmail = await getUncachableGmailClient();

    let response;
    try {
      const query = `has:attachment filename:pdf -label:${LABEL_NAME}`;
      response = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 10,
      });
    } catch (listErr: any) {
      if (listErr?.status === 403 || listErr?.code === 403) {
        lastPollStatus = "insufficient_permissions";
        lastPollError = "Gmail connector does not have read permissions (gmail.readonly scope). Re-authorize with full Gmail access to enable inbox monitoring.";
        console.warn("[Gmail Monitor] " + lastPollError);
        isPolling = false;
        return { processed: 0, errors: 0 };
      }
      throw listErr;
    }

    await ensureLabel(gmail);

    const messages = response.data.messages || [];
    console.log(`[Gmail Monitor] Found ${messages.length} unprocessed emails with PDFs`);

    for (const msg of messages) {
      try {
        await processMessage(gmail, msg.id!);
        processed++;
      } catch (err) {
        errors++;
        console.error(`[Gmail Monitor] Error processing message ${msg.id}:`, err);
      }
    }

    lastPollStatus = "completed";
    console.log(`[Gmail Monitor] Poll complete: ${processed} processed, ${errors} errors`);
  } catch (err: any) {
    lastPollStatus = "error";
    lastPollError = err.message || "Unknown error";
    console.error("[Gmail Monitor] Poll failed:", err);
  } finally {
    isPolling = false;
  }

  return { processed, errors };
}

async function ensureLabel(gmail: any): Promise<void> {
  if (labelId) return;

  try {
    const labelsRes = await gmail.users.labels.list({ userId: "me" });
    const existing = labelsRes.data.labels?.find((l: any) => l.name === LABEL_NAME);
    if (existing) {
      labelId = existing.id;
      return;
    }

    const createRes = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: LABEL_NAME,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    labelId = createRes.data.id;
    console.log(`[Gmail Monitor] Created label: ${LABEL_NAME}`);
  } catch (err) {
    console.error("[Gmail Monitor] Failed to create label:", err);
  }
}

async function applyLabel(gmail: any, messageId: string): Promise<void> {
  if (!labelId) return;
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { addLabelIds: [labelId] },
    });
  } catch (err) {
    console.error(`[Gmail Monitor] Failed to apply label to ${messageId}:`, err);
  }
}

async function processMessage(gmail: any, messageId: string): Promise<void> {
  const msgDetail = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = msgDetail.data.payload?.headers || [];
  const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

  const from = getHeader("From");
  const subject = getHeader("Subject");
  const dateStr = getHeader("Date");
  const threadId = msgDetail.data.threadId || "";
  const emailReceivedAt = dateStr ? new Date(dateStr) : new Date();
  const emailLink = `https://mail.google.com/mail/u/0/#inbox/${messageId}`;

  const parts = flattenParts(msgDetail.data.payload);
  const pdfParts = parts.filter(
    (p: any) =>
      p.filename &&
      p.filename.toLowerCase().endsWith(".pdf") &&
      p.body?.attachmentId
  );

  if (pdfParts.length === 0) {
    await applyLabel(gmail, messageId);
    return;
  }

  for (const part of pdfParts) {
    const attachmentId = part.body.attachmentId;
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
      gmailLabelApplied: false,
    };

    await storage.createEmailDocument(doc);
  }

  await applyLabel(gmail, messageId);

  try {
    await storage.updateEmailDocumentLabelStatus(messageId);
  } catch (_) {}
}

function flattenParts(payload: any): any[] {
  const result: any[] = [];
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
