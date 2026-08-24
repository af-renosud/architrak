# Supplier certificate release validation

**Validation date:** 2026-08-24  
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
| ArchiDoc countersignature | **FAIL / missing** | The contract still records an ArchiTrak proposal awaiting ArchiDoc acceptance |
| Configured ArchiDoc live contract endpoint | **FAIL** | Authenticated bootstrap returned HTTP 404 through the strict client |
| Protected live RIB retrieval | **BLOCKED** | No live readiness response exists from which to select current protected RIB metadata |
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

Secret-safe live validation:

```sh
npm run validate:supplier-release-live
```

Result: **FAIL** — the configured ArchiDoc host does not expose
`supplier-payment-readiness.v1`; the authenticated request returned HTTP 404.
The validator stopped without logging a response body or any protected value.

## Required evidence before GO

1. ArchiDoc countersigns every item in the contract acceptance record.
2. ArchiDoc publishes the versioned endpoint to an identified staging
   environment and confirms the earliest implementation date.
3. Both applications accept the same checked-in bytes for all six supplier
   fixtures.
4. The live validator passes authentication rejection, bootstrap/pagination,
   incremental replay, cursor expiry (when history has compacted), protected
   RIB byte/hash/header checks, and the RIB version-mismatch response.
5. The supplier and contractor browser release flows pass against that staging
   contract.
6. Only then may production receive one explicit ArchiDoc project ID for the
   canary.

## Disable path

Clear `SUPPLIER_DIRECT_PAYMENT_PROJECT_ALLOWLIST` and publish/restart. New
supplier previews, creation, reissue and sealing are refused with
`SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED`. Existing sealed history and pinned
PDF downloads remain unchanged; normal live readiness/source checks still
govern any later send.