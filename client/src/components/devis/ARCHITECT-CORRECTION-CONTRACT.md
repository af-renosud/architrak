# Architect correction editor: integration contract

## Frontend

`ArchitectQuotationEditor` is visible above the tabs in every expanded quotation.
Its visual system follows the existing Renosud navy/sand architectural workbench,
with a persistent source lock strip, stable-ID row navigation, bilingual side-by-side
content, passage transfer and an exact-cent batch reconciliation footer.

No automatic write, provider call, email or signature is triggered by opening,
editing or saving the editor. The original-PDF link always requests `variant=original`.

## Authenticated wire contract

Strict wire schemas and shared exact arithmetic are defined in
`shared/architect-quotation.ts`; the frontend model reexports them.

- `GET /api/devis/:id/architect-correction` → `ArchitectCorrectionSnapshot`.
- `PUT /api/devis/:id/architect-correction` takes the complete
  `ArchitectCorrectionDraft` plus `expectedVersion` → updated snapshot.
- `POST /api/devis/:id/architect-correction/source-baseline` takes
  `{expectedVersion, ttc, page, confirmedFromPdf:true}` → updated snapshot.
- `POST /api/devis/:id/architect-correction/translation-suggestions` takes the
  current complete draft and expected version, returning suggestions only.
  It is an explicit provider action. It never writes the quotation, and the UI
  fills only empty English fields, retaining existing human English.

Snapshot includes `version`, `draft`, nullable PDF-provenance `baseline`,
`blockedReason`, `financialBlockedReason`, `advisoryMessages` and `history`.
Existing rows use their actual immutable `id`, a persistent `clientKey`, actual
VAT and an explicit `included` flag. New rows have `id:null` and a generated
clientKey. Context rows have zero financial contribution. Array order is display
order, not evidence identity. Baseline is never part of the ordinary save body.

All requests use the existing `apiRequest` cookie-authenticated API client.
Mutation retries are disabled. A 409 must return a useful conflict message;
the UI preserves the entire local draft, refreshes only the cached server
snapshot, disables forced save, and offers a JSON draft backup. Baseline
confirmation also preserves unsaved draft content.

## Implemented backend boundary

Authenticated routes and a PostgreSQL correction service implement this contract.
Under quotation, line and translation locks they validate the expected version,
protect issued/signed/committed figures, retain existing row IDs, and save only
a financially reconciled complete batch.
Plain content edits do not become machine-verified and must not require OCR
coverage. Reject context lines carrying money rather than silently charging it.
Persist before/after actor/time audit and original extraction separately.

The independent source baseline requires immutable PDF/version provenance and
a human-readable confirmation path. Never bootstrap it from edited row sums
or known-bad extraction. Ordinary save cannot mutate that baseline.

Clear previous translation approval, bump PDF content version and invalidate
cached generated artifacts atomically. Protection triggers also stop background
translation/re-scrape from overwriting source, rows, English or explanations.
Corrected French feeds explicit unsaved translation suggestions without replacing
manual English. Human-approved content flows to the portal and bilingual/context
package. Unapproved newly saved working content remains internal.

The UI preview uses exact BigInt decimal arithmetic, actual VAT buckets,
proportional HT discount allocation by deterministic largest remainder, explicit
bucket/per-line VAT rounding, and accepted-option flags. The server independently
enforces the same shared arithmetic and exact equality. Reordering cannot change
discount cent allocation. A matching confirmed source TTC also repairs a drifted
working header total atomically; it never replaces the independent source receipt.

Corrected quotations fail closed at both signing paths if an original-containing
combined package cannot be generated. Original receipt bytes are checked against
SHA-256 when packaging and at the corrected financial/approval boundary.
Existing signed artifacts and pinned history are not rewritten.

## Verification and limitations

Disposable frontend tests cover bilingual persistence/reopen, no automatic
save, source-PDF access, source setup preserving a draft, immutable stable IDs
including legitimate equal-price rows, additions/reorder, full TTC batches,
stale draft retention and committed-finance protection. Arithmetic tests cover
mixed VAT, discounts, options, exact cents and passage transfer.

Migration 0139 is registered in the journal and boot artifact checks and applied
to the verified development database `architrak-dev`. Isolated disposable schema
tests exercise real transactions, immutable baseline/source/audit, stale concurrency,
audit-failure rollback, signed/financial protections, and the eighteen-item shifted
specification workflow preserving both equal-price items and the terminal row.
Existing approval transaction tests use uniquely named disposable development
fixtures and remove them afterward. HTTP perimeter, approval-policy, PDF page-order,
portal and frontend tests use mocks/VM/jsdom, not providers.

No browser tester, real provider call, email, signature, workflow restart,
production repair, publication or task completion was performed. Human approval
uses the existing Translation tab after save; content is not marked automatically
verified.

Final verification: TypeScript check passes; 93 focused frontend/HTTP/policy/PDF/
portal/extraction tests pass in 12 files, plus 16 real PostgreSQL transaction/
approval tests in two files. Development boot schema/tracker verification passes.
The signed-in UI was not browser-verified.

## Full prepublish regression verification

After fixing eager correction-service dependency construction and explicitly
modeling absent correction authority in legacy isolated fixtures, the complete
serialized `npm run prepublish-check` passes (exit 0): dependency audit, currency
conventions, TypeScript, 259 test files / 2,492 tests, production schema/migration
checks and build, and guarded production-bundle smoke boot with `/healthz` 200.
The default suite skips the 10 opt-in correction DB tests; these were then
explicitly run with `RUN_ARCHITECT_DB_TESTS=1` and all 10 passed. No business guard
was relaxed. The main agent's mobile portal table fix is preserved.
The application workflow remained stopped; no browser rerun or publication.
