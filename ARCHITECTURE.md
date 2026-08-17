# ArchiTrak — Architecture Constitution

This document is the map of the system and the reasoning behind it: components, data flows, invariants, and the trade-offs that shaped them. Read it before starting any task. Every pattern described here is enforced by tests, code review, and convention. Deviating from these rules requires explicit sign-off — and for the sections marked constitutional, an ADR in `docs/decisions/`.

**Boundary with `replit.md`:** this file answers *"why does it work this way?"*. Commands, dev workflow, repo layout, and how-to recipes live in `replit.md`. Facts derivable from the code (table lists, index inventories, counts, env-var catalogs) are intentionally NOT duplicated here — the code is their single source of truth.

---

## 0. System Map

### Components

```
                 ┌────────────┐  one-way sync   ┌────────────┐
                 │  ArchiDoc  │ ───────────────▶│  ArchiTrak │◀── Google OAuth (@renosud.com)
                 │  (master:  │  webhooks/pull  │            │
                 │  projects, │                 │  Express 5 │──▶ DocRaptor (HTML→PDF)
                 │contractors,│◀────────────────│  + React   │──▶ Pennylane (architect fees only)
                 │   trades)  │  AT5 webhooks   │            │──▶ Google Drive (PDF mirror)
                 └────────────┘                 └─────┬──────┘
                 ┌────────────┐   envelopes /         │
                 │ Archisign  │◀── HMAC webhooks ────▶│        PostgreSQL (Drizzle, versioned migrations)
                 │(e-signature)│                       │        Replit Object Storage (all PDFs)
                 └────────────┘                 Gmail (send + monitored inbox)
```

### The three core data flows

1. **Document intake → financial record**: PDF arrives (Gmail monitor or manual upload) → Gemini structured extraction → deterministic validation cross-checks → record persisted as `draft` → architect reviews and confirms → `pending` → (invoices) approval triggers fee calculation. AI never commits financial data; a human always does (§1.2).
2. **Certificat → payment ledger**: devis/situations aggregate into a Certificat de Paiement → sealed issuance (immutable PDF + snapshot) → sent to client → payment evidence and confirmations recorded against an atomic, audited ledger.
3. **Master-data sync (one-way)**: projects, contractors, trades, proposal fees flow FROM ArchiDoc INTO ArchiTrak via signed webhooks (or legacy polling). ArchiTrak never writes these back (§4.1); its own outbound events to ArchiDoc travel a separate signed channel (AT5).

### Who masters what

| Data | Master | ArchiTrak's role |
|---|---|---|
| Projects, contractors, trades, proposal fees, contractor banking | ArchiDoc | Read-only mirror; re-validates on ingest |
| Devis, invoices, situations, certificats, fees | ArchiTrak | System of record |
| E-signature envelopes | Archisign | Initiates + mirrors status via webhooks |
| Architect fee invoices (honoraires) in the books | Pennylane | Pushes fee entries; polls paid status back |
| Document files (PDFs) | Object Storage | Canonical bytes; Drive holds convenience mirrors |

---

## 1. System Philosophy

### 1.1 Data Integrity First

No financial record (Devis, Invoice, Certificat, Fee) is committed to the database without passing through the financial calculation and validation layers.

**All financial math goes through `shared/financial-utils.ts`** — rounding, TVA/TTC, adjusted amounts, reste à réaliser, fees, French-locale formatting, and legal amounts in words. Every function applies `roundCurrency()` (2-decimal half-up via `Number.EPSILON`) before returning, guaranteeing 2-decimal precision at every step of a calculation chain.

**Never write inline arithmetic** like `ht * 1.2` or `Math.round(x * 100) / 100`. Always call the appropriate function. *Why:* floating-point drift compounds across chained calculations, and French accounting documents are legally exact to the centime — one path for rounding means one place to be correct.

