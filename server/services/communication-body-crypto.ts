import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { projectCommunications } from "@shared/schema";
import { db } from "../db";
import { env } from "../env";

const KEY_CONTEXT = "architrak:quotation-email-body:v1";
const CLIENT_LINK_RE = /https?:\/\/[^\s]+\/p\/client\/[A-Za-z0-9_-]+/;
export const PROTECTED_CLIENT_LINK_LABEL = "[Lien sécurisé protégé]";

function deriveKey(): Buffer {
  return createHash("sha256").update(`${KEY_CONTEXT}\0${env.SESSION_SECRET}`).digest();
}

export function encryptCommunicationBody(body: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptCommunicationBody(blob: string): string | null {
  const parts = blob.split(".");
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], "base64url");
    const tag = Buffer.from(parts[1], "base64url");
    const ciphertext = Buffer.from(parts[2], "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function redactClientLink(body: string): string {
  return body.replace(CLIENT_LINK_RE, PROTECTED_CLIENT_LINK_LABEL);
}

export function extractClientPortalUrl(body: string): string | null {
  return body.match(CLIENT_LINK_RE)?.[0] ?? null;
}

/**
 * Seals legacy rows after the schema migration and before HTTP routes/workers
 * start. The update is atomic per row: no retry can observe ciphertext without
 * the matching redaction, or vice versa.
 */
export async function protectLegacyClientLinkCommunications(): Promise<number> {
  const legacy = await db
    .select({ id: projectCommunications.id, body: projectCommunications.body })
    .from(projectCommunications)
    .where(and(
      eq(projectCommunications.type, "devis_client_link"),
      isNull(projectCommunications.encryptedBody),
    ));

  let protectedCount = 0;
  for (const row of legacy) {
    const originalBody = row.body ?? "";
    const encryptedBody = encryptCommunicationBody(originalBody);
    const redactedBody = redactClientLink(originalBody);
    const updated = await db
      .update(projectCommunications)
      .set({ body: redactedBody, encryptedBody })
      .where(and(
        eq(projectCommunications.id, row.id),
        isNull(projectCommunications.encryptedBody),
        row.body === null
          ? isNull(projectCommunications.body)
          : eq(projectCommunications.body, row.body),
      ))
      .returning({ id: projectCommunications.id });
    protectedCount += updated.length;
  }
  return protectedCount;
}