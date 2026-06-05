---
name: Overlap-case human resolution leaves the case active
description: Why read surfaces must exclude human-resolved overlap cases, not just dismissed ones
---

# Confirmed overlap cases stay active/needs_review

A human `confirm` on an overlap case supersedes its member devis but does NOT
change the overlap case row's `status` (`active`) or `verdict` (`needs_review`).

**Why:** reconciliation detection scopes devis by `status !== "void"`, NOT by
`accountingState`. Superseded members still have a non-void `status`, so the
same overlap is re-detected every sweep and the case is upserted back to
`active`/`needs_review` (it is never withdrawn). There is no code path that flips
a case to a resolved/closed status after a human decision — the decision lives
only as `human_confirm` / `human_dismiss` rows in `accountingStateChanges`.

**How to apply:** any read surface that lists or counts "needs review" cases must
exclude EVERY humanly-resolved case (confirm AND dismiss), keyed by
`overlapCaseId` in `accountingStateChanges`, not just dismissed ones. Excluding
only dismissed (the original behaviour) makes confirmed cases linger in the
review queue and the project status badge forever. Use
`storage.getResolvedOverlapCaseIds(projectId)` for this. The provisional-promotion
gating paths (`reconcileAccountingStates`, `applyHumanResolution`'s
`stillUnderReview`) intentionally still use dismissed-only, because a confirm
already supersedes/promotes the affected devis so it cannot wrongly gate a
provisional→active promotion there.
