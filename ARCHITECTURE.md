# ArchiTrak — Architecture Constitution

This document is the immutable reference for all ArchiTrak development. Read it before starting any task. Every pattern described here is enforced by tests, code review, and convention. Deviating from these rules requires explicit sign-off.

---

## 1. System Philosophy

### 1.1 Data Integrity First

No financial record (Devis, Invoice, Certificat, Fee) is committed to the database without passing through the financial calculation and validation layers.

**Financial calculations** use `shared/financial-utils.ts` exclusively:

| Function | Purpose |
|---|---|
| `roundCurrency(value)` | 2-decimal half-up rounding via `Number.EPSILON`. Use for ALL currency values |
| `calculateTva(amountHt, tvaRate)` | TVA = HT * rate / 100, rounded |
| `calculateTtc(amountHt, tvaRate)` | TTC = HT + TVA, rounded |
| `calculateHtFromTtc(amountTtc, tvaRate)` | Reverse: HT = TTC / (1 + rate/100), rounded |
| `calculateAdjustedAmount(originalHt, pvTotal, mvTotal)` | Adjusted = Original + PV - MV, rounded |
| `calculateResteARealiser(adjustedHt, certifiedHt)` | Remaining = Adjusted - Certified, rounded |
| `calculateFeeAmount(invoiceHt, feeRate)` | Fee = Invoice * rate / 100, rounded |
| `calculateFeeTtc(feeAmountHt, tvaRate)` | Fee TTC, rounded |
| `formatCurrencyEur(value)` | French locale EUR format with currency style (e.g. "1 234,56 EUR") |
| `formatCurrencyNoSymbol(value)` | French locale 2-decimal format + " \u20AC" suffix (e.g. "1 234,56 \u20AC") |
| `numberToFrenchWords(n)` | Legal amount in French words (e.g. "MILLE DEUX CENT EUROS") |

**Never write inline arithmetic** like `ht * 1.2` or `Math.round(x * 100) / 100`. Always call the appropriate function above.

**AI-extracted records** must additionally pass `validateExtraction()` from `server/services/extraction-validator.ts` before database commit. This runs 7 cross-checks:

1. HT + TVA = TTC consistency (tolerance: 0.01 EUR)
2. TVA amount verification against rate
3. Auto-liquidation rules (if `autoLiquidation === true`, tvaRate and tvaAmount must be 0)
4. Line items sum vs amountHt (tolerance: 1.00 EUR)
5. Retenue de garantie reasonableness (~5% of TTC)
6. Net-a-payer = TTC - retenue de garantie
7. Auto-correction of deterministically calculable missing values

The validator produces a `ValidationResult` with `isValid`, `warnings[]`, `correctedValues`, and `confidenceScore` (0-100).

### 1.2 Human-in-the-Loop

AI (Gemini) suggests data. A human must explicitly confirm it.

```
PDF Upload
  -> Gemini structured extraction (Expert-Comptable BTP prompt)
  -> validateExtraction() cross-checks
  -> Record created as status "draft"
     (with validationWarnings, aiExtractedData, aiConfidence columns)
  -> Architect reviews in DraftReviewPanel (editable fields, warning badges)
  -> Architect clicks "Confirm"
  -> Status transitions: draft -> pending
  -> For invoices: pending -> approved (separate step, triggers fee calculation)
```

Confirm endpoints enforce `status === "draft"` precondition:
- `POST /api/devis/:id/confirm` — optional body with corrected values, re-validates, moves to "pending"
- `POST /api/invoices/:id/confirm` — same pattern, then existing approval flow applies

The architect NEVER creates invoices. Invoices enter the system only via AI extraction (Gmail monitor or manual PDF upload).

### 1.3 Single-Firm Model

ArchiTrak serves one firm. Its identity is hardcoded:

```
SAS Architects-France
2 Route d'Aigues-Vives, 34480 Cabrerolles
SIRET: 953 443 918 00016
Order of Architects Occitanie: S24348
```

All Certificats de Paiement, email signatures, and PDF headers reference this firm. There is no multi-tenant abstraction.

---

## 2. Structural Protocols

### 2.1 Service / Router Split

