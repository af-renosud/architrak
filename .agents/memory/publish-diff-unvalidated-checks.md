---
name: Publish diff and unvalidated checks
description: Handling malformed Publish SQL generated from PostgreSQL CHECK constraints marked NOT VALID.
---

When Publish emits malformed DDL for a CHECK constraint, inspect `pg_constraint.convalidated` and `pg_get_constraintdef` in development before rewriting the expression. The schema-diff serializer can mishandle the `NOT VALID` suffix, producing extra parentheses or even nesting `CHECK` inside `CHECK`.

**Why:** Equivalent rewrites using nested booleans, simple implications, and `CASE` all remained malformed while the development constraint was unvalidated. Once compliant development rows were confirmed and the original constraint was validated, the same diff rendered valid SQL.

Validation fixes syntax generation only when production can already satisfy the constraint. If the same Publish adds a nullable column required by a strict constraint, legacy production rows receive `NULL` and cannot satisfy it even when development is clean. That is an expand–backfill–contract migration and cannot be collapsed into one schema-only Publish.

**How to apply:** Query violating rows in both environments without exposing sensitive values. For a syntax-only issue, validate or transactionally recreate the development constraint, keep the clear schema-source expression, recompute the diff, and parser-probe it. When production needs data backfilled, first Publish only the additive nullable column, let ordinary application data logic backfill, verify production read-only, then restore the strict constraint in development for a second Publish. During the expand phase, align migration-presence guards with the deliberately deferred artifact or boot will reject the intended intermediate schema; restore the guard in the contract phase. Never work around either case with production DDL.