**AI-extracted records** must additionally pass `validateExtraction()` (`server/services/extraction-validator.ts`) before database commit: HT+TVA=TTC consistency, TVA-vs-rate verification, auto-liquidation rules (rate and amount forced to 0), line-item sums, retenue-de-garantie reasonableness, net-à-payer derivation, and auto-correction of deterministically calculable missing values. It produces `isValid`, `warnings[]`, `correctedValues`, and a 0–100 `confidenceScore`.

### 1.2 Human-in-the-Loop

AI (Gemini) suggests data. A human must explicitly confirm it.

```
PDF → Gemini structured extraction → validateExtraction() cross-checks
    → record created as "draft" (with validationWarnings, aiExtractedData, aiConfidence)
    → architect reviews in DraftReviewPanel → explicit Confirm
    → draft → pending (→ approved for invoices, which triggers fee calculation)
```

Confirm endpoints enforce the `status === "draft"` precondition. *Why:* extraction is probabilistic; money movements are not. The draft state is the firewall between the two, and the status precondition makes confirmation idempotent and un-skippable.

**The architect NEVER creates invoices.** Invoices enter the system only via AI extraction (Gmail monitor or manual PDF upload). *Why:* every invoice must trace to a real contractor document; hand-created invoices would break that provenance.

### 1.3 Single-Firm Model

ArchiTrak serves one firm (SAS Architects-France, Cabrerolles — SIRET 953 443 918 00016, Ordre des Architectes Occitanie S24348). Its identity is hardcoded in certificats, email signatures, and PDF headers. There is no multi-tenant abstraction. *Why:* the single-tenant assumption is load-bearing — authorization is domain-level (`@renosud.com`), not row-level. Before adding anything multi-tenant, read the IDOR comment block at the top of `server/routes/index.ts`.

---

## 2. Structural Protocols

### 2.1 Service / Router Split

**Routers** (`server/routes/*.ts`) are thin HTTP handlers: parse/validate with Zod, call a service or storage method, return a response, wrap in try/catch.

**Services** (`server/services/*.service.ts`) contain business logic: orchestrate storage calls, calculations, and side effects; use `financial-utils` for all money math; return structured results; never import `express` or touch `req`/`res`.

**Never put calculation logic, multi-step orchestration, or storage calls directly in a router.** *Why:* services are testable without HTTP and reusable from workers/schedulers; routers that accrete logic become untestable and duplicate it across entry points (HTTP, webhook, cron).

### 2.2 Shared Schema — Single Source of Truth

`shared/schema.ts` defines all Drizzle tables, insert schemas (`createInsertSchema(table).omit(...)`), and both insert/select types. Client and server import the same types — the wire contract cannot drift from the database.

Conventions (each exists for a reason):
- Array columns: always `text().array()` — never `array(text())`.
- Lot numbers are TEXT (e.g. "FN", "GO", "VRD") — never integers; they are trade codes, not ordinals.
- Status fields use `text()`, no DB-level enums — valid values are enforced by application logic (and targeted CHECK constraints where money is at stake), because Postgres enum migrations are painful and statuses evolve.
- All currency columns are `numeric` with `{ precision: 12, scale: 2 }` — floats never touch money at rest.

### 2.2.1 Index and Constraint Policy

**Every foreign key column MUST have a corresponding index — non-negotiable.** PostgreSQL does not auto-index FK columns; without indexes, FK-filtered queries degrade to full table scans as data grows. The authoritative inventory of indexes and constraints is `shared/schema.ts` itself; the schema-drift gate (`scripts/check-schema-drift.sh`, run in CI and at build time) keeps the committed migrations in lockstep with it.

**Financial-state invariants are DB-enforced**, not merely validated in code: non-negativity CHECKs on invoice/situation/fee amounts, uniqueness on situation numbers per devis, at-most-one fee entry per invoice (idempotent approval), XOR subject constraints on advisories, webhook event-id primary keys (idempotency), and 1:1 unique mappings to ArchiDoc ids. *Why:* multiple code paths write financial state (HTTP, webhooks, workers, migrations); the database is the only layer they all share.

### 2.2.2 ON DELETE Policy

Child records follow a strict cascade/set-null/restrict policy, chosen per relationship:

