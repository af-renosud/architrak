# ArchiTrak — French Architecture Financial Management

## Overview
ArchiTrak is a financial workflow management application designed for French architectural firms (maîtres d'œuvre). Its primary purpose is to manage the complete financial lifecycle of construction projects, from initial contracts (Marché) and quotations (Devis) through variations (Avenant), progress claims (Situation de Travaux), and architect-verified payment instructions (Certificat de Paiement), up to fee tracking. The application integrates with ArchiDoc for project and contractor management and features AI-powered extraction of financial data from PDF attachments in Gmail. The business vision is to streamline financial operations for architectural firms, improving accuracy and efficiency in project billing and financial oversight.

## User Preferences
- French domain terms kept (Devis, Avenant, Marché, Certificat, Honoraires, Lot, Situation, Retenue de Garantie, PV/MV, TVA, SIRET). All other UI in English.
- Bilingual data fields (description_fr + description_uk) for client communication.
- Projects ONLY created via ArchiDoc API — no manual project creation.

## System Architecture

### Operations Runbook
- **Migrations**: generated via `npm run db:generate`; applied at deploy via `npx tsx scripts/run-migrations.mjs` (called from `scripts/post-merge.sh`). NEVER use `db:push` — this project has 23 hand-tracked SQL migrations and a `drizzle.__drizzle_migrations` tracker; `db:push` would corrupt the migration history.
- **Migration-replay gate (Task #124)**: canonical command is `bash scripts/check-migration-replay.sh`. Runs `npx vitest run server/__tests__/migration-replay.test.ts` with `STRICT_MIGRATION_REPLAY=1` and exits non-zero on any failure (including silent skips from missing DB privileges). Wired into `scripts/post-merge.sh` so a partial migration apply aborts the deploy. For local exploration, drop the env var and run the vitest directly.
- **Deep healthcheck + post-deploy smoke gate (Task #125)**: `GET /healthz/deep` issues `SELECT * FROM <table> WHERE FALSE` against every Drizzle-modeled table (45 tables today) and returns 503 with `{table, error}` for each failure. Public, rate-limited at 30 req/min/caller. Cheap liveness probe is `GET /healthz`. After migrations apply, `scripts/post-merge.sh` invokes `npx tsx scripts/post-deploy-smoke.ts` which polls the deep endpoint for up to 60 s; on persistent failure it sends an operator alert and exits 1 to abort the deploy. Set `POST_DEPLOY_SMOKE=0` to skip on environments without a reachable `PUBLIC_BASE_URL`.
- **Post-merge schema-error classifier + runtime watchdog (Task #126)**: `scripts/lib/run-or-classify.sh` wraps every post-merge maintenance script (contractor-identifier backfill, page-hint backfill). On non-zero exit it greps the last 50 log lines for `column "..." does not exist` — match → exit 2 (deploy aborts); no match → fire-and-forget operator alert with subject prefix `[transient]` and exit 0 so flaky external dependencies don't block the merge. In-process: `server/operations/healthz-watchdog.ts` polls `/healthz/deep` every 5 minutes when `NODE_ENV=production` AND `OPERATOR_ALERT_EMAIL` is set, alerting exactly once per failure window (re-armed on first successful poll).
- **Repeat-transient escalation (Task #130)**: every `[transient]` alert from #126 is also recorded in `post_merge_transient_failures` (one row per source tag). The classifier's success path clears the counter for that source. Once a source has failed transiently on `POST_MERGE_ESCALATE_AFTER` consecutive deploys (default 3), the NEXT failure (counter > threshold, e.g. the 4th in a row at default) ships with subject prefix `[escalated]` and a body listing the N prior failure timestamps so the on-call stops dismissing it as ignorable. Escalation is visibility-only — schema errors keep their existing exit-2 abort path, and DB failures while persisting the counter degrade gracefully to a plain `[transient]` alert.
- **`OPERATOR_ALERT_EMAIL`**: REQUIRED in production. Comma-separated list of recipients for operator alerts (post-deploy backfills, smoke-gate failures, /healthz watchdog). When unset in production, `server/env.ts` logs a single `[env] WARN — OPERATOR_ALERT_EMAIL not configured` line at boot and the runtime watchdog skips itself entirely. Optional in dev/CI.
- **Environment override**: set `REPLAY_ADMIN_DB=postgres` (or another DB the role can connect to) if the deploy role cannot CREATE DATABASE while connected to the main app DB.

### Tech Stack
- **Frontend**: React 18 + TypeScript, Vite, Tailwind CSS, Shadcn UI, Wouter, TanStack React Query
- **Backend**: Express 5 (Node.js), PostgreSQL, Drizzle ORM
- **Integrations**: ArchiDoc API, Gmail API, OpenAI, Object Storage
- **Design System**: Archidoc "Architectural Luxury" (Navy primary, Inter font, luxury cards with rounded corners and subtle shadows)

### Core Financial Concepts
- **Three Buckets**: Contracted, Certified, Reste à Réaliser
- **Two Invoicing Modes**: Mode A (simple tick-off) and Mode B (percentage completion per line item)
- **Retenue de Garantie**: 5% holdback
- **PV/MV**: Variation orders adjusting contract value
- **Fee Types**: Works percentage, Conception, Planning
- **Commission Workflow**: Invoice upload → approval → auto-calculation of commission → fee entry
- **Commission Rate**: Project-specific `feePercentage`
- **Dashboard Layout**: Gmail status bar, per-project rows with four counter boxes (Devis, Signed, Factures, Agent)

### Technical Implementations
- **Database Schema**: 30+ tables covering core financial data (projects, contractors, lots, marches, devis, avenants, invoices, situations, certificats, fees, fee_entries), ArchiDoc mirrors, and document/communication tracking.
- **AI Extraction Layer**: Uses Google Gemini (Expert-Comptable BTP prompt) for structured JSON extraction from PDFs, with `extraction-validator.ts` for financial validation and confidence scoring.
- **Certificat de Paiement Generation**: HTML to PDF conversion via DocRaptor (PrinceXML engine), adhering to ARCHIDOC design system with detailed financial annexes. Auto-sequential numbering per project.
- **ArchiDoc Sync**: Event-driven webhook (HMAC-secured) for project and contractor data synchronization, with polling as a fallback.
- **Authentication**: Google Workspace OAuth 2.0 with domain restriction (`@renosud.com`), PostgreSQL session store, robust security measures. A dev-only `POST /api/auth/dev-login` endpoint is registered ONLY when `NODE_ENV !== "production"` AND `ENABLE_DEV_LOGIN_FOR_E2E=true`; it is used by Playwright browser tests in `tests/browser/`. Run them with `npx playwright test` (config in `playwright.config.ts`).
- **Error Handling**: Global error handler prevents stack trace leakage; all API routes use Zod for payload validation.
- **Rate Limiting**: Token-bucket algorithm with pluggable store (in-memory or Postgres-backed).
- **Rounding Policy**: Strict 2-decimal rounding (`roundCurrency`) for all financial calculations.
- **Document Storage**: PDFs and other documents are stored in object storage.
- **API Structure**: Domain-driven routing (`/api/projects`, `/api/contractors`, `/api/devis`, etc.) for CRUD operations and specialized financial workflows.
- **Fee Tracking**: Advanced fee tracking with `phase` (conception/chantier/aor) and by-phase summaries.
- **Executive Dashboard**: Burn-up charts showing contract and certified value history over time.
- **Bulk Export**: Generates ZIP archives of project financial documents from object storage.

### Devis-Check Portal Token Lifecycle
- Contractor portal tokens (`devis_check_tokens`) are tied to the devis invoicing lifecycle, not just a fixed TTL.
- Primary trigger: a token is auto-revoked when its devis is "fully invoiced" — `sum(invoices.amount_ht) >= devis.amount_ht + approved PV − approved MV`. The check runs inline after every invoice create/update/delete/confirm, after every devis update/confirm, and after every avenant create/update.
- Safety net: a periodic cleanup job (`server/services/devis-check-token-cleanup.ts`) sweeps both expired tokens (idle ceiling) and fully-invoiced devis, in case any mutation path is missed.
- Idle ceiling: `DEVIS_CHECK_TOKEN_TTL_DAYS` (default 90) caps how long a token can sit idle on a never-completed devis. Set to 0 to disable.

### Core Development Protocols
- **Zero-Tolerance TypeScript**: No `any`, `@ts-ignore`, `@ts-expect-error`. Unknown types must be Zod-parsed.
- **Environment Variables**: Zod-validated fail-fast exports from `server/env.ts` only.
- **API Perimeter Validation**: Strict Zod schemas via `validateRequest` middleware for all HTTP inputs.
- **Database Mutations**: Drizzle versioned migrations (`db:generate`, `db:migrate`).
- **Error Handling**: No stack traces or raw database errors to clients; all exceptions handled by `server/middleware/error-handler.ts`.

## External Dependencies
- **ArchiDoc API**: For project and contractor data synchronization.
- **Google Gemini API**: For AI-powered document parsing and financial data extraction from PDFs.
- **DocRaptor API**: For high-fidelity HTML to PDF conversion (PrinceXML engine) of Certificats de Paiement.
- **Google OAuth 2.0**: For user authentication and authorization.
- **Gmail API**: For monitoring incoming emails and extracting PDF attachments.
- **PostgreSQL**: Primary database for all application data and session storage.
- **Object Storage**: For storing uploaded and generated PDF documents and other files.