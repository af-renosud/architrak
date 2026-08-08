---
name: Email sender pre-filter
description: Deterministic pre-filter that gates AI extraction of Gmail-captured PDFs
---
Rule: any path that can trigger AI extraction of an email document must respect the deterministic sender/subject pre-filter; docs with no contractor/client/project signal are parked as `unmatched_sender` (visible in the queue, rescuable via project assignment or force re-analyze).

**Why:** unrelated PDFs (newsletters, receipts) were burning full vision tokens and clogging needs_review. The filter is enforced both at Gmail capture (monitor stores unmatched docs directly, so the sweeper never picks them) and at the processing boundary (protects manual/other callers).

**How to apply:**
- Freemail domains (gmail.com, orange.fr, …) are excluded from domain-level matching — one gmail contact must never whitelist all of Gmail; exact-address matches still pass.
- Construction keywords (devis, facture, …) pass on purpose so a brand-new contractor's first devis isn't dropped.
- Operator bypass = `force: true` on the manual process route → `bypassPrefilter` option; also pass automatically when projectId/contractorId already set.
- Test doubles of the storage layer may lack newer methods — optional-signal lookups must tolerate a synchronous throw (`Promise.resolve().then(...)`), not just a rejected promise.