| Pattern | ON DELETE | Rationale |
|---|---|---|
| Most `*.project_id` | `CASCADE` | Project deletion removes its children (but see the retention gate, §Operational Policies) |
| `email_documents.project_id` | `SET NULL` | Email evidence survives project deletion |
| `devis.lot_id`, `devis.marche_id`, `situations.invoice_id` | `SET NULL` | Financial records outlive organizational groupings |
| All `*.contractor_id` | `RESTRICT` | Contractors are ArchiDoc-mastered — never deletable while referenced |
| Owned children (`devis_line_items`, `avenants`, `invoices` → devis) | `CASCADE` | Lifetime bound to the parent document |

**When adding a new foreign key, you MUST also add an index on that column.**

### 2.3 Storage Interface

All database access goes through `IStorage` in `server/storage.ts` (interface → `DatabaseStorage` implementation → exported `storage` singleton). Routes and services never import `db` or Drizzle query builders directly. *Why:* one seam for every query makes cross-cutting concerns (transactions, locking discipline, test doubles) enforceable in review.

### 2.4 Authentication and Domain Restriction

- Google OAuth 2.0 via `google-auth-library` (no Passport).
- Domain restricted to `@renosud.com`, enforced at three layers: the Google `hd` parameter, a server-side email-suffix check in the callback, and a mandatory `email_verified`. *Why three layers:* the `hd` hint is client-influencable; defense in depth on the only tenant boundary the system has.
- Sessions in PostgreSQL (`connect-pg-simple`, 7-day cookie); session ID regenerated on login (fixation prevention).
- `requireAuth` on all `/api/*`; the only public paths are the auth endpoints and inbound webhooks (which carry their own HMAC auth, §4.2).

---

## 3. Strict Coding Rules

### 3.1 Math Guardrails

```typescript
// WRONG — floating-point drift
const ttc = ht * 1.2;
const rounded = Math.round(ttc * 100) / 100;

// CORRECT — use financial-utils
import { calculateTtc } from "@shared/financial-utils";
const ttc = calculateTtc(ht, 20);
```

### 3.2 Testing Requirements

- **All tests must stay green after every change** — the suite (Vitest unit/integration plus Playwright browser tests) is the regression floor; no change ships that turns any part of it red.
- Any new financial utility or validation function must land with its own test file beside the existing suites in `shared/__tests__/`.
- Commands and runner details live in `replit.md` (Dev workflow).

### 3.3 PDF Generation

All client-facing PDFs follow the `certificat-generator.ts` pattern: aggregate data server-side in a single pass → build a self-contained HTML string (no external CSS/JS) → DocRaptor (PrinceXML) → PDF buffer → Object Storage. *Why self-contained:* DocRaptor cannot fetch external URLs, so logos are base64 data URIs and styles are inline.

**PDF design tokens:** Navy `#0B2545` (headers, KPIs), Gold `#C1A27B` (accents, Reste à Réaliser), Background `#F8F9FA`, Charcoal `#34312D` (body), Grey `#7E7F83` (captions), Inter with system fallbacks.

**Print CSS:** `@page` for margins/running headers/counters; `page-break-before: always` for new sections; a single `<table>` per logical section with `<thead>`/`<tbody>`/`<tfoot>` — PrinceXML repeats `<thead>` per page and paginates tables natively, so never hand-calculate page breaks. PrinceXML ignores `display:grid` (renders stacked); use flexbox or tables. Compact sub-rows (avenants) stay grouped under their parent devis rather than getting their own tables — one table per devis breaks pagination at 50+ avenants.

### 3.4 Frontend Patterns

**Data fetching — TanStack Query v5**, object form with the pre-configured default `queryFn` and URL-segment array keys:

```typescript
const { data } = useQuery<MyType>({ queryKey: ["/api/projects", projectId, "fees"], enabled: !!projectId });
```

**Mutations** use `apiRequest` from `@/lib/queryClient` and invalidate the affected query keys on success.

**Forms:** shadcn `Form` + `react-hook-form` + `zodResolver` with insert schemas from `@shared/schema` — the same Zod objects the server validates with, so client and server can't disagree.

