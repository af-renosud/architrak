import { OAuth2Client, Credentials } from "google-auth-library";
import { env } from "../env";

const ALLOWED_DOMAIN = "renosud.com";

// Gmail scope required by server/gmail/monitor.ts to call users.messages.list
// + users.messages.get + attachments.get + labels create/modify. Without this
// scope on the user's OAuth grant, inbox polling returns 403. See migration
// 0030_user_gmail_polling.sql for the full background.
export const GMAIL_POLL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export interface GoogleUser {
  googleId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

export interface GoogleAuthResult {
  user: GoogleUser;
  // Populated when the user grants the gmail scope (i.e. linkGmail=true on the
  // initial /api/auth/login redirect). refresh_token is only returned by
  // Google on first consent OR when prompt=consent forces a re-grant — that's
  // why getAuthUrl({linkGmail: true}) sets prompt=consent.
  gmailRefreshToken?: string | null;
  gmailAccessToken?: string | null;
  gmailTokenExpiresAt?: Date | null;
  gmailScopeGranted?: string | null;
}

function getClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
}

/**
 * Build a per-user OAuth2Client primed with the architect's stored refresh
 * token. google-auth-library auto-refreshes the access token on every call.
 * Used by server/gmail/user-client.ts to mint a Gmail API client for inbox
 * polling on behalf of that user.
 */
export function getOAuthClientForRefreshToken(refreshToken: string): OAuth2Client {
  const client = getClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export interface AuthUrlOptions {
  /** Adds the Gmail-polling scope and forces consent so refresh_token is returned. */
  linkGmail?: boolean;
}

export function getAuthUrl(callbackUrl: string, opts: AuthUrlOptions = {}): string {
  const client = getClient();
  const scopes = ["openid", "email", "profile"];
  if (opts.linkGmail) {
    scopes.push(GMAIL_POLL_SCOPE);
  }
  return client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    redirect_uri: callbackUrl,
    hd: ALLOWED_DOMAIN,
    // prompt=consent is essential when linkGmail=true: Google only returns a
    // refresh_token on FIRST consent. Re-authing users (the entire existing
    // architect base) would otherwise come back with no refresh_token and the
    // monitor would have nothing to poll with.
    prompt: opts.linkGmail ? "consent" : "select_account",
    include_granted_scopes: true,
  });
}

export async function exchangeCodeForUser(
  code: string,
  callbackUrl: string,
): Promise<GoogleAuthResult> {
  const client = getClient();
  const { tokens } = await client.getToken({ code, redirect_uri: callbackUrl });

  if (!tokens.id_token) {
    throw new Error("No ID token received from Google");
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload) {
    throw new Error("Invalid ID token payload");
  }

  if (payload.hd !== ALLOWED_DOMAIN) {
    throw new DomainRestrictionError(
      `Access restricted to @${ALLOWED_DOMAIN} accounts. Your domain: ${payload.hd || "unknown"}`
    );
  }

  if (!payload.email || !payload.email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    throw new DomainRestrictionError(
      `Access restricted to @${ALLOWED_DOMAIN} accounts. Your email: ${payload.email || "unknown"}`
    );
  }

  if (!payload.email_verified) {
    throw new DomainRestrictionError(
      "Email address has not been verified by Google"
    );
  }

  const user: GoogleUser = {
    googleId: payload.sub!,
    email: payload.email,
    firstName: payload.given_name ?? null,
    lastName: payload.family_name ?? null,
    profileImageUrl: payload.picture ?? null,
  };

  // The Gmail-polling scope was granted iff the returned scope string
  // contains it. Older logins (or the regular "select account" path) won't
  // include it, in which case all the gmail* fields stay null and the user
  // simply isn't polled until they hit the "Link inbox" CTA.
  const scopeStr = (tokens as Credentials).scope ?? "";
  const grantedGmail = scopeStr.split(" ").some((s) => s === GMAIL_POLL_SCOPE);

  return {
    user,
    gmailRefreshToken: grantedGmail ? tokens.refresh_token ?? null : null,
    gmailAccessToken: grantedGmail ? tokens.access_token ?? null : null,
    gmailTokenExpiresAt: grantedGmail && tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : null,
    gmailScopeGranted: grantedGmail ? scopeStr : null,
  };
}

export class DomainRestrictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainRestrictionError";
  }
}
