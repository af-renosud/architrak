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
