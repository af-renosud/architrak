import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { env } from "../env";

/**
 * Task #407 — encrypt-at-rest plumbing for the project client share URL.
 *
 * Design: the public lookup path stays hash-only (SHA-256 of the raw
 * token). But the architect needs to re-copy the link after issue, so we
 * additionally persist the full share URL encrypted with AES-256-GCM
 * under a key derived from SESSION_SECRET. A DB dump alone therefore
 * still yields no usable links; decryption happens only inside the
 * authenticated copy endpoint.
 *
 * Wire format: base64url(iv) + "." + base64url(authTag) + "." + base64url(ciphertext)
 */

const KEY_CONTEXT = "architrak:client-project-share-url:v1";

function deriveKey(): Buffer {
  // SESSION_SECRET is validated non-empty at boot (env.ts). Domain-separate
  // from any other SESSION_SECRET-derived material via a fixed context.
  return createHash("sha256").update(`${KEY_CONTEXT}\0${env.SESSION_SECRET}`).digest();
}

export function encryptShareUrl(plainUrl: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainUrl, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

/**
 * Returns the plaintext URL, or null when the blob is malformed or fails
 * authentication (e.g. SESSION_SECRET changed since issue). Callers treat
 * null as "copy unavailable — rotate to enable", never as an error page.
 */
export function decryptShareUrl(blob: string): string | null {
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
