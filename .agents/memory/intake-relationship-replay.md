---
name: Intake relationship replay
description: Document linkage and financial continuation must remain separate from global duplicate detection.
---

An invoice already owned by the same intake source is continuation evidence, not a duplicate to discard. Resume its financial processing before declaring that source routed; already-routed sources must short-circuit a reclaimed queue job.

**Why:** Invoice persistence, deposit application, source promotion and job acknowledgement can be interrupted at different boundaries. Global duplicate detection otherwise swallows the very record needed to finish a crashed attempt.

**How to apply:** Verify the source/project/contractor/devis tuple on reuse, preserve idempotent financial effects, and guard every fallback park/failure update against overwriting a concurrent human promotion. Relationship resolution must validate all explicit parent references, including legacy line text alongside typed extraction. Source and relationship evidence must be revalidated at the final write, not just during preview.