**Routers** (`server/routes/*.ts`) are thin HTTP handlers. They:
- Parse and validate request params/body using Zod schemas from `drizzle-zod`
- Call a service function or a storage method
- Return the response with appropriate status code
- Wrap in try/catch with descriptive error messages

**Services** (`server/services/*.service.ts`) contain business logic. They:
- Orchestrate storage calls, calculations, and side effects
- Use `roundCurrency()` and friends for all financial math
- Return structured results (not HTTP responses)
- Never import `express` or touch `req`/`res`

**Never put calculation logic, multi-step orchestration, or storage calls directly in a router.**

### 2.2 Shared Schema — Single Source of Truth

`shared/schema.ts` defines everything:
- Drizzle ORM table definitions (all tables)
- Insert schemas via `createInsertSchema(table).omit({ id: true, createdAt: true })`
- Insert types via `z.infer<typeof insertSchema>`
- Select types via `typeof table.$inferSelect`

Rules:
- Array columns: always `text().array()` — never `array(text())`
- Lot numbers are TEXT (e.g. "FN", "GO", "VRD", "EL") — never integers
- Status fields use `text()` — no DB-level enums. Valid values are enforced by application logic
- All `numeric` columns use `{ precision: 12, scale: 2 }` for currency

### 2.2.1 Index and Constraint Policy

**Every foreign key column MUST have a corresponding index.** PostgreSQL does not auto-index FK columns. Without indexes, queries filtering by FK degrade to full table scans as data grows.

Current indexes (26 custom indexes across all tables):

| Table | Index | Columns |
|---|---|---|
| lots | `lots_project_id_idx` | `project_id` |
| marches | `marches_project_id_idx` | `project_id` |
| marches | `marches_contractor_id_idx` | `contractor_id` |
| devis | `devis_project_id_idx` | `project_id` |
| devis | `devis_contractor_id_idx` | `contractor_id` |
| devis_line_items | `devis_line_items_devis_id_idx` | `devis_id` |
| avenants | `avenants_devis_id_idx` | `devis_id` |
| invoices | `invoices_project_id_idx` | `project_id` |
| invoices | `invoices_devis_id_idx` | `devis_id` |
| invoices | `invoices_contractor_id_idx` | `contractor_id` |
| situations | `situations_devis_id_idx` | `devis_id` |
| situation_lines | `situation_lines_situation_id_idx` | `situation_id` |
| situation_lines | `situation_lines_devis_line_item_id_idx` | `devis_line_item_id` |
| certificats | `certificats_project_contractor_idx` | `(project_id, contractor_id)` composite |
| fees | `fees_project_id_idx` | `project_id` |
| fee_entries | `fee_entries_fee_id_idx` | `fee_id` |
| email_documents | `email_documents_project_id_idx` | `project_id` |
| email_documents | `email_documents_extraction_status_idx` | `extraction_status` |
| project_documents | `project_documents_project_id_idx` | `project_id` |
| project_documents | `project_documents_source_email_doc_idx` | `source_email_document_id` |
| project_communications | `project_communications_project_id_idx` | `project_id` |
| payment_reminders | `payment_reminders_project_id_idx` | `project_id` |
| payment_reminders | `payment_reminders_status_date_idx` | `(status, scheduled_date)` composite |
| client_payment_evidence | `client_payment_evidence_project_id_idx` | `project_id` |
| messages | `messages_conversation_id_idx` | `conversation_id` |
| session | `sessions_expire_idx` | `expire` |

Unique constraints enforcing data integrity:

| Table | Constraint | Columns | Rationale |
|---|---|---|---|
| projects | `projects_archidoc_id_unique` | `archidoc_id` | 1:1 mapping with ArchiDoc |
| contractors | `contractors_archidoc_id_unique` | `archidoc_id` | 1:1 mapping with ArchiDoc |
| lots | `lots_project_lot_unique` | `(project_id, lot_number)` | No duplicate lot numbers per project |
| certificats | `certificats_project_ref_unique` | `(project_id, certificate_ref)` | No duplicate certificate refs per project |
| archidoc_proposal_fees | `archidoc_proposal_fees_project_unique` | `archidoc_project_id` | One fee record per ArchiDoc project |

