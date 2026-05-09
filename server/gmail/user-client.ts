// Per-user Gmail API client for inbox polling. See migration
// 0030_user_gmail_polling.sql for the architectural rationale: the
// Replit-managed `google-mail` connector lacks gmail.readonly, so we instead
// reuse the architect's own Google Workspace OAuth grant (server/auth/
// google-oauth.ts) to mint a per-user gmail client for the 15-min poller.

import { google, gmail_v1 } from "googleapis";
import { env } from "../env";
import { storage } from "../storage";
import type { User } from "@shared/schema";

/**
 * Build a Gmail API client authenticated as `user`. google-auth-library
 * automatically refreshes the access token if it's expired or near expiry,
 * and emits a `tokens` event when a new access token is minted — we listen
 * for that and persist the new value back to the user row so subsequent
 * polls don't re-mint unnecessarily.
 *
 * Throws if the user has no refresh token (i.e. has not linked their inbox
 * yet — caller is expected to skip them).
 *
 * Note: we instantiate the OAuth2 client via `google.auth.OAuth2` rather than
 * directly importing `OAuth2Client` from `google-auth-library`. There are two
 * copies of `google-auth-library` in node_modules (top-level + one shipped
 * inside `@google-cloud/storage`) and `google.gmail()` is type-pinned to the
 * one bundled with `googleapis`. Going through `google.auth.OAuth2` keeps us
 * on the right copy.
 */
export async function getGmailClientForUser(
  user: User,
): Promise<gmail_v1.Gmail> {
  if (!user.gmailRefreshToken) {
    throw new Error(
      `User ${user.id} (${user.email}) has not linked their Gmail inbox`,
    );
  }
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

  // Pre-seed the access token cache if we have a non-expired one persisted.
  // Saves a token-refresh round-trip on the common path.
  const credentials: { refresh_token: string; access_token?: string; expiry_date?: number } = {
    refresh_token: user.gmailRefreshToken,
  };
  if (user.gmailAccessToken && user.gmailTokenExpiresAt) {
    const expiresMs = user.gmailTokenExpiresAt.getTime();
    if (expiresMs > Date.now() + 60_000) {
      credentials.access_token = user.gmailAccessToken;
      credentials.expiry_date = expiresMs;
    }
  }
  oauth2Client.setCredentials(credentials);

  oauth2Client.on("tokens", (tokens) => {
    // refresh_token is only present on first consent; subsequent refreshes
    // only return access_token. Persist whatever we get.
    storage
      .updateUserGmailTokens(user.id, {
        gmailAccessToken: tokens.access_token ?? null,
        gmailTokenExpiresAt: tokens.expiry_date
          ? new Date(tokens.expiry_date)
          : null,
        // Only overwrite refresh_token when Google actually rotates it,
        // never blank it out on a normal refresh response.
        gmailRefreshToken: tokens.refresh_token ?? undefined,
      })
      .catch((err) => {
        console.error(
          `[Gmail] Failed to persist refreshed tokens for user ${user.id}:`,
          err,
        );
      });
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}
