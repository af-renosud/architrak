---
name: Email-doc hard purge guards
description: Provenance-safety lesson for hard-deleting skipped email documents and their intake mirrors.
---

Rule: hard-deleting an email document or its intake mirror requires transactional guards against EVERY provenance consumer — including FKs that point at the mirror rather than the doc, and especially ON DELETE SET NULL FKs, which delete "successfully" while silently severing evidence. Restrictive FKs are also a hazard: they throw and can starve a batch sweep unless each candidate is isolated with try/catch.

**Why:** cleanup paths that deleted intake mirrors would have destroyed retained fee-invoice, situation, and marché-document evidence — SET NULL FKs made the deletes look successful.

**How to apply:** when adding a hard-delete path (or a new table referencing email/intake docs or sharing their storage keys), enumerate all inbound FKs on BOTH the row being deleted and any rows deleted alongside it, and add each to the purge guards and the storage-key reference check. SET NULL FKs never fail loudly — they must be guarded explicitly, with a test proving refusal.