**Routing:** `wouter`; pages in `client/src/pages/`, registered in `App.tsx`. **Icons:** `lucide-react` for actions, `react-icons/si` for company logos.

**Test IDs:** `data-testid` on every interactive element (`button-submit`, `input-email`) and meaningful display element (`text-username`); dynamic elements append the entity id (`card-product-${id}`).

**Language rules:** French domain terms preserved verbatim (Devis, Avenant, Marché, Certificat, Honoraires, Lot, Situation, Retenue de Garantie, PV/MV, TVA, SIRET); all other UI text in English; no emoji anywhere.

**Express 5 rules:** no `*` wildcards in route paths; always validate `Number(req.params.id)` for NaN; wrap route handlers in try/catch.

---

## 4. Integration Guardrails

### 4.1 One-Way Sync — ArchiDoc is Master

Projects and Contractors flow FROM ArchiDoc TO ArchiTrak. Never the reverse. **Never create a Project manually in ArchiTrak.** *Why:* two writable masters for the same entities guarantees divergence; ArchiDoc owns firm-wide project identity, ArchiTrak owns only the financial layer on top of it.

Import happens via webhook push (default) to `POST /api/webhooks/archidoc`, or legacy API pull against `ARCHIDOC_BASE_URL`. The webhook event vocabulary covers created/updated/deleted for projects, contractors, trades, and proposal fees, plus a `sync.full` re-sync. `project.deleted` marks the project inactive rather than deleting (retention, §Operational Policies).

Polling is gated by `ARCHIDOC_POLLING_ENABLED` (default off — webhook mode). Gmail inbox scanning has its own independent flag (`GMAIL_POLLING_ENABLED`, default ON): the two were once coupled and switching ArchiDoc to webhooks silently killed Gmail scanning in production — they must never share a flag again.

### 4.2 Webhook Security

All inbound webhooks pass `server/middleware/webhook-auth.ts`: shared-secret presence check, `X-Archidoc-Signature: sha256=<hex>` HMAC-SHA256 over the **raw** request body, and a mandatory `X-Archidoc-Timestamp` with a 5-minute replay window (401 outside it). The raw body is captured via `express.json({ verify })` — HMAC over re-serialized JSON would be a different byte sequence.

### 4.3 AI Extraction Pipeline

Gemini structured output (`responseMimeType: "application/json"` + `responseSchema` — guarantees parseable JSON). The system prompt is an Expert-Comptable spécialisé BTP: it knows auto-liquidation de TVA (Art. 283-2 nonies CGI), retenue de garantie (Loi n°71-584), SIRET/RCS extraction, lot references, and the acompte-vs-situation distinction. Extraction feeds `validateExtraction()` and the draft→confirm workflow (§1.2) — never the database directly.

### 4.4 Gmail Integration

The connector provides send-only scope in production (no read access). The monitor detects 403 on first poll and pauses with a clear log message; label operations are conditionally skipped when permissions are insufficient. Extracted documents follow the same pipeline: parse → validate → draft → review.

### 4.5 Drive Mirroring (feature-flagged)

Every devis / facture / certificat PDF in object storage is mirrored into the Renosud shared Google Drive under `{project}/FINANCIAL/LIVE PROJECT FINANCIAL/1 DEVIS & FACTURE FOLDERS/{Lot} {project} {devisCode}/`.

**Invariants and their reasons:**

