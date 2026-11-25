---
name: Client publication is live, not frozen
description: What the client portal showed for a quotation is not preserved; only a version hash is audited.
---
Publishing a quotation to the client project link records only an audit row with a decision-version hash. The portal renders live translation/context data, and cached translated/combined PDFs are regenerated after edits. There is no frozen copy of what the client actually saw.

**Why:** On 2026-11-25 the user needed an exact audited copy of a replaced quotation "as shared with the client" and none existed (contexts were edited after publication). They called this critical.

**How to apply:** The contractor's original PDF (pdf_storage_key) is never modified and is the reliable record. Any work on client disclosure should consider freezing a rendered snapshot at publish time; never claim the current combined PDF equals what was shared.
