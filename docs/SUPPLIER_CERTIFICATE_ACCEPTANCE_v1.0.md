# Supplier Direct-Payment Certificate Contract v1.0 — Acceptance Record

**Record status:** Development wire-contract validation countersigned by ArchiDoc and ArchiTrak; production rollout not authorized
**Contract:** `docs/SUPPLIER_CERTIFICATE_CONTRACT_v1.0.md`  
**Wire contract literal:** `supplier-payment-readiness.v1`  
**Availability date:** 2026-08-24  
**Development countersignature date:** 2026-08-28

## Environment

The current non-production environment is **Replit development preview**. Its
base URL is populated from `REPLIT_DEV_DOMAIN` only at runtime and is not
hardcoded in this record.

This record does not assert that a staging or live environment has been
validated. The implementation is available and validated in the Replit
development preview. The earliest staging availability date is **not yet
assigned**.

## §10 acceptance items

The following enumerates every acceptance item required by §10 of the contract.
The evidence is complete for ArchiDoc's development implementation:

1. **Endpoint, authentication, sync semantics — accepted in development.**
   The versioned feed and RIB paths are registered under
   `/api/integrations/architrak/v1`, protected by the existing sync bearer-key
   middleware, and require the documented JSON `Accept` header where
   applicable. Automated coverage verifies bootstrap and incremental paging,
   frozen high-water marks, HMAC-protected opaque continuation tokens, strict
   query shapes, monotonic 64-bit sequences serialized as strings, and the
   exact expired-cursor response. Live development checks returned `401` with
   no credential, `406` for an invalid `Accept`, and `200` for an authenticated
   bootstrap.
2. **Wire fields and validation — accepted in development.** Strict Zod
   allowlists enforce every v1 field, null rule, and enum. Verified banking
   fails closed without provenance and a current protected RIB. Tests prove
   undocumented legacy banking/RIB fields are rejected rather than serialized.
3. **Assignment replacement semantics — accepted in development.** The
   supplier assignment write replaces the complete assignment set in one
   transaction, validates project references, uniqueness, status, and date
   bounds, and emits one readiness change. The assignment-clear fixture is
   accepted by the frozen response schema.
4. **Protected RIB retrieval — accepted in development.** RIBs are private,
   versioned PDFs with exact object paths and SHA-256 metadata. Retrieval
   validates the declared current version, expected hash, persisted metadata,
   and downloaded bytes before committing a non-secret access audit. PDF bytes
   are emitted only after that transaction commits. Route tests cover current
   retrieval, mismatch, not-found, storage failure, commit failure, no-store
   headers, and audit behavior; generic object routes deny the private prefix.
5. **Upsert, inactivity, and deletion behavior — accepted in development.**
   Explicit supplier enrollment, relevant contractor/contact/assignment/RIB
   writes, RIB supersession, bank-detail verification invalidation, and
   supplier soft deletion append readiness changes in the source transaction.
   Transition tests pin `supplier → non-supplier` to a delete tombstone.
   A real development-database smoke test verified one event per transaction
   and zero retained source/event rows after rollback. A route-backed database
   regression verifies that blank optional form values are published as wire
   `null` values in an incomplete supplier snapshot rather than rolling back
   enrollment. A demote-then-delete regression verifies historical supplier
   rows remain soft-deleted and their tombstone ledger remains intact.
   Supplier lifecycle,
   contact, assignment, verification, and protected-RIB mutations require a
   fail-closed architect/admin session even while wider application RBAC is in
   audit mode.
6. **Fixture compatibility — accepted in development.** All six checked-in
   fixtures parse as JSON. The four successful feed fixtures are accepted with
   canonical JSON byte equality; route tests assert exact bodies for the
   expired-cursor and RIB-version-mismatch fixtures.
7. **Implementation and availability dates — partially accepted.** Earliest
   ArchiDoc implementation and development-preview availability:
   **2026-08-24**. Earliest staging availability: **pending**. No staging or
   production availability is claimed by this record.

## Validation evidence

- Focused supplier readiness service and route suites: **15 tests passed**.
- Database-backed FK, blank-source, demote/delete, concurrent lifecycle, and
  promotion-versus-legacy-RIB invariants: **5 tests passed**.
- Architect/admin mutation authorization: **6 tests passed**.
- Readiness plus neighboring object-storage and ArchiTrak regression suites:
  **69 tests passed**.
- Existing project safe gate: **17 tests passed** across Jest and Vitest.
- Full-project TypeScript checking completed with an 8 GB heap and reported
  **366 pre-existing project/test typing errors**; none referenced the supplier
  readiness implementation or its tests.
- Server/boot esbuild compilation: passed.
- Drizzle schema check and migration application: passed.
- Authenticated development bootstrap export: passed.
- ArchiTrak exact strict `supplier-payment-readiness.v1` production schema
  parser against that export: passed.
- Two incremental requests from the exported bootstrap high-water mark:
  byte-identical, with zero changes in each response.
- Protected fixture RIB: HTTP 200, PDF attachment and private/no-store headers,
  declared-hash ETag, and downloaded-byte SHA-256 match.
- Incorrect protected-RIB hash: HTTP 409 with `RIB_VERSION_MISMATCH`.
- Secret-free evidence is retained in
  `validation_exports/archidoc-supplier-readiness-bootstrap.json` and
  `validation_exports/archidoc-supplier-readiness-validation-report.md`.
- ArchiDoc and ArchiTrak development wire-contract countersignature: accepted
  on **2026-08-28**.

## Release status

Production supplier-payment rollout has **NOT** been enabled. No production
project has been added to a supplier direct-payment rollout allowlist by this
record. Development countersignature does not authorize publication or
production changes. Production enablement remains blocked until a staging
availability date is recorded and the separate production release gate is
explicitly approved.