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
- **DB**: PostgreSQL 16 + Drizzle ORM (53 application tables in `shared/schema.ts` + 1 identity-guard sentinel, 32 hand-tracked SQL migrations)
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
- **AT5 — Outbound Architrak → Archidoc webhook delivery**: signed `/work-authorisations`
  delivery with retry orchestrator, DLQ at `/admin/ops/webhook-dlq`, UUIDv7 idempotency,
  canonical-form timestamps per contract §5.3.2.1.

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

## Development protocols

- **Zero-tolerance TypeScript**: no `any`, no `@ts-ignore`, no `@ts-expect-error`.
- **API perimeter**: every route validates request shape with Zod via the
  `validateRequest` middleware. Single-tenant assumption (`@renosud.com`) — see the
  IDOR comment block at the top of `server/routes/index.ts` before adding multi-tenant features.
- **Errors**: never leak stack traces or raw DB errors to clients (global error handler).
- **Rate limiting**: token-bucket; configurable via `RATE_LIMIT_STORE` (memory|postgres).
