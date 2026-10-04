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