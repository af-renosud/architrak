---
name: Evidence attach transactionality
description: Attaching a retained PDF/evidence record to a business row must be one transaction with DB-level uniqueness, not check-then-write.
---

Rule: any flow that "claims" an intake/source document and attaches it to a business record (evidence retention, promotion, routing) must do BOTH writes in one DB transaction, with:
- a conditional claim on the source row (expected state + not-yet-promoted predicate in the WHERE clause),
- a conditional attach on the target (e.g. `source_storage_key IS NULL`),
- a partial UNIQUE index on the target's source-document FK (`WHERE fk IS NOT NULL`), catching the "same source attached to two different targets" race via 23505 → conflict.

**Why:** completion code review rejected three times a check-then-write version: separate writes let a mid-flight failure leave retained evidence pointing at a still-parked source row, and read-time checks let concurrent requests double-attach or overwrite provenance.

**How to apply:** server-side, also re-validate the source row's state and extracted type in the endpoint (never trust the UI filter); the loser of any race gets a 409/park, never a silent overwrite. Conflict-safe insert = ON CONFLICT DO NOTHING against the partial unique index, then treat "no row returned" as conflict.
