---
name: Automated document delivery safeguards
description: Durable eligibility and provenance boundaries for callback-triggered document emails.
---

Persist forward-only notification eligibility before consuming a webhook's dedup claim, and make duplicate callbacks recover incomplete completion work without repeating side effects.

**Why:** Returning 500 does not enable recovery if the event was already permanently deduplicated. A crash between intent, signature transition, and PDF recovery arming otherwise loses the automatic email.

**How to apply:** Preserve the original event time and intended counterparty, make intent idempotent, and use a conditional transition when replaying completion. Do not backfill historical signatures on activation.

Protect both the document storage key and its provenance stamp, and reserve the complete generated-outbox dedupe namespace—not merely the email type.

**Why:** Protecting only the provenance field lets a generic edit substitute unrelated bytes under an authentic stamp. Protecting only the type lets a generic communication pre-seed a generated dedupe key and hijack the later outbox lookup.

**How to apply:** Seal the pair from generic requests and verify an existing dedupe match's full intended identity before linking or dispatching it.