### 2.2.2 ON DELETE Policy

Child records follow a strict cascade/set-null policy:

| FK Column | ON DELETE | Rationale |
|---|---|---|
| `*.project_id` (most tables) | `CASCADE` | When a project is deleted, all child records are removed |
| `email_documents.project_id` | `SET NULL` | Email docs survive project deletion (nullable FK) |
| `devis.lot_id` | `SET NULL` | Devis records survive lot deletion |
| `devis.marche_id` | `SET NULL` | Devis records survive marche deletion |
| `situations.invoice_id` | `SET NULL` | Situations survive invoice deletion |
| `*.contractor_id` (all tables) | `RESTRICT` (default) | Contractors are ArchiDoc-mastered — cannot be deleted if referenced |
| `devis_line_items.devis_id` | `CASCADE` | Line items are owned by devis |
| `avenants.devis_id` | `CASCADE` | Avenants are owned by devis |
| `invoices.devis_id` | `CASCADE` | Invoices are owned by devis |

**When adding a new foreign key, you MUST also add an index on that column.** This is non-negotiable.

### 2.3 Storage Interface

All database access goes through `IStorage` defined in `server/storage.ts`. Routes and services never import `db` or Drizzle query builders directly.

To add a new query:
1. Add the method signature to the `IStorage` interface
2. Implement it in the `DatabaseStorage` class below
3. Use it via the exported `storage` singleton

### 2.4 Authentication and Domain Restriction

- Google OAuth 2.0 via `google-auth-library` (no Passport)
- Domain restricted to `@renosud.com` — enforced at three layers:
  1. Google `hd` parameter in auth URL
  2. Server-side email suffix check in callback
  3. `email_verified` must be true
- Session stored in PostgreSQL via `connect-pg-simple` (7-day cookie)
- Session ID regenerated on login (prevents fixation)
- `requireAuth` middleware on all `/api/*` routes
- Public paths (no auth required): `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/user`, `/webhooks/archidoc`

---

## 3. Strict Coding Rules

### 3.1 Math Guardrails

```typescript
// WRONG — floating-point drift
const ttc = ht * 1.2;
const rounded = Math.round(ttc * 100) / 100;

// CORRECT — use financial-utils
import { calculateTtc, roundCurrency } from "@shared/financial-utils";
const ttc = calculateTtc(ht, 20);
```

Every function in `financial-utils.ts` applies `roundCurrency()` before returning. This guarantees 2-decimal precision at every step of a calculation chain.

### 3.2 Testing Requirements

- **Framework**: Vitest 4.x with path aliases (`@shared/*`, `@/*`)
- **Run**: `npx vitest run` (all tests) or `npx vitest` (watch mode)
- **Scope**: `shared/__tests__/**/*.test.ts`
- **Current test count**: 119 tests across 3 files:
  - `financial-utils.test.ts` — 46 tests (rounding, TVA/TTC, Three Buckets, fees, formatting)
  - `number-to-french-words.test.ts` — 49 tests (French number conversion)
  - `extraction-validator.test.ts` — 24 tests (cross-checks, auto-correction, confidence)
- **Rule**: All 119 tests must remain green after every change. Any new financial utility or validation function must have a corresponding test file.

### 3.3 PDF Generation

All client-facing PDFs follow the `certificat-generator.ts` pattern:

1. Aggregate data server-side in a single pass
2. Build a self-contained HTML string (no external CSS/JS)
3. Send to DocRaptor API (`server/services/docraptor.ts`) which uses PrinceXML
4. Receive PDF buffer, upload to Object Storage

**Design system for PDFs:**

| Token | Value | Usage |
|---|---|---|
| Navy | `#0B2545` | Headers, titles, KPI values, table headers |
| Gold | `#C1A27B` | Accent bars, borders, highlights, Reste a Realiser |
| Background | `#F8F9FA` | Zebra rows, party cards, info boxes |
| Charcoal | `#34312D` | Body text |
| Grey | `#7E7F83` | Labels, captions, footers |
| Font | Inter | All text (with system fallbacks) |

