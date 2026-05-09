import type { Express, Request, Response } from "express";
import { getAuthUrl, exchangeCodeForUser, DomainRestrictionError } from "./google-oauth";
import { storage } from "../storage";
import { env } from "../env";

function getCallbackUrl(req: Request): string {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}/api/auth/callback`;
}

export function registerAuthRoutes(app: Express) {
  app.get("/api/auth/login", (req: Request, res: Response) => {
    try {
      const callbackUrl = getCallbackUrl(req);
      const authUrl = getAuthUrl(callbackUrl);
      res.redirect(authUrl);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // /api/auth/link-gmail — opt-in inbox-monitoring grant. Same OAuth flow as
  // /login but adds the gmail.modify scope and forces prompt=consent so
  // Google returns a refresh_token (only emitted on first consent). Idempotent
  // — re-running just refreshes the stored refresh_token.
  app.get("/api/auth/link-gmail", (req: Request, res: Response) => {
    try {
      const callbackUrl = getCallbackUrl(req);
      const authUrl = getAuthUrl(callbackUrl, { linkGmail: true });
      res.redirect(authUrl);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/auth/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string;
    if (!code) {
      return res.status(400).json({ message: "Missing authorization code" });
    }

    try {
      const callbackUrl = getCallbackUrl(req);
      const result = await exchangeCodeForUser(code, callbackUrl);
      const googleUser = result.user;

      const user = await storage.upsertUser({
        googleId: googleUser.googleId,
        email: googleUser.email,
        firstName: googleUser.firstName,
        lastName: googleUser.lastName,
        profileImageUrl: googleUser.profileImageUrl,
        lastLoginAt: new Date(),
      });

      // If the user just granted the gmail scope, persist their refresh
      // token so server/gmail/monitor.ts can poll their inbox. Don't blank
      // out a previously-stored refresh_token if this login didn't grant
      // gmail (e.g. they re-logged via the regular /login route).
      if (result.gmailRefreshToken) {
        await storage.updateUserGmailTokens(user.id, {
          gmailRefreshToken: result.gmailRefreshToken,
          gmailAccessToken: result.gmailAccessToken ?? null,
          gmailTokenExpiresAt: result.gmailTokenExpiresAt ?? null,
          gmailScopeGranted: result.gmailScopeGranted ?? null,
        });
      }

      req.session.regenerate((regenerateErr) => {
        if (regenerateErr) {
          console.error("Session regenerate error:", regenerateErr);
          return res.status(500).json({ message: "Failed to create session" });
        }
        req.session.userId = user.id;
        req.session.save((saveErr) => {
          if (saveErr) {
            console.error("Session save error:", saveErr);
            return res.status(500).json({ message: "Failed to create session" });
          }
          res.redirect("/");
        });
      });
    } catch (error: any) {
      if (error instanceof DomainRestrictionError) {
        return res.status(403).send(`
          <!DOCTYPE html>
          <html><head><title>Access Denied</title>
          <style>body{font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#F8F9FA;color:#0B2545}
          .card{text-align:center;padding:3rem;border-radius:1rem;background:white;box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:480px}
          h1{font-size:1.5rem;margin-bottom:1rem}p{color:#7E7F83;line-height:1.6}
          a{display:inline-block;margin-top:1.5rem;color:#c1a27b;text-decoration:none;font-weight:600}</style></head>
          <body><div class="card">
          <h1>Access Denied</h1>
          <p>${error.message}</p>
          <a href="/api/auth/login">Try a different account</a>
          </div></body></html>
        `);
      }
      console.error("OAuth callback error:", error);
      res.status(500).json({ message: "Authentication failed" });
    }
  });

  if (env.NODE_ENV !== "production" && env.ENABLE_DEV_LOGIN_FOR_E2E) {
    console.warn(
      "[auth] ⚠ DEV LOGIN ENABLED — POST /api/auth/dev-login will accept ARBITRARY email addresses (any domain, bypassing the production @renosud.com Google OAuth restriction). NEVER set ENABLE_DEV_LOGIN_FOR_E2E in production.",
    );
    app.post("/api/auth/dev-login", async (req: Request, res: Response) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
      if (!email) {
        return res.status(400).json({ message: "email is required" });
      }
      try {
        const user = await storage.upsertUser({
          googleId: `dev:${email}`,
          email,
          firstName: typeof req.body?.firstName === "string" ? req.body.firstName : "Dev",
          lastName: typeof req.body?.lastName === "string" ? req.body.lastName : "User",
          profileImageUrl: null,
          lastLoginAt: new Date(),
        });
        req.session.regenerate((regenerateErr) => {
          if (regenerateErr) {
            console.error("[dev-login] session regenerate error:", regenerateErr);
            return res.status(500).json({ message: "Failed to create session" });
          }
          req.session.userId = user.id;
          req.session.save((saveErr) => {
            if (saveErr) {
              console.error("[dev-login] session save error:", saveErr);
              return res.status(500).json({ message: "Failed to create session" });
            }
            res.json({ id: user.id, email: user.email });
          });
        });
      } catch (error: any) {
        console.error("[dev-login] failed:", error);
        res.status(500).json({ message: error?.message ?? "dev-login failed" });
      }
    });
  }

  app.get("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        console.error("Session destroy error:", err);
      }
      res.redirect("/");
    });
  });

  app.get("/api/auth/user", async (req: Request, res: Response) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const user = await storage.getUser(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ message: "User not found" });
    }

    res.json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      // Inbox-link state for the dashboard's "Link my inbox" CTA. Never
      // expose the refresh_token itself — only whether one exists.
      gmailLinked: user.gmailRefreshToken !== null && user.gmailRefreshToken !== "",
      gmailPollingEnabled: user.gmailPollingEnabled,
      gmailLastPollAt: user.gmailLastPollAt?.toISOString() ?? null,
      gmailLastPollStatus: user.gmailLastPollStatus,
    });
  });
}
