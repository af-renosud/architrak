---
name: Quotation approval integrity
description: Content coverage, prepared-proposal versions, linked questions and mutable translation approval.
---

Coverage must be bidirectional: preserve every source segment, and reject candidate content not attributable to that item's source.

**Why:** A candidate containing both correct descriptions plus another item's complete specification could pass a presence-only comparison with unchanged totals.

**How to apply:** Test additive contamination as well as missing/shifted passages. Shared specifications are legitimate only when independently present in each relevant source section.

Prepared proposals belong to their preparation-time quotation, lines and translation, not the state found when Apply is clicked.

**Why:** A request-time concurrency check alone lets an old proposal overwrite a newer successful extraction.

**How to apply:** Persist the preparation fingerprint and compare it under replacement locks; reject legacy proposals lacking it. Preserve line-linked questions independently of the line's checked/unchecked flag.

Translation approval belongs to exact content. Inline changes must invalidate approval before any client-facing surface can read them.

**Why:** The portal and package gates intentionally trust finalised status; retaining that status after editing publishes unchecked content. Verification and approval also need a version-bound commit to prevent concurrent edits.

**How to apply:** Clear approval and PDF cache metadata atomically with content changes, bump the PDF version, and reject stale finalisation.

Source confirmation must revalidate locked working rows, including legacy illustrated evidence without a verified manifest. Translation receipts must bind French and English headers as well as every translated line.

**Why:** Stored parser flags survive ordinary description edits; a line-only receipt survives contradictory header edits. Neither is current approval evidence.

**How to apply:** Use the same live source verifier at confirmation and later approval boundaries. Canonicalize object keys when hashing JSON receipts: PostgreSQL JSONB can reorder keys from the provider's original object.