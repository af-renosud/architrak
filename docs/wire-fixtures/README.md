# Wire Fixtures

Canonical JSON fixtures for frozen inter-app contracts. Most fixtures below
belong to `docs/INTER_APP_CONTRACT_v1.0.md` (frozen 2026-04-25). Supplier
payment-readiness v1 belongs to
`docs/SUPPLIER_CERTIFICATE_CONTRACT_v1.0.md` (ArchiTrak-frozen proposal
2026-08-24).

These fixtures pin the **exact byte layout** of every cross-app payload
shape so that all three apps (Architrak, Archidoc, Archisign) can use
them as golden tests against schema and serialiser drift. Regenerating a
fixture is a v1.1 amendment cycle — never an in-place edit on a v1.0
fixture.

## Conventions

- One file per shape. Filename matches the contract section heading
  in lowercase-kebab-case (e.g. `identity-verification.json` covers
  contract §3.4).
- Fixtures are **complete** examples — every required field present, no
  ellipses, no `// comment` markers. Receivers parse them as-is.
- Timestamps are ISO 8601 UTC with second precision (no fractional
  seconds) unless the contract section explicitly specifies otherwise.
- Opaque ids (envelope ids, event ids, http_status codes) use the
  contract's documented shapes; do NOT invent new id shapes.

## Inventory

| Filename                              | Contract section | Status     | Fully populated by |
|:--------------------------------------|:-----------------|:-----------|:-------------------|
| `identity-verification.json`          | §3.4             | populated  | AT5 — emitted verbatim inside the `work_authorised` payload (§5.3.1); pinned 2026-04-26 with the AT5 ship |
| `envelope-sent.json`                  | §3.1 / §3.2      | populated  | AT4 — inbound webhook receiver |
| `envelope-queried.json`               | §3.1 / §3.2      | populated  | AT4 — inbound webhook receiver |
| `envelope-query_resolved.json`        | §3.1 / §3.3      | populated  | AT4 — inbound webhook receiver (4-field attribution) |
| `envelope-declined.json`              | §3.1 / §3.2      | populated  | AT4 — inbound webhook receiver |
| `envelope-expired.json`               | §3.1 / §3.2      | populated  | AT4 — inbound webhook receiver |
| `envelope-signed.json`                | §3.1 / §3.4      | populated  | AT4 — inbound webhook receiver (mirrors `identity-verification.json` once AT5 pinned it) |
| `envelope-retention_breach.json`      | §3.1 / §3.7      | populated  | AT4 — inbound webhook receiver (downstream re-notify is AT5) |
| `work-authorised.json`                | §5.3.1           | populated  | AT5 — Architrak → Archidoc outbound (default `eventType` variant) |
| `signed-pdf-retention-breach.json`    | §5.3.2           | populated  | AT5 — Architrak → Archidoc outbound (discriminated `eventType` variant; **`originalSignedAt` mirrors the upstream Archisign value verbatim — never substituted with receipt time**) |
| `supplier-payment-readiness-v1.json`  | Supplier contract §6 | populated | ArchiDoc → ArchiTrak supplier identity, payment readiness, protected RIB metadata, and project assignment |
| `supplier-payment-readiness-v1-delete.json` | Supplier contract §6.2 | populated | ArchiDoc → ArchiTrak explicit deletion event |
| `supplier-payment-readiness-v1-incomplete.json` | Supplier contract §6.3–6.4 | populated | Bootstrap upsert with explicit null/empty incomplete data |
| `supplier-payment-readiness-v1-assignment-cleared.json` | Supplier contract §6.4 | populated | Incremental full-replacement upsert after project eligibility is removed |
| `supplier-payment-readiness-v1-cursor-expired.json` | Supplier contract §6.2 | populated | Incremental cursor rejected after safe change-log compaction |
| `supplier-rib-version-mismatch-v1.json` | Supplier contract §7 | populated | Protected RIB request rejected because document/hash version drifted |

The empty-stub convention: an unpopulated fixture is `{}` (a literal
empty JSON object with a trailing newline), NOT a skeleton with field
names and `null` values, and NOT a JSON file with comment markers. The
"complete example" rule above applies only to fixtures that have been
**populated** by their owning task. Reviewers can therefore tell at a
glance whether a fixture is still a placeholder or has been pinned.

Subsequent tasks (AT3 outbound webhook payloads, AT4 inbound webhook
payloads, AT5 outbound work_authorised + retention_breach payloads) MUST
add their own fixtures here as the first step of their implementation,
BEFORE writing any serialiser/parser code, so the fixture is the single
source of truth and the code is forced to match. AT5 also replaces the
`identity-verification.json` empty stub with a complete example in the
same change.

## Why fixtures and not schemas alone

Zod schemas alone don't pin field ORDER, JSON-number formatting, or
trailing-newline policy — all of which can break HMAC signatures or
strict-parser receivers in subtle ways. The contract is byte-exact
because cross-app HMAC signing is byte-exact (§0.4); the fixtures
enforce that property automatically by being checked in alongside the
schemas they sample.