**Print CSS rules:**
- `@page` for margins, running headers/footers, page counters
- `page-break-before: always` for new sections (e.g. Financial Annexe)
- Single `<table>` with `<thead>` / `<tbody>` / `<tfoot>` — PrinceXML repeats `<thead>` on each page automatically
- Font sizes: 7pt for table content, 6.5pt for avenant sub-rows, 14pt for KPI values
- Logos embedded as base64 data URIs (DocRaptor cannot fetch external URLs)

**Scaling for large documents (50+ avenants):**
- Use one `<table>` per logical section, not one per devis
- Avenant sub-rows are compact (6.5pt, 3px padding) and grouped under parent devis
- PrinceXML handles table pagination natively — no manual page-break calculations needed

### 3.4 Frontend Patterns

**Data fetching — TanStack Query v5:**
```typescript
// CORRECT — object form, default queryFn, array key segments
const { data, isLoading } = useQuery<MyType>({
  queryKey: ["/api/projects", projectId, "fees"],
  enabled: !!projectId,
});

// WRONG — custom queryFn (default is already configured)
const { data } = useQuery({
  queryKey: ["fees"],
  queryFn: () => fetch("/api/fees").then(r => r.json()),
});
```

**Mutations:**
```typescript
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";

const mutation = useMutation({
  mutationFn: (data: InsertFee) => apiRequest("POST", "/api/fees", data),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fees"] }),
});
```

**Forms:** shadcn `Form` + `react-hook-form` + `zodResolver` with insert schemas from `@shared/schema`.

**Routing:** `wouter` — pages in `client/src/pages/`, registered in `App.tsx`.

**Icons:** `lucide-react` for actions, `react-icons/si` for company logos.

**Test IDs:** `data-testid` on every interactive element (`button-submit`, `input-email`) and meaningful display element (`text-username`, `status-payment`). Dynamic elements append unique ID: `card-product-${id}`.

**Language rules:**
- French domain terms preserved: Devis, Avenant, Marche, Certificat, Honoraires, Lot, Situation, Retenue de Garantie, PV/MV, TVA, SIRET
- All other UI text in English
- No emoji anywhere

**Express 5 rules:**
- No `*` wildcards in route paths
- Always validate `Number(req.params.id)` for NaN before use
- Wrap route handlers in try/catch

---

## 4. Integration Guardrails

### 4.1 One-Way Sync — ArchiDoc is Master

Projects and Contractors flow FROM ArchiDoc TO ArchiTrak. Never the reverse.

**Never create a Project manually in ArchiTrak.** All projects originate in ArchiDoc and are imported via:
- Webhook push (default mode): ArchiDoc sends events to `POST /api/webhooks/archidoc`
- API pull (legacy mode): ArchiTrak polls `ARCHIDOC_BASE_URL` endpoints

**13 webhook event types:**

| Event | Action |
|---|---|
| `project.created` / `project.updated` | Upsert project from ArchiDoc data |
| `project.deleted` | Mark project inactive |
| `contractor.created` / `contractor.updated` | Upsert contractor |
| `contractor.deleted` | Remove contractor |
| `trade.created` / `trade.updated` | Upsert trade/lot |
| `trade.deleted` | Remove trade |
| `proposal_fee.created` / `proposal_fee.updated` | Upsert proposal fee |
| `proposal_fee.deleted` | Remove proposal fee |
| `sync.full` | Full re-sync of all data |

**Environment controls:**
- `ARCHIDOC_POLLING_ENABLED=true` — re-enables legacy polling (default: disabled, webhook mode)
- `ARCHIDOC_BASE_URL` — ArchiDoc API base URL
- `ARCHIDOC_SYNC_API_KEY` — API key for pull-mode sync

### 4.2 Webhook Security

All inbound webhooks pass through `server/middleware/webhook-auth.ts`:

1. **Secret check**: `ARCHIDOC_WEBHOOK_SECRET` must be configured
2. **Signature verification**: Header `X-Archidoc-Signature: sha256=<hex>` — HMAC-SHA256 of raw request body using the shared secret
3. **Timestamp replay protection**: `X-Archidoc-Timestamp` header is MANDATORY. Tolerance: 5 minutes. Requests outside window are rejected with 401

