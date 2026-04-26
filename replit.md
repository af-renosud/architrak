# ArchiTrak — French Architecture Financial Management

## Overview
ArchiTrak is a financial workflow management application for French architectural firms (maîtres d'œuvre). It manages the complete financial lifecycle of construction projects, from initial contracts and quotations through variations, progress claims, and architect-verified payment instructions, up to fee tracking. The application integrates with ArchiDoc for project and contractor management and features AI-powered extraction of financial data from PDF attachments in Gmail. The business vision is to streamline financial operations for architectural firms, improving accuracy and efficiency in project billing and financial oversight.

## User Preferences
- French domain terms kept (Devis, Avenant, Marché, Certificat, Honoraires, Lot, Situation, Retenue de Garantie, PV/MV, TVA, SIRET). All other UI in English.
- Bilingual data fields (description_fr + description_uk) for client communication.
- Projects ONLY created via ArchiDoc API — no manual project creation.

## System Architecture

### Operations Runbook
- **Migrations**: Generated via `npm run db:generate`, applied at deploy via `npx tsx scripts/run-migrations.mjs`. Direct `db:push` is prohibited due to hand-tracked SQL migrations.
- **Migration-replay gate**: `bash scripts/check-migration-replay.sh` ensures migration consistency.
- **Deep healthcheck + post-deploy smoke gate**: `GET /healthz/deep` verifies database table integrity, with a post-deploy smoke test polling for up to 60 seconds.
- **Post-merge schema-error classifier + runtime watchdog**: Classifies post-merge script failures to distinguish schema errors (deploy abort) from transient issues (operator alert). A runtime watchdog polls `/healthz/deep` in production for continuous monitoring.
- **Repeat-transient escalation**: Escalates recurring transient failures to prevent them from being dismissed.
- **Database identity guard**: Verifies the application is connected to the correct database using host fingerprinting and a sentinel row, preventing accidental operation on incorrect databases.
- **Schema-presence boot invariant**: Checks for schema drift at startup, ensuring the database schema matches the migration tracker before the application fully boots.
- **Tracker reconciliation script**: Provides a recovery mechanism for `drizzle.__drizzle_migrations` tracker drift, allowing operators to resync the tracker with the actual schema.

### Tech Stack
- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, Shadcn UI, Wouter, TanStack React Query.
- **Backend**: Express 5 (Node.js), PostgreSQL, Drizzle ORM.
- **Integrations**: ArchiDoc API, Gmail API, OpenAI, Object Storage.
- **Design System**: Archidoc "Architectural Luxury" (Navy primary, Inter font, luxury cards).

### Core Financial Concepts
- **Three Buckets**: Contracted, Certified, Reste à Réaliser.
- **Two Invoicing Modes**: Mode A (tick-off) and Mode B (percentage completion).
- **Retenue de Garantie**: 5% holdback.
- **PV/MV**: Variation orders.
- **Fee Types**: Works percentage, Conception, Planning.
- **Commission Workflow**: Invoice upload → approval → auto-calculation → fee entry.
- **Commission Rate**: Project-specific `feePercentage`.
- **Dashboard Layout**: Gmail status bar, per-project rows with counters for Devis, Signed, Factures, Agent.

### Technical Implementations
- **Database Schema**: Extensive schema covering financial data, ArchiDoc mirrors, and document/communication tracking. Includes tables for client checks, insurance overrides, and webhook logging.
- **Client review portal**: A public, token-authenticated portal for clients to review and approve/reject devis, with PDF viewing and messaging functionality.
- **AI Extraction Layer**: Uses Google Gemini with a specialized prompt for structured JSON extraction from financial PDFs, including validation and confidence scoring.
- **Certificat de Paiement Generation**: HTML to PDF conversion via DocRaptor, adhering to the ARCHIDOC design system with auto-sequential numbering.
- **ArchiDoc Sync**: Event-driven webhook and polling for project and contractor data synchronization.
- **Insurance Sign-off Gate (AT3)**: Live-verdict client to Archidoc's `/api/integrations/architrak/contractors/:id/insurance-verdict` (5s budget, 2.5s/attempt, 401 retry-once, 404 non-overridable). Per contract §1.3 the mirror is advisory only and not the gate's source of truth: 503 / timeout / network all map to `live_transient` (red + overridable) with mirror status surfaced as context only. Mirror-only fall-through is preserved solely for env without `ARCHIDOC_BASE_URL` / `ARCHIDOC_SYNC_API_KEY` or rows missing archidoc IDs (no live attempt). Enforced at any PATCH that crosses into `sent_to_client`; stale overrides are invalidated when drift moves the verdict to a non-overridable arm. 7-field override snapshot is persisted server-side from a fresh evaluation into `insurance_overrides` (immutable audit row).
- **Archisign Envelope Orchestration (AT4)**: Outbound client (`server/services/archisign.ts`) wraps `/envelopes/create` then `/envelopes/send` with X-API-KEY auth (CSV `ARCHISIGN_API_KEY`, first key used), 3-attempt 5xx/network retry (1s/3s backoff), 10s/attempt cap, and a now()+1min `expiresAt` floor (G5). 410 retention-breach errors surface as `ArchisignRetentionBreachError`. Inbound webhook (`POST /api/webhooks/archisign`) is born-strict HMAC v2 only — `sha256(${ts}.${rawBody})` keyed off `ARCHISIGN_WEBHOOK_SECRET` with ±5min skew, 1 MiB body cap, 401/413/503 outcomes. Idempotency via `ON CONFLICT DO NOTHING` insert into `webhook_events_in` BEFORE per-event handler dispatch; duplicates → 200 `{deduplicated:true}`. Seven events from §2.1 (`envelope.{sent,queried,query_resolved,declined,expired,signed,retention_breach}`) drive the §1.2 lifecycle: declined → `void`, expired → back to `approved_for_signing` (accessUrl soft-invalidated), signed → `client_signed_off` with 8-field `identityVerification` block + `signedPdfFetchUrl` snapshot, queried opens a `client_checks` row (originSource=`archisign_query`), retention_breach inserts a `signed_pdf_retention_breaches` row (`ON CONFLICT DO NOTHING`). Architect-facing send flow: `POST /api/devis/:id/send-to-signer` mints a 1h HMAC-signed PDF fetch token (`server/services/archisign-pdf-token.ts`) → public download endpoint `GET /api/public/devis-pdf/:token` (auth-bypassed via `publicPaths`) → `/create` then `/send`. UI: `SigningPanel` in `DevisTab.tsx` shows envelope status badge, access URL, OTP destination, and expiry; resend-after-expiry is intentionally out of AT4 scope (UI shows the soft-invalidated link struck-through with a "future update" note). Schema additions live in `migrations/0025_archisign_envelope_tracking.sql` (5 nullable cols on `devis` + status enum CHECK).
- **Outbound Archidoc Webhook Delivery (AT5)**: One-way Architrak → Archidoc surface for the work-authorisations endpoint (contract §5.3). Two payload variants — `work_authorised` (§5.3.1, fired on AT4's `client_signed_off` transition) and `signed_pdf_retention_breach` (§5.3.2, routed from AT4's `envelope.retention_breach` handler) — share a single endpoint URL and discriminate via the explicit `eventType` field (G8). HMAC v2 signing: `sha256(${ts}.${rawBody})` keyed off `ARCHITRAK_WEBHOOK_SECRET`, headers `X-Architrak-Timestamp` + `X-Architrak-Signature`, deterministic `JSON.stringify` serialisation, 1 MiB pre-send cap, 10s/attempt timeout. Hard-fails when the secret is unset on the actual dispatch path; soft-skips at enqueue time so AT4 inbound webhooks still 200 in dev (no `webhook_deliveries_out` row inserted when surface is unconfigured). Each enqueue mints a stable RFC 9562 UUIDv7 (`server/lib/uuidv7.ts`, no new dep) into `event_id` so retries dedup at the receiver (G6). Storage uses INSERT … ON CONFLICT (event_id) DO NOTHING in `claimWebhookDeliveryOut` (race-safe). Retry orchestrator (`server/services/webhook-delivery.ts`): 3 attempts total, exponential 1s/3s backoff with ±20% jitter; 4xx (non-429) → dead-letter immediately; 5xx/429/network → retryable; 429 honours `Retry-After`. First attempt fires inline (fire-and-forget) from the AT4 handler; an in-process `setInterval` sweeper (30s) drains rows whose `next_attempt_at` is due, surviving process restarts. `originalSignedAt` on the breach payload is preserved verbatim from the inbound Archisign body — Archidoc correlates breaches by byte-equality with the prior `work_authorised.signedAt`. Admin DLQ at `/admin/ops/webhook-dlq`: list rows by state (pending / succeeded / dead_lettered), one-click retry resets to pending and triggers an immediate attempt (eventId preserved → safe re-attempt). Wire fixtures live in `docs/wire-fixtures/{work-authorised,signed-pdf-retention-breach,identity-verification}.json`. No schema migration — `webhook_deliveries_out` was added in AT1.
- **Authentication**: Google Workspace OAuth 2.0 with domain restriction, PostgreSQL session store, and a dev-only login for E2E testing.
- **Error Handling**: Global error handler and Zod for API payload validation.
- **Rate Limiting**: Token-bucket algorithm.
- **Rounding Policy**: Strict 2-decimal rounding for all financial calculations.
- **Document Storage**: Object storage for PDFs and other documents.
- **API Structure**: Domain-driven routing for CRUD and financial workflows.
- **Fee Tracking**: Advanced fee tracking by phase.
- **Executive Dashboard**: Burn-up charts for contract and certified value.
- **Bulk Export**: Generates ZIP archives of financial documents.

### Devis-Check Portal Token Lifecycle
- Tokens are automatically revoked when their associated devis is "fully invoiced."
- A periodic cleanup job sweeps expired and fully-invoiced devis tokens.
- An idle ceiling limits how long an uncompleted devis token can remain active.

### Core Development Protocols
- **Zero-Tolerance TypeScript**: No `any`, `@ts-ignore`, `@ts-expect-error`.
- **Environment Variables**: Zod-validated fail-fast exports.
- **API Perimeter Validation**: Strict Zod schemas via `validateRequest` middleware.
- **Database Mutations**: Drizzle versioned migrations.
- **Error Handling**: No stack traces or raw database errors to clients.

## External Dependencies
- **ArchiDoc API**: For project and contractor data synchronization.
- **Google Gemini API**: For AI-powered document parsing and financial data extraction.
- **DocRaptor API**: For high-fidelity HTML to PDF conversion.
- **Google OAuth 2.0**: For user authentication and authorization.
- **Gmail API**: For monitoring incoming emails and extracting PDF attachments.
- **PostgreSQL**: Primary database.
- **Object Storage**: For storing documents.