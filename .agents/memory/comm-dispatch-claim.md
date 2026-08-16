---
name: Communication dispatch claim
description: Concurrency rules for dispatching outbound project emails (payment instructions).
---

Every state transition on a communication row involved in dispatch must be a
conditional compare-and-set on the current status — the claim into an
in-flight state, and equally any requeue of a failed row back into the queue.

**Why:** the stable dedupe key deliberately funnels concurrent send requests
(double-click, browser retry, two surfaces) onto ONE row. A read-then-write
anywhere in that flow (plain status read before sending, or an unconditional
failed→queued requeue that can stomp another request's in-flight claim) lets
two callers both dispatch, emailing a duplicate payment instruction. Review
rejects both patterns.

**How to apply:** route all sends through the shared dispatch function; never
re-implement dispatch or flip statuses with unconditional updates. Losers of
the claim get a distinct in-progress error (surface as 409); a row already
sent is idempotent success; retry is only possible from the terminal failed
state. Pin races with integration tests issuing genuinely concurrent requests
(slow the fake Gmail so they overlap), covering both fresh sends and retries
of a failed row.