The raw body is captured via `express.json({ verify })` callback and stored on `req.rawBody` for HMAC computation.

### 4.3 AI Extraction Pipeline

**Gemini structured output:**
- `responseMimeType: "application/json"` with `responseSchema` — guarantees valid JSON
- System prompt: Expert-Comptable specialise BTP (French Construction Accountant)
- Knows: Auto-liquidation de TVA (Article 283-2 nonies CGI), Retenue de Garantie (Loi n 71-584), SIRET/RCS extraction, lot references, Acompte vs Situation distinction
- Extracts 20+ fields: invoiceNumber, devisNumber, siret, autoLiquidation, retenueDeGarantie, netAPayer, paymentTerms, lotReferences, lineItems, amounts

**After extraction:**
1. `validateExtraction()` cross-checks all amounts
2. Record created as `draft` with `validationWarnings` (jsonb), `aiExtractedData` (jsonb), `aiConfidence` (integer 0-100)
3. DraftReviewPanel displays editable fields with validation badges
4. Architect confirms or discards

### 4.4 Gmail Integration

- Connector provides send-only scope (no read access in production)
- Monitor detects 403 on first poll attempt, pauses with clear log message
- Label operations (categorizing processed emails) conditionally skipped when permissions are insufficient
- Extracted documents follow the same AI pipeline: parse -> validate -> draft -> review

### 4.5 Object Storage

All documents stored in Replit Object Storage via `server/storage/object-storage.ts`:

| Function | Purpose |
|---|---|
| `uploadDocument(projectId, fileName, buffer, contentType)` | Upload, returns storage key |
| `getDocumentBuffer(storageKey)` | Download as Buffer |
| `getDocumentStream(storageKey)` | Download as Readable stream + metadata |
| `deleteDocument(storageKey)` | Delete from bucket |

**Key structure:** `/${bucketName}/${PRIVATE_OBJECT_DIR}/projects/${projectId}/documents/${timestamp}_${safeName}`

Unmatched documents (no projectId): `/${bucketName}/${PRIVATE_OBJECT_DIR}/unmatched/documents/${timestamp}_${safeName}`

---

## 5. Directory Map

```
client/src/
  pages/              — Route-level page components
  components/         — Reusable UI components (dashboard/, devis/, factures/, etc.)
  hooks/              — Custom hooks (use-auth, use-toast, use-mobile)
  lib/                — queryClient, utils
server/
  auth/               — Google OAuth: google-oauth.ts, routes.ts, middleware.ts
  routes/             — Thin HTTP routers (16 files)
    index.ts          — Router registration
    projects.ts, contractors.ts, marches.ts, lots.ts
    devis.ts, invoices.ts, situations.ts
    certificats.ts, fees.ts, financial.ts
    dashboard.ts, export.ts
    archidoc.ts, gmail.ts, documents.ts
    communications.ts, settings.ts, webhooks.ts
    benchmarks.ts       — Cost benchmark library (search, upload, edit/delete)
  services/           — Business logic (no HTTP concerns)
    devis-upload.service.ts, invoice-upload.service.ts
    extraction-validator.ts
    invoice-approval.service.ts, fee-calculation.service.ts
    financial-summary.service.ts, dashboard.service.ts
    bulk-export.service.ts, webhook.service.ts
    docraptor.ts
  archidoc/           — ArchiDoc sync: sync-client, sync-service, import-service
  gmail/              — Gmail monitoring: client, monitor, document-parser
  communications/     — certificat-generator, email-sender, payment-scheduler
  middleware/         — webhook-auth.ts (HMAC verification)
  storage/            — object-storage.ts (Replit Object Storage wrapper)
shared/
  schema.ts           — Drizzle tables + Zod schemas + types (single source of truth)
  financial-utils.ts  — Pure financial functions (roundCurrency, TVA, TTC, formatting)
  __tests__/          — Vitest test files (119 tests)
```

---

