import { OAuth2Client } from "google-auth-library";
import { env } from "../env";

const ALLOWED_DOMAIN = "renosud.com";

export interface GoogleUser {
  googleId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

function getClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
}

export function getAuthUrl(callbackUrl: string): string {
  const client = getClient();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    redirect_uri: callbackUrl,
    hd: ALLOWED_DOMAIN,
    prompt: "select_account",
  });
}

export async function exchangeCodeForUser(code: string, callbackUrl: string): Promise<GoogleUser> {
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

  return {
    googleId: payload.sub!,
    email: payload.email,
    firstName: payload.given_name ?? null,
    lastName: payload.family_name ?? null,
    profileImageUrl: payload.picture ?? null,
  };
}

export class DomainRestrictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainRestrictionError";
  }
}
