---
name: ArchiDoc mirror sync safety
description: Durable rules for any ArchiDoc mirror sync or reconciliation work.
---

- **Every mirror sync/reconciliation path must hold the shared advisory lock** (sync-service exposes the helper). This includes contractor auto-sync — any trigger that bypasses it can race a full sync and corrupt the mirror. Callers report "already running" instead of running concurrently.
  **Why:** overlapping syncs reconcile against different upstream snapshots and soft-delete each other's rows; the final mirror depends on timing.
- **Stale-"running" log recovery only fires when it can take that lock** — lock busy means a live run; never mark it failed by age alone.
- **Incremental watermark reads only completed sync-log rows**; failed runs must not advance it.
- **Reconciliation needs the wipe guard**: refuse missing-from-response soft-deletes that would remove all (or ≥90% of ≥5) active rows — that's a truncated upstream response, not a mass deletion.
- **Sync APIs return 200 with embedded per-part errors** — clients must read ok/failures/warnings/alreadyRunning, never assume 200 = success.
- **Never probe upstream connectivity inline in status endpoints**; use the cached bounded probe or page loads freeze on a slow upstream.
- **A backend switch needs eventual in-lock reconciliation, not merely a best-effort boot pass.** If boot loses the mirror lock, retry after contention; every lock-owning sync path must reconcile before publication.
  **Why:** otherwise prior-backend active master rows can remain selectable indefinitely when polling is disabled or a different process held the boot lock.
- **Never overwrite a cross-source technical-lot ID that any Planning revision references.** Reject the whole catalogue publication and retain the last-known-good row/catalogue instead.
  **Why:** Planning persists only the immutable upstream ID; a different backend reusing that ID would silently relabel approved history.
- **Technical-lot availability distinguishes an empty first load from last-known-good data.** A failed refresh keeps the prior validated catalogue selectable; diagnostics use fixed safe codes/reasons and never retain upstream bodies, headers, values, or caught exceptions.
  **Why:** operators must not lose a working Planning selector during an upstream outage, while raw failure detail can disclose credentials or untrusted content.
- **Supplier payment-readiness sequences stay exact unsigned-decimal strings and the cursor advances only after the entire frozen page window validates and commits.** Reject duplicate sequences, cursor regression, changed same-sequence payloads, and source changes without bootstrap.
  **Why:** JavaScript numbers lose upstream sequence precision, while partial page publication or cursor movement can authorize payment from an incoherent snapshot.
- **Once the versioned readiness feed claims a supplier ID, no legacy contractor/supplier feed may overwrite or resurrect it—even if legacy partner type is missing or wrong, and even when the readiness row is a tombstone.**
  **Why:** ArchiDoc readiness is the payment-authoritative supplier identity; legacy labels and refresh failures are not ownership signals.
- **Readiness publication takes the same project/supplier transaction advisory-lock pair as certificate sealing before changing supplier, assignment, or tombstone state.**
  **Why:** a seal must compare and issue against one serial readiness state, never race an assignment/banking update.

**How to apply:** new sync triggers go through fullSync/incrementalSync/runContractorAutoSync (which own the lock); new sync UIs must handle failures/warnings/alreadyRunning and the explicit catalogue availability state.