- **ONE LOT → ONE FOLDER** — all documents for a lot share a single Drive folder, its name seeded from the originating devis code so it stays canonical regardless of which document lands first.
- **Service-account auth only** (no domain-wide delegation; the SA itself is Editor on the shared drive). User OAuth is intentionally rejected so no individual operator's identity is on the audit trail.
- **Project root resolution is strict-exact-match-only** on the case/accent-normalised folder name; ambiguity (≥2 matches) is fatal and the operator must rename in Drive, then retry. The intermediate `FINANCIAL/...` folders must exist verbatim and are NEVER auto-created — silently creating structure would hide operator filing mistakes.
- **Per-lot advisory locks** serialise folder creation so concurrent uploads can't create duplicate folders before either has persisted the folder id.
- **Persistent retry queue with dead-letter** — bounded attempts with escalating backoff, then `dead_letter`; folder-not-found is treated as *transient* (the operator may simply not have created the client folder yet). Stale `in_flight` rows are reclaimed by a sweeper. Admin DLQ at `/admin/ops/drive-uploads`; retry is only permitted on `dead_letter`/`failed` rows — resetting `succeeded` would duplicate Drive copies, resetting `in_flight` would race the worker.
- **Feature flag default OFF** (`DRIVE_AUTO_UPLOAD_ENABLED`); when off, enqueue is a silent no-op so call sites don't gate themselves. No backfill of pre-existing PDFs.
- **Gmail-scrape ingestion**: a scraped PDF matched to a project is mirrored immediately under the project's `(unassigned-lot)` fallback (the lot isn't known until the operator promotes the draft); promotion enqueues a second, authoritative copy in the correct lot folder.
- **Credit notes (avoirs) are out of scope** until such a table exists; adding one requires a new doc kind in the upload queue service.

### 4.6 Object Storage

All documents live in Replit Object Storage behind `server/storage/object-storage.ts` (upload / buffer / stream / delete — see the module). Keys are structured as `/${bucket}/${PRIVATE_OBJECT_DIR}/projects/${projectId}/documents/${timestamp}_${safeName}`, with an `unmatched/documents/` prefix for documents that have no project yet. *Why keyed by project:* retention and access control operate on the project prefix (§Operational Policies).

### 4.7 Pennylane Outbound (feature-flagged)

Architect-honoraires-only outbound to Pennylane: the operator triggers a push on Outstanding Fees → an idempotent queue runs the `customer → customer_invoice → email_send` chain, mirrors the rendered PDF into Object Storage, and auto-emails the client via the architect's Gmail. An hourly poller writes paid status back.

**Scope guardrail (constitutional, non-negotiable):** Only the architect's `fee_entries` are pushable. Contractor-side data (`devis`, `factures`, `contractors`, `lots`) MUST never be mapped to a Pennylane customer or invoice — the architect is not the contractor's customer, and pushing supplier data would corrupt the firm's books. **Adding any new push kind requires an ADR in `docs/decisions/` + amendment of this section.**

**Idempotency is two-sided by design:** stable external ids (`architrak:client:project:{projectId}`, `architrak:fee_entry:{feeEntryId}`) make Pennylane's upsert-by-external-id the de-dup mechanism on their side; a `(kind, doc_id)` unique index is ours. Either side alone would leave a double-push window.

**Operational semantics that are easy to get wrong:**
- `PENNYLANE_PROJECT_WHITELIST`: **absent = all projects allowed; empty string = kill-switch (zero allowed).** Enforced at enqueue time, not sweep time — already-queued rows drain even if the whitelist tightens mid-flight.
- `PENNYLANE_DRY_RUN=true` runs the whole chain end-to-end writing `dry-run:{kind}:{docId}` sentinel ids, never contacting the API — for verifying mapping on real data with zero side effects.
- `PENNYLANE_PUSH_ENABLED` defaults OFF everywhere; the sweeper and paid-poller are not even scheduled when off. Enabling it without an API key is caught by the boot env validator.
- Admin DLQ at `/admin/ops/pennylane-pushes`; live ping and env-only feature-flag probes exist under `/api/admin/pennylane/*` and `/api/pennylane/feature-flags`.
- The sandbox cleanup script refuses to run against any base URL that isn't sandbox/staging/test.

Implementation lives under `server/services/pennylane/` (client, pure mappers, push-queue sweeper, paid poller).

### 4.8 Contractor Banking Wire Contract — ArchiDoc → ArchiTrak (v1)

Frozen 2026-05-27. Both sides pin the wire shape with symmetric fixture-based contract tests; those tests are the backstop, and the listed re-verify events are the ONLY triggers for a fresh inter-app check — no periodic re-verify.

