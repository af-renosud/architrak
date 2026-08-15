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
- **DB**: PostgreSQL 16 + Drizzle ORM (`shared/schema.ts`), hand-tracked SQL migrations
- **AI**: Google Gemini (`@google/generative-ai`) for PDF extraction
- **Storage**: Replit Object Storage (GCS-backed) for PDFs and uploads
- **External services**: ArchiDoc, Archisign, DocRaptor (HTML→PDF), Gmail API, Pennylane
- **Auth**: Google Workspace OAuth 2.0 (`@renosud.com` domain-restricted)
- **Tests**: Vitest (unit + integration), Playwright (browser, in `tests/browser/`)

## Repo layout

```
client/        React app (entry: client/src/main.tsx)
server/        Express app (entry: server/index.ts)
  routes/      Domain routes (mounted by routes/index.ts)
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
PUBLIC_BASE_URL=http://localhost:5000 E2E_FAKE_GMAIL=true ENABLE_DEV_LOGIN_FOR_E2E=true npm run dev
```
Server on port **5000** (Vite mounted on the same port). `E2E_FAKE_GMAIL=true` short-circuits
outbound Gmail to an in-memory fake — real send won't fire locally.

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server (tsx watch) |
| `npm run check` | TypeScript type-check (no emit) |
| `npm run build` | Production bundle (`script/build.ts` → `dist/`) |
| `npm run prepublish-check` | **Run before each publish** — dependency audit, type check, schema-drift check, production build, safe smoke boot of `dist/index.cjs` |
| `npm run start` | Run production bundle |
| `npm run db:generate` | Generate a new Drizzle migration |
| `npx tsx scripts/run-migrations.mjs` | Apply migrations (also runs at deploy) |
| `npx vitest` | Unit + integration tests |
| `npx playwright test` | Browser e2e |

## Environment variables

Validated via Zod in `server/env.ts` — server refuses to boot on invalid/missing required vars.
**Required**: `DATABASE_URL`, `SESSION_SECRET`. Everything else is feature-scoped (each
unlocks a feature when set) — full list with comments in `server/env.ts`.

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
- **Retenue de garantie**: 5% holdback. **PV/MV**: variations on signed marchés.
- **Fees**: works-percentage, conception, planning. Per-project `feePercentage`.
- All financial math goes through `shared/financial-utils.ts` (strict 2-decimal rounding).

## Inter-app contract gates (full detail in `ARCHITECTURE.md`)

- **AT3 — Insurance sign-off gate**: live Archidoc verdict on PATCH into `sent_to_client`;
  mirror advisory only; overrides audited in `insurance_overrides`.
- **AT4 — Archisign envelopes**: outbound create/send + HMAC-v2 webhook drives devis
  sign-off. Email-rendering guarantee (§3.5.1.1) is IN FORCE: subject verbatim substring,
  body RENDERED, echo persisted as drift flags (`archisign_subject/body_drift_at`,
  non-blocking, surfaced in SigningPanel + `/admin/ops/archisign-rendering-drift`).
- **AT5 — Architrak → Archidoc webhooks**: signed delivery, retry orchestrator,
  DLQ at `/admin/ops/webhook-dlq`, UUIDv7 idempotency.
- **Drive auto-upload** (flag OFF by default): devis/facture PDFs mirrored to the shared
  Drive, ONE LOT → ONE FOLDER, retry queue + DLQ at `/admin/ops/drive-uploads`.

## Key invariants (pointers, not spec — read the named files before touching)

- **Certificat issuance seal**: previews persist nothing; issue/send goes through
  `server/services/certificat-seal.service.ts` (version-guarded, idempotent, pins
  `pdfStorageKey` + `issuanceSnapshot` and writes `certificat_sources` in ONE tx).
  Sealed = locked: PATCH allows only `status`/`notes` (409 `CERTIFICAT_SEALED`);
  corrections = reissue. `GET /api/certificats/:id/pdf` serves pinned bytes only.
- **Acompte certificats** (deposit without supplier invoice): `certificats.acompteDevisId`
  marks them; they are excluded from ALL waterfall/prior-cumulative math, never
  re-resolved at seal, and money-locked against PATCH. All invoice-linking goes through
  `linkAcompteInvoiceTx` in `server/services/acompte.service.ts` (mutual exclusion with
  the no-invoice path, devis row lock).
- **Contractor banking**: read-only in ArchiTrak (edited in ArchiDoc, revalidated on
  sync via `shared/iban.ts`). Certificat generation hard-fails on missing IBAN or
  unoverridden IBAN mismatch (422). Banking fields must NEVER appear on unauth
  surfaces — see `server/routes/public-checks.ts buildPortalPayload`.
- **Pennylane honoraires push** (flag OFF by default): architect fees only, idempotent
  push chain + hourly paid-poller; admin at `/admin/ops/pennylane-pushes`; sandbox
  cleanup script refuses non-sandbox hosts. Flags in `server/env.ts`.

## Operations gotchas

- **Migrations are hand-tracked SQL** in `migrations/`. NEVER run `drizzle-kit push` or
  `npm run db:push` — it will desync the `drizzle.__drizzle_migrations` tracker.
  Every new migration needs: the SQL file, a `migrations/meta/_journal.json` entry, AND
  a `MIGRATION_ARTIFACTS` entry in `server/operations/schema-presence-check.ts`.
- **Boot invariants**: schema-presence-check (sentinel per migration) and
  database-identity-guard (refuses wrong DB).
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
