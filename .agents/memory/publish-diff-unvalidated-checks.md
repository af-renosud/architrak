---
name: Publish diff and unvalidated checks
description: Handling malformed Publish SQL generated from PostgreSQL CHECK constraints marked NOT VALID.
---

When Publish emits malformed DDL for a CHECK constraint, inspect `pg_constraint.convalidated` and `pg_get_constraintdef` in development before rewriting the expression. The schema-diff serializer can mishandle the `NOT VALID` suffix, producing extra parentheses or even nesting `CHECK` inside `CHECK`.

**Why:** Equivalent rewrites using nested booleans, simple implications, and `CASE` all remained malformed while the development constraint was unvalidated. Once compliant development rows were confirmed and the original constraint was validated, the same diff rendered valid SQL.

**How to apply:** Query violating rows first. If there are none, validate or transactionally recreate the constraint as validated in development, keep the clear schema-source expression, then recompute the development-to-production diff and parser-probe the generated statement. Never work around this with production DDL.