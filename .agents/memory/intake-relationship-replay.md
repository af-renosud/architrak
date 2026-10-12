---
name: Intake relationship replay
description: Document linkage and financial continuation must remain separate from global duplicate detection.
---

An invoice already owned by the same intake source is continuation evidence, not a duplicate to discard. Resume its financial processing before declaring that source routed; already-routed sources must short-circuit a reclaimed queue job.

**Why:** Invoice persistence, deposit application, source promotion and job acknowledgement can be interrupted at different boundaries. Global duplicate detection otherwise swallows the very record needed to finish a crashed attempt.

Deleting a draft invoice must release its source in the same transaction, while retaining the PDF and prior processing notes. Do not automatically recreate the invoice merely because it was deleted: a new upload or explicit re-analysis is the operator's request to recreate it. Duplicate-only followers must not become duplicate-detection anchors.

**Why:** a retained source pointing to a deleted invoice blocked a replacement upload even though there was no financial record left to manage. Automatically requeueing every deletion would instead undo the user's deliberate deletion.

**How to apply:** Verify the source/project/contractor/devis tuple on reuse, preserve idempotent financial effects, and guard every fallback park/failure update against overwriting a concurrent human promotion. Relationship resolution must validate all explicit parent references, including legacy line text alongside typed extraction. Source and relationship evidence must be revalidated at the final write, not just during preview.