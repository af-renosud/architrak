---
name: Extraction provider boundaries
description: Lessons from malformed AI output and multi-page replacement quotation checks
---
Treat readable totals and a successful AI response as separate from a complete, reconciled item list.

**Why:** A nine-page replacement quotation yielded the correct header totals while omitting work rows and including the final summary as extra charges. Correct totals did not make its items safe to apply.

**How to apply:** Test real dense documents against both row coverage and reconciliation. Keep failures reviewable, never automatically apply a partial extraction, and do not substitute the document total for missing rows.

Numbered-table recovery must reconcile each section and its recap, not just the grand total, and retain explicitly unpriced work descriptions.

**Why:** Nested recap rows duplicate parent totals, while a genuine electrical-work row can have quantity but blank price columns. Blind monetary-row counting both overcounts the recap and loses that work description.

**How to apply:** Preserve original blank-price evidence, compare persisted fingerprints using the storage representation, and treat summary pages as non-item pages only after the strict whole-table checks pass.

Optional model-generated PDF boxes may arrive in an unsupported format even when financial fields are valid. Discard an invalid visual hint rather than guessing its coordinates or rejecting all financial content; retain strict validation for money and descriptions.

**Why:** A real OpenAI response supplied arrays where the application expects named box coordinates.

**How to apply:** Keep model-authored hints distinct from deterministic source-verification evidence. Never allow model output to create a verification receipt.
