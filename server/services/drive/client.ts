/**
 * Google Drive client wrapper for the auto-upload feature (Task #198).
 *
 * Authentication model: service account (JWT). The service account
 * email must be granted "Content manager" on the Renosud shared drive
 * identified by GOOGLE_DRIVE_SHARED_DRIVE_ID. We deliberately do NOT
 * reuse the per-user OAuth flow (server/auth/google-oauth.ts) — that
 * one only carries the gmail.readonly + gmail.modify scopes and was
 * granted by individual architects for inbox polling, not for shared
 * drive writes.
 *
 * The client is lazily instantiated and cached for the process. If
 * the env vars are missing or DRIVE_AUTO_UPLOAD_ENABLED is false,
 * `getDriveClient()` returns null and every wire-in call short-circuits.
 */

import { google, type drive_v3 } from "googleapis";
import { env } from "../../env";

let cachedClient: drive_v3.Drive | null = null;
let cachedClientError: string | null = null;

export interface DriveConfig {
  sharedDriveId: string;
  client: drive_v3.Drive;
}

export function isDriveAutoUploadEnabled(): boolean {
  return Boolean(
    env.DRIVE_AUTO_UPLOAD_ENABLED &&
      env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON &&
      env.GOOGLE_DRIVE_SHARED_DRIVE_ID,
  );
}

/**
 * Returns a configured Drive client + the shared drive id, or null if
 * the feature is disabled / not yet provisioned. Throws only on
 * malformed credentials JSON — that is a deploy-time misconfiguration
 * the operator must fix.
 */
export function getDriveConfig(): DriveConfig | null {
  if (!isDriveAutoUploadEnabled()) return null;
  if (cachedClient) {
    return { client: cachedClient, sharedDriveId: env.GOOGLE_DRIVE_SHARED_DRIVE_ID! };
  }
  if (cachedClientError) {
    throw new Error(cachedClientError);
  }

  let creds: { client_email?: string; private_key?: string };
  try {
    creds = JSON.parse(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON!);
  } catch (e) {
    cachedClientError =
      "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is set but is not valid JSON. Paste the full service-account key file contents.";
    throw new Error(cachedClientError);
  }
  if (!creds.client_email || !creds.private_key) {
    cachedClientError =
      "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON missing client_email or private_key — not a service-account key file.";
    throw new Error(cachedClientError);
  }

  // private_key from a .json key file may have literal "\n" sequences
  // when copy/pasted into a secret manager — un-escape them so the
  // JWT signer can parse the PEM block.
  const privateKey = creds.private_key.includes("\\n")
    ? creds.private_key.replace(/\\n/g, "\n")
    : creds.private_key;

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  cachedClient = google.drive({ version: "v3", auth });
  return { client: cachedClient, sharedDriveId: env.GOOGLE_DRIVE_SHARED_DRIVE_ID! };
}

/**
 * Test helper / boot diagnostic — verifies the service account can
 * actually see the shared drive. Called on demand from the admin
 * page; never on a hot path.
 */
export async function pingDrive(): Promise<{ ok: true; driveName: string } | { ok: false; reason: string }> {
  try {
    const cfg = getDriveConfig();
    if (!cfg) {
      return {
        ok: false,
        reason: "Drive auto-upload disabled (set DRIVE_AUTO_UPLOAD_ENABLED, GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON, GOOGLE_DRIVE_SHARED_DRIVE_ID).",
      };
    }
    const res = await cfg.client.drives.get({
      driveId: cfg.sharedDriveId,
      fields: "id,name",
    });
    return { ok: true, driveName: res.data.name || "(unnamed)" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** True for HTTP statuses we should retry. Mirrors AT5 webhook-delivery semantics. */
export function isTransientDriveError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "number") {
    if (code === 408 || code === 429) return true;
    if (code >= 500 && code <= 599) return true;
    return false;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network error|socket hang up/i.test(msg);
}

/** Strip caches — used in unit tests so each scenario starts clean. */
export function _resetDriveClientForTests(): void {
  cachedClient = null;
  cachedClientError = null;
}
