---
name: Email-document pipeline invariants
description: How captured Gmail attachments flow into intake, and the concurrency/retry rules the pipeline depends on.
---

- The email→intake bridge lives inside the storage layer's generic email-document update: any update that leaves the doc with a projectId + stored file mirrors it into project intake (idempotent on source id) and enqueues the intake job. Setting projectId is therefore a side-effectful act.
- The mirror hands the email-side extraction to intake (marked `preParsedFromEmail`) so the intake pipeline skips a second identical Gemini call. Changing the parsed shape must keep both consumers in sync.
- Processing an email document MUST go through the atomic DB claim (pending/needs_review/failed → processing, conditional UPDATE). Manual route + background sweeper + multi-instance prod all race otherwise, duplicating project-document and Drive side effects.
- Retry policy: 5 attempts total; transient failures return to pending with backoff, stale 'processing' reclaims consume an attempt too so a wedging doc can't loop forever. Retry columns are server-authoritative (excluded from the insert schema).
- Backlog cutoff: docs received before 2026-07-01 are deliberately never auto-processed (user wrote off the pre-outage backlog).

**Why:** the original outage was captured-but-never-processed docs piling up silently; the fixes above are the load-bearing guarantees.
**How to apply:** any new code path that processes or re-processes an email document must claim first and respect the attempt bound.

## Intake watermark & terminal skipped state
- An intake watermark (env-configurable minimum received-at) is enforced in FOUR places: Gmail capture, sweeper selection, the processEmailDocument boundary, AND the atomic claim's SQL predicate — a boundary-only check can be raced or bypassed by future callers.
- 'skipped' is a terminal email-doc status: unclaimable at the SQL level, immutable via the generic PATCH (schema omit + body delete + storage guard), never mirrored into intake, and retry bookkeeping only applies to rows currently 'processing'.
- Dumping a backlog needs TWO data migrations worth of cleanup: the status flip AND removing already-created intake mirrors/jobs (mirrors created via projectId assignment predate the flip).
- Gmail receipt time must come from internalDate (authoritative), never the forgeable RFC Date header.