**Endpoint** — `GET /api/sync/contractors[?since=<ISO8601>]` against `ARCHIDOC_BASE_URL`, bearer-authed with the single shared sync key (also used by the projects/trades/proposal-fees sync paths). On an invalid `since=`, ArchiDoc silently returns the full set — incremental sync never throws on a malformed timestamp.

**Banking block — exact key names** (nested under each contractor):

```jsonc
{
  "banking": {
    "accountHolderName":      "string",   // verbatim
    "iban":                   "string",   // pre-normalised; we re-validate (mod-97)
    "bic":                    "string",   // pre-normalised; we re-validate (ISO 9362)
    "bankName":               "string",
    "ribDocumentUrl":         "/objects/contractors/<contractorId>/<filename>",
    "ribDocumentName":        "string",
    "bankingVerifiedAt":      "ISO8601",  // PREFIXED — not `verifiedAt`
    "bankingVerifiedBy":      "string",   // PREFIXED — not `verifiedBy`
    "bankingAiExtractedData": { /* opaque */ }  // PREFIXED — not `aiExtractedData`
  }
}
```

The three audit fields use the **prefixed** form, mirroring ArchiDoc's column names — the short forms were once a silent NULL-coercer. The TypeScript interface in `server/archidoc/sync-client.ts` declares only the prefixed keys so the compiler enforces the contract; the fixture test pins the exact wire shape and fails CI on drift.

**Re-validation on persist** — IBAN/BIC are re-checked by `shared/iban.ts` before write. Anything failing validation lands as NULL, not persisted garbage; the certificat gate then refuses to issue — that refusal is the *intended* failure mode (bad banking data must block payment instructions, not flow into them).

**RIB proxy contract** — when `ribDocumentUrl` is present, certificat sending fetches it through ArchiDoc's `/objects/...` path with the shared bearer key (30s timeout, same-host guard). On ArchiDoc's side, the `/objects/*` sensitive-prefix gate MUST cover both `contractors/` and `insurance-certificates/` prefixes and force bearer auth on them — without that gate, RIB PDFs and insurance certificates would be publicly fetchable by URL. Success returns PDF bytes we mirror and attach; a miss is a structured JSON 404, never an HTML error page. RIB fetch failure is **non-fatal** — the certificat always carries the IBAN block; the RIB attachment is a convenience.

**Re-verify triggers (events, not calendar):** rename/type change of any `banking` field; a new field in the block (additive + null-by-default is non-breaking, but ping the other side); changes to IBAN/BIC validation rules; changes to the `/objects/*` sensitive-prefix gate or bearer scope; changes to any `/api/sync/*` path or its `?since=` semantics.

**Single-tenant invariant** — banking fields MUST NEVER appear on any unauthenticated surface (`public-checks`, `public-client-checks`, `archisign-public`); see the comment block in `server/routes/public-checks.ts`. A new public surface must explicitly whitelist only non-banking fields.

---

## 5. Directory Map

See `replit.md` → *Repo layout* for the authoritative directory structure. The structural rule this constitution adds: `shared/` is imported by BOTH client and server and must stay dependency-light; `server/routes/` stays thin per §2.1; and `docs/` holds inter-app contract specs and wire fixtures plus `docs/decisions/` for ADRs.

---

## 6. Environment Configuration

`server/env.ts` is the single, Zod-validated source of truth for every server-side environment variable — names, defaults, feature-scoping, and boot-time safety checks (dev-login backdoor refusal, misconfigured-ArchiDoc-host warning, alert-recipient warnings) are all defined and documented there. This document intentionally carries no env-var catalog.

Policies the code enforces and future changes must preserve:
- **Fail-fast, never leak**: invalid env aborts boot logging key *names* only, never values.
- **Required = boot-critical only** (`DATABASE_URL`, `SESSION_SECRET`); everything else is feature-scoped and its absence disables the feature rather than crashing.
- **Dev/test backdoors** (`ENABLE_DEV_LOGIN_FOR_E2E`, `E2E_FAKE_GMAIL`, `E2E_FAKE_GEMINI`) hard-fail boot in production.

