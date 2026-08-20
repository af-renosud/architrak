---
name: Legal closure provenance
description: How to preserve evidence and race safety for legally significant close transitions
---

A legally significant close transition must lock both the record being closed and the exact prerequisite evidence record, then persist an immutable snapshot of the validated relationship and evidence date with the closure audit.

**Why:** Locking only the primary record allows a concurrent edit to the prerequisite relationship, while storing only live foreign keys lets later corrections erase what actually satisfied the legal gate at closure time.

**How to apply:** Use one transaction, lock every row whose state establishes eligibility, revalidate after the locks, and atomically write actor/time plus immutable prerequisite and relationship snapshots. Keep those audit fields out of generic mutation paths.