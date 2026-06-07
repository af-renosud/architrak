# Threat Model

## Project Overview

ArchiTrak is a publicly reachable single-firm financial workflow application for Renosud. The production stack is a React/Vite frontend served by a Node/Express backend with PostgreSQL, Replit Object Storage, Google Workspace OAuth, public tokenized review portals, and multiple server-to-server integrations (ArchiDoc, Archisign, Gmail, DocRaptor, Pennylane, Google Drive).

Production analysis assumes `NODE_ENV=production`, Replit-managed TLS, and that dev-only flags such as `ENABLE_DEV_LOGIN_FOR_E2E` and `E2E_FAKE_GMAIL` are unset. The mockup sandbox, tests, fixtures, and local-only tooling are out of scope unless production reachability is demonstrated.

## Assets

- **Operator sessions and Google-linked identities** — session cookies gate nearly all `/api` routes; compromise gives full operator access inside the single-tenant deployment.
- **Public portal bearer tokens** — contractor/client review links and Archisign PDF fetch tokens grant access without a session, so secrecy and bounded lifetime matter.
- **Construction-finance records** — projects, devis, invoices, certificats, fee data, banking-verification state, and audit rows are business-critical and often sensitive.
- **Uploaded documents and generated PDFs** — devis, invoices, design contracts, certificats, RIB attachments, and email attachments contain financial and banking data.
- **Third-party credentials and shared service authority** — session secret, webhook secrets, OAuth client secrets, Gmail connector access, DocRaptor, ArchiDoc, Archisign, Pennylane, and Drive credentials enable privileged external actions.

## Trust Boundaries

- **Browser / public caller → Express** — all route params, query strings, bodies, cookies, and uploaded files are untrusted.
- **Unauthenticated / token-authenticated / session-authenticated surfaces** — `/healthz*`, public portals, and webhooks are exposed without an operator session; `/api/*` is mostly session-protected.
- **Express → PostgreSQL** — the server has broad read/write authority across the single-tenant dataset.
- **Express → Object Storage** — storage keys map to sensitive PDFs and uploads; route-level authorization must prevent arbitrary reads.
- **Express → external services** — outbound calls to ArchiDoc, Archisign, Gmail, DocRaptor, Drive, Gemini, and Pennylane cross into third-party trust zones and must constrain input, credentials, and callback authenticity.
- **Single-tenant operators / external recipients** — all authenticated `@renosud.com` users are treated as authorized operators for the entire dataset. That removes tenant isolation from the current production threat model, but makes compromise of any operator session equivalent to full-app compromise.

## Scan Anchors

- **Production entry points:** `server/index.ts`, `server/routes/index.ts`, `server/auth/routes.ts`.
- **Highest-risk code areas:** `server/routes/public-checks.ts`, `server/routes/public-client-checks.ts`, `server/routes/webhooks.ts`, `server/routes/archisign-webhooks.ts`, `server/routes/archisign-public.ts`, `server/communications/*`, `server/services/*`, `server/storage/object-storage*`.
- **Public surfaces:** `/healthz`, `/healthz/deep`, `/p/check/:token*`, `/p/client/:token*`, `/public/...` style portal preview routes when explicitly mounted, `/api/webhooks/archidoc`, `/api/webhooks/archisign`, `/api/archisign-public/:token`.
- **Authenticated surfaces:** nearly all `/api/*` business routes share the same operator trust level; “admin” routes are not privilege-separated beyond session auth.
- **Usually dev-only / ignore unless proven reachable:** `artifacts/mockup-sandbox/**`, `tests/**`, `docs/**`, local scripts, fake Gmail paths guarded by `NODE_ENV !== "production"`.

## Threat Categories

### Spoofing

The main spoofing risks are forged operator sessions, forged public-link access, forged ArchiDoc/Archisign webhooks, and OAuth callback abuse. Production guarantees required here are: session cookies remain unpredictable and server-validated; public bearer tokens are high-entropy, stored/compared safely, and expire; webhook routes verify shared-secret signatures before trusting payloads; OAuth login/linking flows bind callbacks to the session that initiated them and do not let an attacker silently attach the victim browser to a different Google identity.

### Tampering

This system carries money movement, sign-off state, and external workflow transitions, so server-side enforcement must remain authoritative. Guarantees required: all state transitions and financial calculations stay server-derived; request validation never substitutes for authorization; public portals can affect only the devis/check records named by their token; external callbacks are authenticated before mutating rows; uploads, staged files, and attachment references cannot be swapped across users or projects.

### Information Disclosure

ArchiTrak stores sensitive financial documents, contractor banking details, client contact data, and integration diagnostics. Guarantees required: unauthenticated routes disclose only the minimum data needed for liveness or tokenized workflows; public portals expose only the fields intentionally whitelisted for external recipients; object-storage backed download routes must enforce the same authorization as the parent record; errors, health probes, and external-service failures must not leak secrets, schema internals, or banking data to unauthenticated callers.

### Denial of Service

Several public or low-friction routes trigger database scans, object-storage reads, PDF rendering, and third-party calls. Guarantees required: unauthenticated/token-authenticated endpoints are rate-limited per caller and per token; expensive operations are not exposed anonymously without bounds; outbound fetches use sane timeouts; uploads and HTML-to-PDF generation cannot be abused for unbounded resource consumption.

### Elevation of Privilege

Because the deployment is intentionally single-tenant, classic cross-tenant IDOR is out of scope for current production use, but privilege escalation still matters across trust boundaries. Guarantees required: only authenticated operators can reach business `/api` routes; public/token routes cannot be turned into broader record access; secrets used for one integration purpose should not implicitly unlock unrelated data paths; injection flaws in SQL, HTML/PDF templating, MIME generation, or outbound fetch construction must not let an attacker read arbitrary data, send arbitrary emails, or execute privileged external actions.