---

## Operational Policies

### Database Migrations — decisions

- **Versioned migrations are the source of truth for schema state.** `migrations/` (SQL + drizzle journal) is committed; every shared environment converges on schema exclusively through those files, applied by `runMigrations()` at server start (before the HTTP listener binds) and by the post-merge hook.
- **`drizzle-kit push` is banned on shared databases** (dev, staging, production). It bypasses the migration journal and can drop columns silently, drifting the live schema away from what `runMigrations()` will reapply. It is allowed only against throwaway local scratch databases through a gated wrapper that refuses hosted-Postgres hosts.
- **Drift is caught twice**: the CI workflow on any PR touching schema/migrations, and again at the start of the deploy build — so a deploy from a branch that bypassed PR review still aborts if `shared/schema.ts` and committed migrations disagree. Both run `scripts/check-schema-drift.sh`.
- Deployment containers must ship `migrations/` alongside `dist/`; `RUN_MIGRATIONS_ON_START=false` exists for read-only replicas and one-off scripts.

Commands, scratch-DB recipes, and the journal/artifact checklist live in `replit.md` (→ *Migrations*).

### Document Retention (French Legal Requirements)

Per Code de commerce **L123-22** and LPF **L102 B**, accounting records are retained **10 years**: `invoices`, `certificats`, `situations`, accounting-record `email_documents`, `archidoc_sync_log`, and the source PDFs in Object Storage.

- Hard deletes on these tables happen only via deliberate, audited operator action — never automatic GC.
- **Project deletion is gated** by `server/services/project.service.ts#deleteProject`: in one transaction it row-locks the project, locks every devis (situations FK to devis, so this second lock blocks concurrent situation inserts), counts retained records, and only then deletes. Concurrent inserts of invoices/certificats/devis/situations wait on the FK key-share locks until commit — closing the check-then-delete TOCTOU window. Refusal surfaces as HTTP 409 `PROJECT_RETENTION_BLOCKED` with the retained counts.
- Object Storage lifecycle rules MUST never auto-expire the private document prefixes.

### Concurrency & Idempotency

- **Invoice approval** runs in a single transaction with `SELECT ... FOR UPDATE` on the invoice row, idempotent via the one-fee-entry-per-invoice partial unique index.
- **Advisory reconciliation** locks per subject and is append-only for resolved/acknowledged history.
- **Inbound webhooks** are idempotent by event id (from the payload when present, otherwise derived as a hash of event+timestamp+data).

The general rule: any mutation that moves money or fires an external side effect must be (a) transactional with explicit row locks, and (b) idempotent under replay. Check-then-write without a lock is rejected in review.

### Logging & Observability

- Every API request gets an `X-Request-Id` (random UUIDv4 unless the caller supplied a sane one), echoed to the client and recorded in the access log.
- Access logs never include response bodies — financial payloads, extracted email content, and contractor PII must not leak into stdout/log aggregators.
- Mutating endpoints log `userId` only; sensitive fields are never logged.

### Rate Limiting

In-process token-bucket limits (`server/middleware/rate-limit.ts`) at three tiers: strictest on unauthenticated webhook paths, tight on upload endpoints (each upload triggers expensive AI extraction), and a belt-and-braces guard on all other `/api/*`. Keys derive from the authenticated `userId` when available, else the `X-Forwarded-For`-aware client IP. Exact budgets live in the middleware.

### File Upload Validation

`server/middleware/upload.ts` enforces PDF-only uploads: MIME check, `.pdf` extension, a `%PDF` magic-byte check in the upload service before extraction (extension and MIME are client-controlled; bytes are not), a hard size cap, and one file per request.

---

## Amendments

Sections marked **constitutional** (e.g. the Pennylane scope guardrail, the banking single-tenant invariant) change only via an ADR in `docs/decisions/` plus an amendment to this document. For anything else, keep the boundary: if a change only touches *how* something is done, update the code and `replit.md`; update this file only when the *shape or reasoning* of the system changes.
