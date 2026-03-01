import { OAuth2Client } from "google-auth-library";

const ALLOWED_DOMAIN = "sas-architects.fr";

export interface GoogleUser {
  googleId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

function getClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }
  return new OAuth2Client(clientId, clientSecret);
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
    audience: process.env.GOOGLE_CLIENT_ID,
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
