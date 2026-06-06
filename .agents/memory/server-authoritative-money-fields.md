---
name: Server-authoritative money fields
description: How to keep client-supplied derived money fields out of storage, and how to read prior cumulative state correctly.
---

# Server-authoritative money fields (certificats)

## Strip derived money fields at the Zod schema, not just in the handler
Server-derived monetary fields (e.g. certificat `retenueGarantie`,
`cumulativeProrataDeduction`, `periodProrataDeduction`, `netToPayHt`,
`tvaAmount`, `netToPayTtc`) must be `.omit()`-ed from the request body schemas
used by `validateRequest`, so Zod strips them before they reach storage.

**Why:** A recompute that only fires on a `touchesFinancials` guard can be
bypassed — a PATCH carrying *only* derived fields skips the guard and the raw
client values persist verbatim, letting a caller move money directly. Handler-
level stripping is easy to forget on a new route; schema-level omit is the
single chokepoint.
**How to apply:** Any field whose value is computed by a server service (not
entered by the user) should be omitted from the insert/update request schema,
even though it is a real column. Provide it only from the server-side result.

## Prior cumulative = the latest prior row, never max()/sum()
When a column stores a *cumulative-to-date* figure per period, derive the prior
cumulative by reading the **latest prior row** (order by issue date, then id as
a stable tiebreaker), not `max()` or a `sum()` of period deltas.

**Why:** A downward architect override, or a guarantee/exemption transition,
can make the cumulative legitimately *decrease*. `max()` clamps to the old peak
and `sum()` of period deltas over-counts, both breaking the invariant
`period = cumulative − prior`.
**How to apply:** Sort the prior set deterministically and take the last row's
stored cumulative column. Applies to retenue de garantie and Compte Prorata
cumulative deductions.
