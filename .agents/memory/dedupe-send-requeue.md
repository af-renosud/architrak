---
name: Dedupe-keyed send paths must requeue failed rows
description: Stable dedupe keys on outbound communications make a re-send return the old row — a prior FAILED row must be explicitly requeued or "Send" lies.
---

Rule: any send path that dedupes on a stable key (e.g. `certificat_sent:<id>:<storageKey>`) gets the EXISTING row back on re-send. If that row's status is `failed`, the handler must flip it back to `queued` (via the update helper, which also clears the archive flag) before reporting success — otherwise the UI toasts "queued" while nothing is pending and unsent alerts never clear.

**Why:** caught in review of the unsent-certificats alert — failed sends were listed as "unsent" but the Send button was a no-op for them.

**How to apply:** when adding a new dedupe-keyed communication or a surface that retries sends, check `created.status === "failed"` after `createProjectCommunication` and requeue; queued/sent rows pass through untouched (that's the double-click idempotency case). Archived projects must be excluded from cross-project action lists AND blocked at the endpoint.
