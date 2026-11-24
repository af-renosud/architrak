---
name: Architect-selected quotation replacement
description: Replacement is a human decision with explicit old/new links and context, not an inferred similarity relationship.
---
The architect decides that one processed project quotation replaces another, even when references and scope differ substantially. Provide a prominent Replace action, a project quotation selector and a contextual explanation recorded with the decision.

The user also wants reusable architect-authored setup, descriptions, translations and context preserved across replacement quotations where the underlying content remains common.

**Why:** Replacement should not force the architect to recreate work already invested in the preceding version.

**How to apply:** Once the architect designates the replacement, automatically carry forward authored descriptions, translations, amendments, context and images for uniquely matched unchanged source items, without per-item selection or confirmation. Distinguish reusable authored content from contractor-source evidence and approvals; never copy signatures, financial history or stale approvals.

Zero-friction carry-forward for exact unchanged items is a central product requirement, not merely an optional suggestion list.

**Why:** The user explicitly wants no operator input for unchanged items when a revised quotation adds or removes a few entries. Repeating prior work defeats the purpose of replacement.

**How to apply:** Match underlying contractor-source content rather than requiring edited working descriptions to equal newly extracted text. Preserve the revised PDF's authority for scope and figures. Surface only changed, ambiguous or conflicting items for decisions; report automatic transfers without making acknowledgement another prerequisite.

Legacy edited rows without a recoverable source identity must not be matched solely by their price or position.

**Why:** Older quotations can have edited French descriptions without a pre-edit row binding. An original extraction with similar prices is not proof that a particular working row belongs to it.

**How to apply:** Prefer immutable pre-edit history or unique source-page coordinates with matching figures. Keep unproven work on the previous version and expose it for explicit assignment rather than fabricating exact matches.

Applying a prepared extraction as part of a replacement must be atomic with superseding the previous quotation.

**Why:** A two-request sequence can leave recovered figures applied but the replacement incomplete, or retire the earlier quotation before its successor is usable.

**How to apply:** Validate both reviewed versions, hold signature/project/quotation locks consistently, use one transaction, and defer translation and object cleanup until after commit.

Translation context, especially embedded images, is the user's highest-value authored content. Preserve the complete rich document and saved image sizes, not just extracted text. Copies must own independent image bytes and asset identities.

**Why:** The user identified recreating translation context and images as the biggest potential loss of time. Sharing the old asset ownership or storage key would let old-quotation cleanup break the new quotation.

**How to apply:** Automatically transfer unique unchanged lines; require explicit assignment for changed or ambiguous rows. Protect existing replacement content, retain unassigned work on the original with a later recovery path, and do not impose repeat item review solely for automatic carry-forward. Structured internal codes retain their descriptive name but need a distinct sequence because prior versions retain their identity.

**Why:** The user found conditional same-reference controls impossible to discover and explicitly rejected relying on AI to determine replacement where many items change.

**How to apply:** Treat the selection as an explicit relationship, preserve originals and financial history, and keep replacement context internal. Do not infer replacement automatically or require identical references.

Replaced quotations belong in collapsed previous-version history beneath the latest quotation, not as competing main-list cards.

Replacement relationship details on the current quotation must also be collapsed by default, behind a small reveal control.

**Why:** The user explicitly finds the always-visible replacement reference, notes and previous-work actions distracting once replacement is complete.

**Why:** The user found separate superseded cards confusing even with status badges.

**How to apply:** Follow only explicit replacement links, keep old references searchable and directly accessible, and leave incomplete or unavailable relationships visible rather than hiding evidence.

Replacement must serialize against the entire external signature-send operation, not just inspect an envelope ID.

**Why:** Sending includes PDF preparation and an external create call before the envelope ID is persisted. A replacement during that interval could retire the quotation while its signature invitation is still being issued.

**How to apply:** Keep a shared lock across signing and replacement. Persist the explicit relationship and supersession together; never copy signed status to the chosen successor.
