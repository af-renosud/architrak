---
name: Hand-written migrations invariant
description: Every migration must appear in the journal AND the boot-time schema-presence artifact list, or boot/CI fail loudly.
---

Rule: migrations here are hand-authored SQL (drizzle-kit generate is broken by a snapshot collision). A new migration is only complete when it is registered in BOTH the drizzle journal and the boot-time schema-presence artifact list — the artifact entry names one representative table/column (or is marked data-only).

**Why:** the boot invariant walks the journal and hard-fails on any migration tag missing an artifact entry, and CI replay suites fail the same way — an SQL file alone will take down boot.

**How to apply:** treat "add migration" as a three-part change (SQL file, journal entry, artifact entry) landed together.
