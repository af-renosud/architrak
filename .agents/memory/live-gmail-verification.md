---
name: Live Gmail verification in dev
description: How to run real-Gmail end-to-end checks in this project (connector limits, OAuth redirect, dev-login pitfalls)
---

# Live Gmail verification in dev

- Dev normally runs with `E2E_FAKE_GMAIL=true` (all Gmail stubbed). For live tests, temporarily remove that env from the "Start application" workflow and restore it afterwards.
- The Replit `google-mail` connector is **send-only** (403 on any read: profile, messages.list, threads.get) — verified live. It also authenticates as the **same account** as the architect's linked inbox (help@renosud.com), so it cannot play "a different sender" in tests, and self-sends land in a *new* thread, not the original.
- Per-user linked inboxes (`/api/auth/link-gmail`) need the dev domain's callback (`https://$REPLIT_DEV_DOMAIN/api/auth/callback`) added to the Google OAuth client's Authorized redirect URIs, or Google fails with `redirect_uri_mismatch`. The dev domain changes across sessions, so this may need re-adding.
- `POST /api/auth/dev-login` upserts by googleId `dev:<email>` — it 500s (email unique violation) for an email that already exists with a real Google id. To act as a real user, drive server code directly via tsx scripts (`storage`, `sendCertificat`, `sendCommunication({sentByUserId})`) instead of HTTP.
- To post an on-thread reply from the architect's own mailbox, pass `threadId` in `gmail.users.messages.send` plus `In-Reply-To`/`References` of the original RFC Message-ID (read it from the thread via the user's client).
- Certificat emails use `project.clientAddress` as the recipient email (email-sender.ts) even though the schema treats it as a postal address and has a separate `clientContactEmail` — set clientAddress to an email for tests; flagged as a follow-up bug.

**Why:** first live-mailbox verification (payment-reply scanner) burned time on each of these; they are environment facts not visible in code alone.
**How to apply:** any future task that needs a real Gmail send/read in dev.
