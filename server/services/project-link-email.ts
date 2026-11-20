import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { clientProjectShareTokens, projectCommunications } from "../../shared/schema";
import { decryptShareUrl, isTokenExpired } from "./client-project-share";
import { encryptCommunicationBody, PROTECTED_CLIENT_LINK_LABEL } from "./communication-body-crypto";
import { isValidRecipientEmail, sendCommunication, CommunicationDeliveryAwaitingConfirmationError, CommunicationSendInProgressError } from "../communications/email-sender";

export const projectLinkEmailPrefix = (projectId: number) => `project-client-link:${projectId}:`;
export function buildProjectLinkEmail(projectName: string, name: string | null, message: string, url: string) {
  return {
    subject: `Your project — ${projectName.replace(/[\r\n]+/g, " ")}`,
    body: `${name ? `Hello ${name},` : "Hello,"}\n\n${message.trim()}\n\nView your project here:\n${url}\n\nKind regards,\nThe Renosud team`,
  };
}

export async function emailProjectLink(projectId: number, userId: number, input: {tokenId: number; requestId: string; message: string}) {
  const project = await storage.getProject(projectId);
  if (!project || project.archivedAt) throw new Error("Project unavailable or archived.");
  const communication = await db.transaction(async tx => {
    // Serialise queue creation for this link, including duplicate browser requests.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tokenId}::bigint)`);
    const [token] = await tx.select().from(clientProjectShareTokens)
      .where(and(eq(clientProjectShareTokens.id, input.tokenId), eq(clientProjectShareTokens.projectId, projectId))).for("update");
    if (!token || token.revokedAt || isTokenExpired(token)) throw new Error("The client link has changed or expired. Reopen Manage client link.");
    if (!isValidRecipientEmail(token.clientEmail)) throw new Error("The client link has an invalid recipient.");
    const url = token.encryptedShareUrl && decryptShareUrl(token.encryptedShareUrl);
    if (!url) throw new Error("This link cannot be recovered. Rotate the link before emailing it.");
    const prefix = `${projectLinkEmailPrefix(projectId)}${token.id}:`;
    const key = prefix + input.requestId;
    const [existing] = await tx.select().from(projectCommunications).where(eq(projectCommunications.dedupeKey, key));
    if (existing) return existing;
    // A pending or failed attempt is retried unchanged, never replaced by a new message.
    const [pending] = await tx.select().from(projectCommunications).where(sql`${projectCommunications.dedupeKey} LIKE ${prefix + "%"} AND ${projectCommunications.status} IN ('queued','sending','failed')`).limit(1);
    if (pending) return pending;
    const email = buildProjectLinkEmail(project.name, token.clientName, input.message, url);
    email.body += `\n\nDelivery reference: AT-PL-${input.requestId}`;
    const [created] = await tx.insert(projectCommunications).values({
      projectId, type: "devis_client_link", recipientType: "client",
      recipientEmail: token.clientEmail, recipientName: token.clientName,
      subject: email.subject,
      body: email.body.split(url).join(PROTECTED_CLIENT_LINK_LABEL),
      encryptedBody: encryptCommunicationBody(email.body),
      dedupeKey: key, status: "queued",
    }).returning();
    return created;
  });
  if (communication.status !== "sent") {
    try { await sendCommunication(communication.id, {sentByUserId: userId}); }
    catch (error) {
      if (error instanceof CommunicationDeliveryAwaitingConfirmationError || error instanceof CommunicationSendInProgressError) {
        return { status: "sending", message: "Delivery confirmation is pending. Do not send another copy." };
      }
      // The durable communication retains the failure; do not expose provider errors or bearer URLs.
      return { status: "failed", message: "Email was not confirmed as sent. Retry the saved email from this panel." };
    }
  }
  const saved = await storage.getProjectCommunication(communication.id);
  return {status: saved?.status ?? "sending", sentAt: saved?.sentAt};
}
