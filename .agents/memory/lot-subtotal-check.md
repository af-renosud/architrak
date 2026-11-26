---
name: Lot subtotal check for AI-read quotations
description: How printed section subtotals are captured and checked when no exact table reader recognises a quotation.
---

Rule: the model reports printed section subtotals separately (sectionSubtotals) and tags each line with its innermost section heading; the server (never the model) resolves them into printedSubtotals with covered line numbers. The check only warns (review), never corrects, and is skipped when nativeTableRecovery is set or lines carry no section tags.

**Why:** grand-total checks miss two lot errors that cancel out; nested recaps must not double count, so lines bind to sections by heading and parents inherit children's lines once.

**How to apply:** new model-authored fields must also be added to the zod response schema in the extraction-response decoder — it silently strips unknown fields. Keep optional evidence lists `.catch(undefined)` so a malformed list never fails the whole extraction.
