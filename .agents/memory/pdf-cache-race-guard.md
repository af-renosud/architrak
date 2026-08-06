---
name: PDF cache race guard
description: Race-safe caching of derived artifacts (translated/combined PDFs) vs concurrent content edits.
---
Check-then-write fingerprint guards around cache publication are never enough — a reviewer will (correctly) find the residual TOCTOU window every time.

**Rule:** make invalidation and publication atomic at the DB level: content saves bump a monotonic version column atomically (one UPDATE) with clearing the cache keys, and cache publication is a conditional UPDATE guarded by the version captured before the source data was read. Save order matters: write content first, then bump+clear — any in-flight publish is either wiped by the clear or refused by the version guard.

**Why:** storage objects are immutable (timestamped-unique keys), so a key read from a committed row is never stale; only republishing a stale key was the real bug.

**How to apply:** any cached derived artifact whose inputs can be edited concurrently (PDF renders, exports, thumbnails).
