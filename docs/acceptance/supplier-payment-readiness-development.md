# Supplier payment readiness — development acceptance

This acceptance path uses only the synthetic `RICHARDSON TEST` supplier and
`project-test`; production data and production configuration are untouched.

From the repository root, after dependencies have been installed:

```sh
npx vitest run server/archidoc/__tests__/supplier-payment-readiness.test.ts \
  server/services/__tests__/payment-supplier-appointment.test.ts
npm run check
git diff --check
```

The parser suite validates the copied synthetic contract fixture, strict wire
validation, bigint sequences, pagination, atomic replay, and cursor-expiry
bootstrap recovery from a non-zero durable high-water. It also checks strict
banking evidence (IBAN/BIC/checksum, verified audit completeness and bound RIB
path), typed 410 expiry recovery, and protected RIB byte/hash retrieval.

The quotation journey sends real synthetic `%PDF` bytes through the ingestion
core twice, checks assignment-scoped SIRET matching, cross-project and
changed-hash refusal, confirms the same appointment twice, and asserts one
quotation, one appointment and no contractor call. It uses an in-memory
repository, not a deployed app or real database.

Migration `0114_supplier_payment_readiness.sql` creates the read-only ArchiDoc
supplier mirror and the dedicated `supplier_direct_payment_quotations` table.
PDF bytes, hashes, extracted evidence, match decision and appointment audit
fields remain separate from existing `devis`, contractors, and certificates.
Authenticated routes provide multipart ingestion, metadata/preview reads,
confirmation, and architect-operator readiness sync/status; only an existing
`@renosud.com` user may reach them. Apply the migration only to an isolated
development database before a DB-backed journey.