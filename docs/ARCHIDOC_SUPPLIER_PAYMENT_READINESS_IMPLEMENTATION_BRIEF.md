# ArchiDoc implementation brief — supplier payment readiness v1

ArchiTrak is adding a separate **supplier direct-payment certificate** track.
It will not apply contractor Retenue de Garantie, Compte Prorata, acompte
recoupment, PV de réception, solde, or insurance StopGo rules. It will retain
human-confirmed invoice evidence, verified banking, invoice/ArchiDoc IBAN
mismatch blocking, immutable PDF sealing, idempotent issue/send, and the payment
ledger.

Please implement and countersign the frozen contract in:

- `docs/SUPPLIER_CERTIFICATE_CONTRACT_v1.0.md`
- `docs/wire-fixtures/supplier-payment-readiness-v1.json`

## ArchiDoc work requested

1. Add the bearer-authenticated endpoint:
   `GET /api/integrations/architrak/v1/supplier-payment-readiness`.
2. Emit the exact `supplier-payment-readiness.v1` envelope, globally unique
   monotonic change sequence, upsert/delete union, bootstrap mode, frozen
   incremental window, opaque pagination token, and replay-safe ordering.
3. Populate supplier legal identity, structured named primary contact, activity,
   verified banking provenance, protected RIB metadata, and complete project
   direct-payment assignments.
4. Update a supplier's feed `changedAt` whenever any nested contact, banking,
   RIB, activity, or project-assignment value changes.
5. Add the version-bound protected RIB download route at the exact relative path
   declared in the contract. Require the declared SHA-256 request header and do
   not emit public or signed URLs in the feed.
6. Emit explicit delete changes. Publish `minimumAvailableSequence`, return the
   pinned `410` cursor-expired response when necessary, and support bootstrap
   recovery before compacting old events.
7. Add strict producer tests against the checked-in fixture and negative tests
   for missing keys, null semantics, pagination replay, assignment deletion,
   malformed bank data, authentication, and RIB authorization.

## Acceptance checklist

- [ ] The fixture is accepted byte-for-byte or a specific contract amendment is proposed.
- [ ] Every upsert key is always present; optional data is represented by JSON `null`.
- [ ] Company name is never substituted for a missing contact person name.
- [ ] The supplier ID is stable and never reused.
- [ ] SIRET, IBAN, BIC, email, sequence, timestamps, dates, and SHA-256 are validated before emission.
- [ ] `verified` banking always has complete verifier/time/method/RIB provenance.
- [ ] The assignment array is a complete replacement set on each supplier upsert.
- [ ] Assignment removal causes a new supplier change even if identity data is unchanged.
- [ ] Inactive suppliers remain in history but are not eligible for new direct payments.
- [ ] Deletion emits a tombstone; incremental absence alone never means deletion.
- [ ] Every data change receives one globally unique, monotonic sequence.
- [ ] All incremental pages share one frozen sequence window and can be replayed without changing results.
- [ ] A bootstrap is transactionally consistent and safely recovers an expired incremental cursor.
- [ ] Timestamp ties cannot skip data because timestamps are never cursors.
- [ ] RIB downloads require bearer authorization, document ID + SHA binding, and return `private, no-store`.
- [ ] RIB response bytes match the feed SHA-256/ETag.
- [ ] No API key, raw RIB bytes, AI extraction payload, public URL, or signed URL appears in feed/log output.
- [ ] A staging endpoint and test supplier/project assignment are available for the cross-app test.

Please reply with:

1. accepted contract version and all fixture digests;
2. any proposed amendments by section and field;
3. implementation status and staging date;
4. the staging supplier ID, project ID, and expected direct-payment status
   (no credentials or banking values in the reply).