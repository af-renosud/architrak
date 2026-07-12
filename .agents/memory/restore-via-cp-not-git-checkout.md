---
name: Restore edited files via cp backup, not git checkout
description: Why temporary file mutations (drift simulations, fault injection) must be restored from a cp backup instead of git checkout
---

Rule: when temporarily mutating a source file (e.g. sed-deleting a line to simulate drift and prove a guard fires), snapshot it first with `cp file /tmp/backup` and restore from that — never `git checkout -- file`.

**Why:** platform-managed commits lag behind in-session edits. `git checkout --` restores the *last committed* version, silently reverting uncommitted work done earlier in the same session. This once wiped a test-file migration; the resulting stale file made a working Proxy-based mock look broken and triggered a long false-trail debug through vitest mocker internals.

**How to apply:** any time a check involves deliberately breaking a file and putting it back, use cp-backup/restore. If behavior ever looks impossible ("this code can't produce that output"), first grep the file to confirm the expected version is actually on disk before diving into library internals.
