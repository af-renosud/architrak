# Supplier certificate release validation

**Validation dates:** 2026-08-24 and 2026-08-28
**Decision:** **NO-GO — production supplier issuance remains disabled**

This record intentionally contains no supplier identities, bank details,
document paths, response bodies, credentials, or endpoint hostnames.

## Release gates

| Gate | Result | Evidence |
|---|---|---|
| ArchiTrak byte-pinned wire fixtures | PASS | Contract, wire parser, cursor recovery, pagination, ordering, replay, delete, assignment-clear and persistence suites |
| Supplier blocker matrix | PASS locally | Canonical partner/project preconditions plus identity, contact, activity, banking, verification provenance, assignment and date-bound tests |
| Supplier calculation/seal/PDF/email/RIB/ledger | PASS locally | Focused supplier core, immutable seal, rendering, dispatch, RIB fail-closed and payment-ledger suites |
| Contractor non-regression | PASS locally | Retention, prorata, insurance, PV, banking, seal, PDF and communication suites |
| Supplier/contractor browser release flows | PASS locally | Isolated fake-Gmail flow with a protected-RIB mock; all fixtures removed afterward |
| Project canary and kill switch | PASS | Exact ArchiDoc project-ID allowlist; non-canary preview refused; sealed canary PDF remained readable |
| ArchiDoc development countersignature | PASS | Countersigned contract and separate acceptance record retained on 2026-08-28 |
| ArchiDoc development contract endpoint | PASS | Authenticated bootstrap export passed ArchiTrak's exact strict production schema parser |
| Protected development RIB retrieval | PASS | ArchiDoc verified PDF, private/no-store, attachment, ETag, byte hash and 409 mismatch behavior |
| Production ArchiDoc endpoint | PARTIAL PASS | Authentication rejection, bootstrap and incremental replay pass; feed currently contains zero supplier changes |
| Production protected RIB | **BLOCKED** | Production feed has no current verified supplier/RIB candidate |
| Production enablement | **NOT ATTEMPTED** | Required by the release constraint |

## Commands and results

Wire-contract suites:

```sh
npx vitest run --no-file-parallelism \
  server/archidoc/__tests__/supplier-payment-readiness-contract-fixture.test.ts \
  server/archidoc/__tests__/supplier-payment-readiness-wire.test.ts \
  server/archidoc/__tests__/supplier-payment-readiness-sync.integration.test.ts
```

Result: **3 files, 35 tests passed**.

Focused supplier/contractor release suite:

```sh
npx vitest run --no-file-parallelism \
  server/archidoc/__tests__/supplier-payment-readiness-contract-fixture.test.ts \
  server/archidoc/__tests__/supplier-payment-readiness-wire.test.ts \
  server/archidoc/__tests__/supplier-payment-readiness-sync.integration.test.ts \
  server/services/__tests__/supplier-payment-readiness.service.test.ts \
  server/services/__tests__/supplier-payment-readiness-assert.service.test.ts \
  server/services/__tests__/supplier-certificate-rollout.service.test.ts \
  server/services/__tests__/supplier-certificate-dispatch.service.test.ts \
  server/__tests__/supplier-certificate-core.integration.test.ts \
  server/services/__tests__/supplier-certificat-seal.service.test.ts \
  server/services/__tests__/supplier-certificate-rendering.characterization.test.ts \
  server/communications/__tests__/certificat-send-dedupe.test.ts \
  server/services/__tests__/contractor-certificate-track.characterization.test.ts \
  server/services/__tests__/certificat-deductions.pv-gate.test.ts \
  server/services/__tests__/certificat-deductions.solde.test.ts \
  server/routes/__tests__/certificat-seal.test.ts \
  server/__tests__/certificat-seal-version-guard.integration.test.ts \
  server/__tests__/certificat-seal-source-race.integration.test.ts \
  server/__tests__/certificat-payments.integration.test.ts \
  server/services/__tests__/certificat-payments.test.ts \
  shared/__tests__/financial-utils.test.ts \
  shared/__tests__/iban.test.ts
```

Result: **21 files, 227 tests passed**.

File parallelism is disabled for this focused command because several
integration files intentionally exercise the same readiness mirror tables.
Running those files concurrently can make one file observe another file's
short-lived tombstone fixture.

Browser release flow:

- a canary supplier invoice showed the direct-payment readiness dialog and
  supplier-only detail wording;
- the certificate sealed and fake-sent with one client communication, one
  supplier notice, and exactly two client attachments (pinned certificate PDF
  plus one hash-verified protected RIB);
- confirming the payment suggestion created one ledger row and one audit row;
  a duplicate confirmation returned `SUGGESTION_ALREADY_REVIEWED` without
  another payment or audit row;
- a second supplier project outside the allowlist returned
  `SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED`, while the already sealed canary
  PDF remained readable;
- an isolated contractor certificate remained `contractor_works`, retained
  retention/prorata wording, contained no supplier-readiness copy, sealed, and
  fake-sent successfully;
- all temporary browser fixtures and the protected-RIB mock were removed, and
  the normal development workflow environment was restored.

Initial secret-safe configured-environment validation:

```sh
npm run validate:supplier-release-live
```

Result: **FAIL** — the configured ArchiDoc host does not expose
`supplier-payment-readiness.v1`; the authenticated request returned HTTP 404.
The validator stopped without logging a response body or any protected value.

Development contract acceptance on 2026-08-28:

- ArchiDoc's authenticated development self-test returned HTTP 200;
- the exported bootstrap passed ArchiTrak's exact strict
  `supplier-payment-readiness.v1` schema parser with one fixture upsert;
- repeated incremental requests were byte-identical;
- protected RIB retrieval passed the required headers, PDF envelope, ETag and
  byte-level SHA-256 checks;
- an incorrect RIB hash returned HTTP 409 with
  `RIB_VERSION_MISMATCH`;
- the countersigned contract, acceptance record, bootstrap export and
  secret-free report are retained in
  `docs/SUPPLIER_CERTIFICATE_CONTRACT_v1.0.md`,
  `docs/SUPPLIER_CERTIFICATE_ACCEPTANCE_v1.0.md` and
  `validation_exports/`.

Production endpoint validation on 2026-08-28:

- the rotated production credential was accepted;
- unauthenticated and invalid credentials were rejected;
- `supplier-payment-readiness.v1` bootstrap completed in one page with zero
  changes;
- repeated incremental requests were byte-identical;
- the expired-cursor probe confirmed that history is still retained;
- protected RIB validation could not run because the production feed currently
  contains no verified supplier/RIB candidate.

## Required evidence before GO

The development contract and fixture compatibility gates are complete.
Production remains blocked until:

1. ArchiDoc publishes the versioned endpoint to an identified staging
   environment and confirms the earliest implementation date.
2. One intended production canary supplier is completed in ArchiDoc with a
   verified current RIB and active eligible assignment.
3. The production validator passes the protected RIB byte/hash/header checks
   and RIB version-mismatch response for that supplier.
4. The supplier and contractor browser release flows pass against that
   production contract.
5. Only then may production receive one explicit ArchiDoc project ID for the
   canary.

## Disable path

Clear `SUPPLIER_DIRECT_PAYMENT_PROJECT_ALLOWLIST` and publish/restart. New
supplier previews, creation, reissue and sealing are refused with
`SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED`. Existing sealed history and pinned
PDF downloads remain unchanged; normal live readiness/source checks still
govern any later send.