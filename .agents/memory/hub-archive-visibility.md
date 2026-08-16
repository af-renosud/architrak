---
name: Communications-hub archive invariants
description: Archive is a visibility flag with two race guards — queued rows can never stay hidden, and bulk archives are bound to the previewed counts.
---

Rule: hub "archive" is visibility-only (never delete). Two race guards are mandatory:
1. A row transitioning to `queued` clears its archive flag in the same UPDATE (an in-flight send must never be hidden), and archiving a queued row is refused.
2. Bulk archive-by-cutoff runs are bound to a SERVER-SIDE SNAPSHOT of the previewed id set (one-shot token, TTL'd in-memory map). The run archives EXACTLY that snapshot: it locks only snapshot members still eligible (FOR UPDATE + id IN list), rolls back with stale_preview/409 if any member left eligibility, and intentionally ignores rows that became eligible after the preview. Counts alone fail equal-count drift; even an id-digest recomputed from the predicate fails review — under READ COMMITTED a phantom row can slip in between predicate re-check and update. Snapshot-of-ids is the only race-free binding.

**Why:** preview and confirm are separate requests — a send/review/manual-archive in between would otherwise silently archive items the operator never saw; and an archive-then-requeue ordering would hide live sends from the default view.

**How to apply:** any new bulk visibility action (archive, dismiss, sweep) with a confirmation preview must bind the run to an id-set digest and compare it in-transaction on locked rows; any state machine whose rows can re-enter an "active" state must clear visibility flags on that transition.
