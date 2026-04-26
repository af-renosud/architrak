# Wire Fixtures

Canonical JSON fixtures for the v1.0 inter-app contract
(`docs/INTER_APP_CONTRACT_v1.0.md`, frozen 2026-04-25).

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

## Inventory (AT1 placeholder set)

| Filename                       | Contract section | Status     | Fully populated by |
|:-------------------------------|:-----------------|:-----------|:-------------------|
| `identity-verification.json`   | §3.4             | placeholder | AT5 (emit path tests will pin the exact byte layout) |

Subsequent tasks (AT3 outbound webhook payloads, AT4 inbound webhook
payloads) MUST add their own fixtures here as the first step of their
implementation, BEFORE writing any serialiser/parser code, so the
fixture is the single source of truth and the code is forced to match.

## Why fixtures and not schemas alone

Zod schemas alone don't pin field ORDER, JSON-number formatting, or
trailing-newline policy — all of which can break HMAC signatures or
strict-parser receivers in subtle ways. The contract is byte-exact
because cross-app HMAC signing is byte-exact (§0.4); the fixtures
enforce that property automatically by being checked in alongside the
schemas they sample.
