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

**How to apply:** new sync triggers go through fullSync/incrementalSync/runContractorAutoSync (which own the lock); new sync UIs must handle failures/warnings/alreadyRunning.
