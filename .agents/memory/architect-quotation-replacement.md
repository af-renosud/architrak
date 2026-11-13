---
name: Architect-selected quotation replacement
description: Replacement is a human decision with explicit old/new links and context, not an inferred similarity relationship.
---
The architect decides that one processed project quotation replaces another, even when references and scope differ substantially. Provide a prominent Replace action, a project quotation selector and a contextual explanation recorded with the decision.

**Why:** The user found conditional same-reference controls impossible to discover and explicitly rejected relying on AI to determine replacement where many items change.

**How to apply:** Treat the selection as an explicit relationship, preserve originals and financial history, and keep replacement context internal. Do not infer replacement automatically or require identical references.

Replacement must serialize against the entire external signature-send operation, not just inspect an envelope ID.

**Why:** Sending includes PDF preparation and an external create call before the envelope ID is persisted. A replacement during that interval could retire the quotation while its signature invitation is still being issued.

**How to apply:** Keep a shared lock across signing and replacement. Persist the explicit relationship and supersession together; never copy signed status to the chosen successor.
