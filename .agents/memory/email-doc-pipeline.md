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

## Financial admission is separate from recognition failure
Explicit manual recovery cannot depend on the success-only email-to-intake mirror: failed extraction can leave an eligible, assigned PDF without that record. Prepare a parked source idempotently, without starting an automatic job; preserve deleted-source, project-identity and fingerprint guards.

**Why:** Otherwise the recovery button asks the user to assign an already-assigned PDF, but assignment cannot repair a mirror blocked by failed extraction.

Financial review and its counters require positive financial evidence and active-project identity inside the PDF, or existing linked financial provenance. A recognition failure before that evidence exists must not become a financial task. Manual retry is not permission to bypass admission. Failures after successful admission remain actionable.

Unverified technical copies have bounded retries and retention; expiry means unverified, not proven irrelevant. Preserve earlier positive admission across retries and project archival. All automatic cleanup paths must protect that evidence under locks, even before a quotation or invoice has been linked.

**Why:** unreadable architectural plans previously entered attention as generic extraction failures, defeating the client's financial-only intake policy.
**How to apply:** keep list filters, API responses, queue counters and worker admission consistent; never erase financial evidence because a later OCR attempt fails.

## Intake watermark & terminal skipped state
- An intake watermark (env-configurable minimum received-at) is enforced in FOUR places: Gmail capture, sweeper selection, the processEmailDocument boundary, AND the atomic claim's SQL predicate — a boundary-only check can be raced or bypassed by future callers.
- 'skipped' is a terminal email-doc status: unclaimable at the SQL level, immutable via the generic PATCH (schema omit + body delete + storage guard), never mirrored into intake, and retry bookkeeping only applies to rows currently 'processing'.
- Dumping a backlog needs TWO data migrations worth of cleanup: the status flip AND removing already-created intake mirrors/jobs (mirrors created via projectId assignment predate the flip).
- Gmail receipt time must come from internalDate (authoritative), never the forgeable RFC Date header.
