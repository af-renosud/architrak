---
name: Cross-domain promotion provenance
description: Integrity rule for one-way promotion from a private planning aggregate into a live aggregate with child rows.
---

**Rule:** Build the complete promoted aggregate first, then attach its immutable source provenance inside the same transaction. Validate the full frozen snapshot when attaching the source and require the reciprocal source→target link with a deferred commit-time constraint.

**Why:** A source link attached on the parent insert cannot validate child rows that do not exist yet. Immediate parent-only validation lets an incomplete or forged target consume the unique source slot; immediate reciprocal checks create an impossible ordering cycle. Deferred reciprocity closes the cycle without exposing a committed one-way link.

**How to apply:** Use this pattern whenever promotion copies parent and child records across domains. Keep retries keyed to the reciprocal pair, and allow provenance cleanup exceptions only during verified deletion of the owning aggregate.