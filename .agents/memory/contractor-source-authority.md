---
name: Contractor quotation source authority
description: Human corrections repair ingestion only and cannot amend contractor figures.
---
The user states: “No architect or user is allowed to manually change, in any way whatsoever, a contractor's quotation in terms of the physical figures. We are only correcting ingestion errors.”

The ingested original PDF is the ultimate reconciliation reference. Its source quantities and global amounts must not be changed through correction tools. Corrected extraction is a separate representation, not an amended contractor quotation.

Every removed extracted line requires a human-defined reason entered by typing or dictation. Dictated text must be visible for review and confirmation, and the confirmed reason retained with actor, timestamp and original row evidence.

**Why:** A duplicate extracted line must be removed without giving operators permission to alter contractual figures or conceal the discrepancy by changing source totals.

**How to apply:** Keep source evidence distinct from corrected working data. Never make source totals follow the working-row sum. Enforce authority server-side, not just with disabled inputs; inspect generic editing endpoints for bypasses. Do not substitute an automatically generated audit reason for human justification.

Missing intake totals are not authoritative contractor figures: a zero placeholder or a missing HT/TTC copied from the other total needs a narrowly audited transcription path from the PDF.

**Why:** Freezing placeholders prevents failed/manual intake drafts from ever completing. This exception fills absent evidence; it must not reopen a recorded source figure or a previously confirmed transcription for editing.

**How to apply:** Require a human reason and preserve the original extraction, with confirmation and its audit in one transaction. Protect signed/closed documents using durable evidence, not just a workflow stage that an operator can move backwards.

Missing/misread row corrections require a page-specific original-PDF transcription, not a commercial revision. Text-layer evidence is corroborated against the source; image-only pages remain explicitly human-attested, never labelled machine-verified.

**Why:** Scanned contractor quotations still need ingestion repair, but an operator's transcription and automated verification are different kinds of evidence. Neither permits changing authoritative document totals.

**How to apply:** Bind confirmation to the source content digest and working-state preview; retain the verification mode, original row, corrected row and confirmed human reason separately from raw extraction.

The user clarified that two equal-price joinery rows were legitimate separate items: descriptions had shifted and the terminal product description was missing. Do not infer duplication from matching prices or repair an association error by deleting an item. Re-extract against the source rather than manually moving descriptions.

**Why:** Financial agreement and equal prices cannot establish product identity or complete specifications.

The user conditionally wants the editing restrictions reconsidered if monitoring reveals recurring inaccurate scrapes. A future full-editing mode would require matching an independently verified, locked source TTC. This is a future policy review, not current permission to enable unrestricted editing.

**Why:** Imperfect OCR must not leave operators permanently unable to correct legitimate quotations. Matching TTC protects the total but not item associations, specifications or VAT treatment.

**How to apply:** Monitor confirmed errors separately from warnings and retries, including mistakes found after automated checks passed. Preserve original source evidence and before/after history; obtain explicit authorization before changing editing permissions.