---
name: Hand-written migrations invariant
description: Every migration must appear in the journal AND have schema-presence probes that cover its critical invariants, or boot/CI fail loudly.
---

Rule: migrations here are hand-authored SQL (drizzle-kit generate is broken by a snapshot collision). A new migration is only complete when it is registered in BOTH the drizzle journal and the boot-time schema-presence artifact list. The probe must cover every critical protection introduced by the migration (for example, its table, key constraint/index, and lifecycle trigger), not merely a representative table or column.

**Why:** tracker-behind recovery can stamp a migration without replaying it when its probe claims the schema is already present. A table can exist while its trigger or integrity constraints are absent, leaving the application with silently unenforced lifecycle rules.

**How to apply:** treat "add migration" as a three-part change (SQL file, journal entry, complete artifact probe) landed together. For replay-safe DDL, make the migration re-assert critical constraints/triggers idempotently and add a recovery test that removes a critical artifact while the table remains.

Constraint drift: prod's schema can drift from a stamped migration (seen with a CHECK constraint reverting to a pre-migration definition while the tracker said applied). Fix by shipping a NEW idempotent re-assert migration (guarded DROP IF EXISTS + re-ADD). `rerunnable: true` on a data_only artifact entry now covers guarded idempotent DDL too (not just DML), so the tracker self-heal executes it instead of stamp-only — never flag unguarded DDL.
