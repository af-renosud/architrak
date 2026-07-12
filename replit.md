# ArchiTrak

Financial workflow app for French architectural firms (maîtres d'œuvre). Manages the
full lifecycle of construction-project finances: contracts → quotations → variations →
progress claims → architect-verified payment instructions → fee tracking. Integrates
with **ArchiDoc** for project/contractor data and **Archisign** for client e-signature.
AI extraction (Gemini) parses PDF attachments arriving by Gmail.

> Deep architectural rules, calculation invariants, and inter-app contracts live in
> **`ARCHITECTURE.md`** ("the constitution"). Read it before changing financial logic
> or webhook contracts.

## Stack

- **Frontend**: React 18 + TypeScript, Vite, Tailwind, Shadcn UI, Wouter, TanStack Query
- **Backend**: Node 20, Express 5, TypeScript (`tsx` in dev, `esbuild` for prod)
- **DB**: PostgreSQL 16 + Drizzle ORM (56 application tables in `shared/schema.ts`, 41 hand-tracked SQL migrations)
- **AI**: Google Gemini (`@google/generative-ai`) for PDF extraction
- **Storage**: Replit Object Storage (GCS-backed) for PDFs and uploads
- **External services**: ArchiDoc, Archisign, DocRaptor (HTML→PDF), Gmail API
- **Auth**: Google Workspace OAuth 2.0 (`@renosud.com` domain-restricted)
- **Tests**: Vitest (unit + integration), Playwright (browser, in `tests/browser/`)

## Repo layout

```
client/        React app (entry: client/src/main.tsx)
server/        Express app (entry: server/index.ts)
  routes/      Domain routes (39 routers, mounted by routes/index.ts)
  services/    Business logic
  archidoc/    ArchiDoc sync + import
  gmail/       Inbox polling + extraction
  operations/  Boot invariants (schema-presence-check, db identity guard)
shared/        Schema, types, financial utils — imported by client AND server
migrations/    Hand-written SQL + meta/_journal.json (NEVER use drizzle db:push)
scripts/       Ops scripts (run-migrations, post-deploy smoke, backfills)
script/        ⚠ Build entrypoint (script/build.ts) — singular, not "scripts"
docs/          Inter-app contract specs, wire fixtures
tests/browser/ Playwright e2e
```

## Dev workflow

The `Start application` workflow runs:
```
PUBLIC_BASE_URL=http://localhost:5000 E2E_FAKE_GMAIL=true npm run dev
```
Server on port **5000** (Vite mounted on the same port). `E2E_FAKE_GMAIL=true` short-circuits
outbound Gmail to an in-memory fake — real send won't fire locally.

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server (tsx watch) |
| `npm run check` | TypeScript type-check (no emit) |
| `npm run build` | Production bundle (`script/build.ts` → `dist/`) |
| `npm run start` | Run production bundle |
| `npm run db:generate` | Generate a new Drizzle migration |
| `npx tsx scripts/run-migrations.mjs` | Apply migrations (also runs at deploy) |
| `npx vitest` | Unit + integration tests |
| `npx playwright test` | Browser e2e |

## Environment variables

Validated via Zod in `server/env.ts` — server refuses to boot on invalid/missing required vars.
**Required**: `DATABASE_URL`, `SESSION_SECRET`. **Feature-scoped** (each unlocks a feature when set):
`GEMINI_API_KEY`, `GOOGLE_CLIENT_ID/SECRET`, `DOCRAPTOR_API_KEY`,
`ARCHIDOC_BASE_URL` + `ARCHIDOC_SYNC_API_KEY` + `ARCHIDOC_WEBHOOK_SECRET`,
`ARCHISIGN_BASE_URL` + `ARCHISIGN_API_KEY` + `ARCHISIGN_WEBHOOK_SECRET`,
`ARCHITRAK_WEBHOOK_SECRET`, `DEFAULT_OBJECT_STORAGE_BUCKET_ID` + `PRIVATE_OBJECT_DIR`.
Full list with comments in `server/env.ts`.

### ⚠ Production safety flags
`ENABLE_DEV_LOGIN_FOR_E2E` and `E2E_FAKE_GMAIL` MUST be unset in production. The boot
sequence (`assertNoDevLoginBackdoorInProduction`) hard-fails if either is truthy with
`NODE_ENV=production`. Never propagate them to a deployed env.

## User preferences

- French domain terms preserved verbatim: Devis, Avenant, Marché, Certificat, Honoraires,
  Lot, Situation, Retenue de Garantie, PV/MV, TVA, SIRET. All other UI in English.
- Bilingual data fields: `description_fr` + `description_uk` for client communication.
- Projects ONLY enter the system via ArchiDoc sync — no manual project creation in UI.

## Core financial concepts

- **Three buckets**: Contracted, Certified, Reste à Réaliser.
- **Two invoicing modes**: Mode A (tick-off line items), Mode B (% completion).
- **Retenue de garantie**: 5% holdback.
- **PV/MV**: variation orders on signed marchés.
- **Fees**: works-percentage, conception, planning. Per-project `feePercentage`.
- All financial math goes through `shared/financial-utils.ts` (strict 2-decimal rounding).

## Inter-app contract gates (summary — full detail in `ARCHITECTURE.md`)

- **AT3 — Insurance sign-off gate**: live verdict from Archidoc, fired on PATCH crossing
  into `sent_to_client`. Mirror is advisory only; transient failures are overridable
  with audit row in `insurance_overrides`.
- **AT4 — Archisign envelope orchestration**: outbound `/envelopes/create` + `/envelopes/send`,
  inbound HMAC-v2 webhook (`/api/webhooks/archisign`) drives the devis sign-off lifecycle.
  The invitation-email rendering guarantee (§3.5.1.1 + `emailRendering` echo) is **IN FORCE
  since 2026-07-13** (Archisign countersigned rev2 on 2026-07-12; contract now v1.2, recorded
  as v1.4 in Archisign's lineage): `subject` guaranteed verbatim as a contiguous substring of
  the Subject header (Archisign firm-prefix framing permitted), `body` election RENDERED,
  echo shipped — `subjectApplied=false` triggers an operator warning. Open verification item:
  confirm the rendered body block on the next real envelope (our July 2026 inbox check
  disputed it — see contract §3.5.1 dispute note).
  A `subjectApplied: false` echo on /create is persisted as `devis.archisign_subject_drift_at`,
  and a `bodyApplied: false` echo for a sent (non-empty) body — a breach since Archisign's
  RENDERED election entered force — as `devis.archisign_body_drift_at` (both non-blocking).
  Both are surfaced as SigningPanel badges + send-time toasts + the read-only
  `/admin/ops/archisign-rendering-drift` page; each flag auto-clears on a fresh
  drift-free /create and is sealed against the generic devis PATCH.
- **AT5 — Outbound Architrak → Archidoc webhook delivery**: signed `/work-authorisations`
  delivery with retry orchestrator, DLQ at `/admin/ops/webhook-dlq`, UUIDv7 idempotency,
  canonical-form timestamps per contract §5.3.2.1.
- **Drive auto-upload (Task #198, feature-flagged OFF by default)**: every devis +
  facture PDF is mirrored into the Renosud shared Drive at
  `{project}/FINANCIAL/LIVE PROJECT FINANCIAL/1 DEVIS & FACTURE FOLDERS/{Lot} {project} {devisCode}`.
  ONE LOT → ONE FOLDER (all financial docs for that lot land alongside the original
  devis). AT5-style retry queue (`drive_uploads`), 5 attempts with backoff, DLQ at
  `/admin/ops/drive-uploads`. Service-account auth — set `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`,
  `GOOGLE_DRIVE_SHARED_DRIVE_ID`, then flip `DRIVE_AUTO_UPLOAD_ENABLED=true` to turn on.
  No backfill of pre-existing PDFs.

## Operations gotchas

- **Migrations are hand-tracked SQL** in `migrations/`. NEVER run `drizzle-kit push` or
  `npm run db:push` — it will desync the `drizzle.__drizzle_migrations` tracker.
  Generate via `npm run db:generate`, edit the SQL by hand if needed, then add an entry
  to both `migrations/meta/_journal.json` AND `server/operations/schema-presence-check.ts`.
- **Boot invariants**: `server/operations/schema-presence-check.ts` (every migration must
  declare a sentinel table/column) and `database-identity-guard` (refuses wrong DB).
- **Deep healthcheck** at `GET /healthz/deep` is unauthenticated, used by post-deploy smoke.
- **Migration replay gate**: `bash scripts/check-migration-replay.sh`.
- **Tracker drift recovery**: `npx tsx scripts/reconcile-drizzle-tracker.ts`.

## Contractor banking on certificats (Task #225)

Banking fields (`iban`, `bic`, `bankName`, `accountHolderName`,
`ribDocumentUrl`, `ribDocumentName`, `bankingVerifiedAt`,
`bankingVerifiedBy`, `bankingAiExtractedData`) live on both
`contractors` and the `archidoc_contractors` mirror — pushed in via
the existing ArchiDoc contractor sync. ArchiTrak is read-only for
these fields; edits happen in ArchiDoc. IBAN/BIC are revalidated
(`shared/iban.ts`, mod-97 + ISO 9362) on every sync write; invalid
values land as NULL rather than persisted garbage.

- **Certificat gate**: `generateCertificatPdf` throws
  `BankingDetailsMissingError` (no contractor IBAN) or
  `BankingMismatchError` (any active devis/invoice has an
  `extracted_iban` ≠ `contractor.iban` without an architect override
  in `banking_mismatch_overrides`). Routes translate to 422 with
  `code` + French `message` + `mismatches[]`; the FE shows a
  destructive toast.
- **Anti-fraud capture**: Gemini extracts IBAN/BIC from supplier
  PDFs (devis + invoices); `safeExtractIban/Bic` validate and
  normalise — invalid → NULL so the mismatch check never fires on
  garbage. Re-runs on every devis rescrape.
- **Portal whitelist**: `public-checks` / `public-client-checks` /
  `archisign-public` expose only `contractor.name`. Banking fields
  must never appear on any unauth surface — see the comment in
  `server/routes/public-checks.ts buildPortalPayload`.
- **RIB attachment**: `sendCertificat` fetches the RIB through the
  authenticated ArchiDoc proxy (`ARCHIDOC_BASE_URL`, same-host guard,
  30s timeout), mirrors to object storage, and appends to
  `attachmentStorageKeys`. Failure is non-fatal — the certificat
  itself always carries the IBAN block.

## Pennylane integration (Task #214, feature-flagged OFF by default)

Architect honoraires push from Outstanding Fees to Pennylane.
"Invoice fees now" → create Pennylane customer + customer_invoice → mirror
the PDF into Object Storage → auto-email the client via the architect's
Gmail. An hourly poller writes `paid_at` back when Pennylane reports the
invoice as paid. **Architect honoraires only** — no contractor / supplier
data is ever pushed.

- Three push kinds (`pennylane_pushes.kind`): `customer`, `customer_invoice`,
  `email_send`. Idempotent on `(kind, doc_id)`; chain is
  `customer → customer_invoice → email_send`. Sweeper every 60s, max 5
  attempts, exponential backoff (10s / 30s / 2m / 5m). Stale `in_flight`
  rows are reclaimed after 10 min.
- Paid-status poller (`server/services/pennylane/paid-poller.service.ts`)
  ticks hourly, GETs each unpaid invoice, writes back `pennylane_paid_at`
  + `pennylane_paid_amount` + `pennylane_status`.
- Env flags (all in `server/env.ts`): `PENNYLANE_API_KEY`,
  `PENNYLANE_BASE_URL` (defaults to v2 production — set to the sandbox host
  for testing), `PENNYLANE_PUSH_ENABLED` (default OFF), `PENNYLANE_DRY_RUN`
  (logs payload + writes sentinel `dry-run:…` ids; never hits the API),
  `PENNYLANE_PROJECT_WHITELIST` (CSV of project ids; absent = all allowed,
  empty string = kill-switch).
- Admin surfaces: `/admin/ops/pennylane-pushes` (DLQ + retry),
  `GET /api/admin/pennylane/me` (ping), `GET /api/pennylane/feature-flags`
  (unauthenticated-safe flag probe powering the UI button swap).
- Sandbox cleanup: `npx tsx scripts/pennylane-sandbox-cleanup.ts --confirm`
  — hard-refuses unless `PENNYLANE_BASE_URL` looks like sandbox/staging/test.

## Development protocols

- **Zero-tolerance TypeScript**: no `any`, no `@ts-ignore`, no `@ts-expect-error`.
- **API perimeter**: every route validates request shape with Zod via the
  `validateRequest` middleware. Single-tenant assumption (`@renosud.com`) — see the
  IDOR comment block at the top of `server/routes/index.ts` before adding multi-tenant features.
- **Errors**: never leak stack traces or raw DB errors to clients (global error handler).
- **Rate limiting**: token-bucket; configurable via `RATE_LIMIT_STORE` (memory|postgres).