## 6. Environment Secrets

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (auto-configured by Replit) |
| `SESSION_SECRET` | Express session encryption key |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret |
| `GEMINI_API_KEY` | Google Gemini API key for AI document extraction |
| `DOCRAPTOR_API_KEY` | DocRaptor API key for HTML-to-PDF conversion |
| `ARCHIDOC_BASE_URL` | ArchiDoc API base URL for project sync |
| `ARCHIDOC_SYNC_API_KEY` | ArchiDoc API authentication key |
| `ARCHIDOC_WEBHOOK_SECRET` | HMAC-SHA256 shared secret for webhook signature verification |
| `ARCHIDOC_POLLING_ENABLED` | Set to `"true"` to enable legacy polling (default: webhook mode) |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | Replit Object Storage bucket identifier |
| `PRIVATE_OBJECT_DIR` | Object Storage directory prefix for private documents |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Object Storage public asset search paths |

## Operational Policies

### Database Migrations

The repo uses **versioned migrations** as the source of truth for schema state, with `drizzle-kit push` available for fast local iteration only.

**File layout**

- `migrations/` — generated SQL migration files, committed to source control
- `migrations/meta/` — drizzle's snapshot + journal (DO NOT hand-edit)
- `migrations/0000_baseline.sql` — initial baseline captured from the live schema

**Workflow for schema changes**

1. Edit `shared/schema.ts`.
2. Generate a new migration file:
   ```
   npx drizzle-kit generate --name <change-summary>
   ```
   Review the SQL diff, commit both the new `NNNN_*.sql` and the updated `migrations/meta/` files.
3. Locally, apply with `npx drizzle-kit migrate` (or restart the server — see below).
4. `npm run db:push` remains available for throwaway prototyping against a scratch DB. It must **NOT** be run against staging or production because it bypasses migration history and can drop columns silently.

**Application at deploy / start time**

`server/index.ts` calls `runMigrations()` (see `server/migrate.ts`) before binding the HTTP listener. This uses drizzle-orm's `node-postgres` migrator to apply any pending files from the `migrations/` folder against `DATABASE_URL`. On a fresh database, the baseline migration creates every table/index/constraint; on an existing database, drizzle's `__drizzle_migrations` table tracks what's been applied and only new entries run.

- The behavior can be disabled by setting `RUN_MIGRATIONS_ON_START=false` (useful for read-only replicas or one-off scripts).
- The migrations folder location can be overridden with `MIGRATIONS_FOLDER`; otherwise it resolves to `<cwd>/migrations`.
- Deployment containers must ship the `migrations/` directory alongside `dist/`. The autoscale deployment includes the full repo, so no extra build step is required.

**CI gate**

The GitHub Actions workflow `.github/workflows/schema-drift.yml` runs on every PR that touches `shared/schema.ts`, `migrations/`, or `drizzle.config.ts`. It executes `scripts/check-schema-drift.sh`, which runs `npx drizzle-kit generate` and fails if any new SQL file or `migrations/meta/` change is produced — i.e. the committed migrations are out of sync with the schema. To fix a failing run locally, run `npx drizzle-kit generate --name <change-summary>` and commit the new migration plus the updated `migrations/meta/` files.

### Document Retention (French Legal Requirements)

Per Code de commerce **L123-22** and Livre des procédures fiscales **L102 B**, accounting records must be retained for **10 years**. This applies to:

- `invoices` rows and the original PDFs in Object Storage
- `certificats` rows and any generated PDFs
- `situations` rows
- `email_documents` (where the source attachment is itself an accounting record)
- `archidoc_sync_log` (audit trail)

**Policy decisions**:

- These tables use **hard deletes only when triggered by a deliberate operator action** with audit logging, and never via automatic GC.
- Cascades from `projects.deleted` are intentionally NOT used for `invoices` rows older than the retention horizon. Project deletion is gated by `server/services/project.service.ts#deleteProject`, which inside one transaction (1) takes a `SELECT ... FOR UPDATE` row lock on the `projects` row, (2) takes a `SELECT ... FOR UPDATE` lock on every `devis` row for the project (situations FK to `devis`, not directly to `projects`, so this second lock is required to block concurrent situation inserts), (3) counts retained `invoices`, `situations` (joined via `devis`), and `certificats`, and (4) issues the `DELETE`. Any concurrent transaction trying to insert an invoice/certificat (FK to projects), a new devis (FK to projects), or a situation against an existing devis (FK to devis) is forced to wait on the FK key-share lock until our transaction commits or rolls back, closing the TOCTOU window. Refusal is signalled with `ProjectRetentionError` (HTTP 409, code `PROJECT_RETENTION_BLOCKED`, payload `{ retained: { invoices, situations, certificats } }`).
- Object Storage objects under `PRIVATE_OBJECT_DIR` should be retained for at least 10 years; bucket lifecycle rules MUST be set to never auto-expire those prefixes.

