---
name: Quotation approval integrity
description: Content coverage, prepared-proposal versions, linked questions and mutable translation approval.
---

Automatic extraction coverage must be bidirectional: preserve every source segment, and reject automatic candidate content not attributable to that item's source. This is not a veto on explicitly saved or approved human content.

**Why:** A candidate containing both correct descriptions plus another item's complete specification could pass a presence-only comparison with unchanged totals.

**How to apply:** Test additive contamination as well as missing/shifted passages. Shared specifications are legitimate only when independently present in each relevant source section.

Prepared proposals belong to their preparation-time quotation, lines and translation, not the state found when Apply is clicked.

**Why:** A request-time concurrency check alone lets an old proposal overwrite a newer successful extraction.

**How to apply:** Persist the preparation fingerprint and compare it under replacement locks; reject legacy proposals lacking it. Preserve line-linked questions independently of the line's checked/unchecked flag.

Translation approval belongs to exact content. Inline changes must invalidate approval before any client-facing surface can read them.

**Why:** The portal and package gates intentionally trust finalised status; retaining that status after editing publishes unchecked content. Verification and approval also need a version-bound commit to prevent concurrent edits.

**How to apply:** Clear approval and PDF cache metadata atomically with content changes, bump the PDF version, and reject stale finalisation.

Architect source confirmation records the original PDF digest and independently transcribed TTC. Human corrections and approval are not gated by an OCR manifest or translation semantic model, including legacy illustrated evidence. Financial corrections must reconcile exact cents with actual VAT, discounts and options. Automatic extraction acceptance remains strict.

**Why:** Stored parser flags survive ordinary description edits; a line-only receipt survives contradictory header edits. Neither is current approval evidence.

**How to apply:** Use version-bound transactional human saves, immutable PDF/TTC receipts and actor/time before-and-after audit. Ordinary Save/Approve distinguishes human review from machine verification. Canonicalize receipt keys; preserve manual translations, source bytes and signed snapshots. Signing corrected packages must contain the original PDF and cannot fall back to translation-only evidence.