### Database Invariants (DB-enforced)

The schema includes the following CHECK / UNIQUE constraints to keep financial state consistent regardless of which code path writes:

| Table | Constraint | Purpose |
|---|---|---|
| `invoices` | `invoices_amount_ht_nonneg` | HT amount cannot be negative |
| `invoices` | `invoices_amount_ttc_nonneg` | TTC amount cannot be negative |
| `invoices` | `invoices_tva_amount_nonneg` | VAT amount cannot be negative |
| `situations` | `situations_devis_number_unique` | Situation numbers are unique within a devis |
| `situations` | `situations_cumulative_ht_nonneg` | Cumulative HT cannot go negative |
| `situations` | `situations_net_to_pay_ttc_nonneg` | Net-to-pay TTC cannot be negative |
| `fee_entries` | `fee_entries_invoice_unique` (partial) | At most one fee entry per invoice — guarantees idempotent approval |
| `fee_entries` | `fee_entries_fee_amount_nonneg` | Fee amount cannot be negative |
| `fee_entries` | `fee_entries_fee_rate_pct` | Fee rate is in `[0, 100]` |
| `document_advisories` | `document_advisories_subject_check` | XOR on `(devis_id, invoice_id)` |
| `webhook_events` | `event_id` PK | Idempotency key for inbound webhooks |
| `projects` | `projects_archidoc_id_unique` | 1:1 mapping with ArchiDoc |
| `contractors` | `contractors_archidoc_id_unique` | 1:1 mapping with ArchiDoc |
| `lots` | `lots_project_lot_unique` | No duplicate lot numbers per project |
| `archidoc_proposal_fees` | `archidoc_proposal_fees_project_unique` | One proposal-fee row per project |
| `certificats` | `certificats_project_ref_unique` | Certificate refs are unique per project |

### Concurrency & Idempotency

- **Invoice approval** (`server/services/invoice-approval.service.ts`) runs in a single DB transaction with `SELECT ... FOR UPDATE` on the invoice row, and is idempotent at the storage layer via the `fee_entries` partial unique index.
- **Advisory reconciliation** (`server/services/advisory-reconciler.ts`) uses `SELECT ... FOR UPDATE` per subject and is append-only for resolved/acknowledged history.
- **Inbound webhooks** (`server/services/webhook.service.ts`) check `webhook_events` by `event_id` before processing. The ID is taken from the payload when present and otherwise derived as `derived:<sha256(event|timestamp|data)>`.

### Logging & Observability

- Every API request gets an `X-Request-Id` header (random UUID v4 unless the caller supplied a sane value), echoed back to the client and recorded in the access log.
- Access log lines never include the response body — financial payloads, extracted email content, and contractor PII would otherwise leak into stdout/log aggregators.
- Mutating endpoints log `userId` only; sensitive fields are never logged.

### Rate Limiting

In-process token-bucket limits (see `server/middleware/rate-limit.ts`) are applied at three tiers:

- `/api/webhooks/*` — 60 req/min (unauthenticated, external traffic)
- Upload endpoints — 20 req/min (each upload triggers expensive AI extraction)
- All other `/api/*` — 600 req/min (belt-and-braces guard)

Keys are derived from the authenticated `userId` when available, otherwise the client IP (`X-Forwarded-For` aware).

### File Upload Validation

`server/middleware/upload.ts` enforces:

- `multipart/form-data` MIME of `application/pdf` (or `application/x-pdf`)
- `.pdf` extension
- `%PDF` magic-byte check applied in the upload service before extraction
- Max file size: 25 MB
- Max files per request: 1
