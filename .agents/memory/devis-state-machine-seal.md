---
name: Devis state-machine column seal
description: Any state-machine column on the devis table must be stripped from the generic PATCH /api/devis/:id route, not just validated.
---

# Devis state-machine columns must be sealed from the generic PATCH

When a new column on `devis` is governed by a dedicated state machine with its
own audit trail and transition rules, the column must be **explicitly deleted
from the patch body** in the generic `PATCH /api/devis/:id` handler
(`server/routes/devis.ts`), even though `validateRequest` accepts it via
`insertDevisSchema.partial()`.

Known sealed columns and their owning machines:
- `acompteState` / `acompteInvoiceId` / `acomptePaidAt` → `/acompte/*` routes.
- `accountingState` → `reconcileAccountingStates` (auto) +
  `/api/overlap-cases/:id/resolve` (human), each writing an append-only audit
  row via a compare-and-set transition. Freshly created/ingested devis start
  `provisional`; every ingest/create path (intake queue, direct upload, AND the
  manual create route) must seal the initial state to `provisional` and then
  enqueue reconciliation for the project, or the row stays out of Contracted
  indefinitely. Human resolution only applies to `needs_review` overlaps:
  arithmetically `proven` overlaps must be left to the automatic pass — accepting
  a human `dismiss` on a proven case records dismissal metadata that suppresses
  auto-supersede and double-counts the duplicate forever.

**Why:** the generic PATCH validates *shape* but not *transition legality*.
Because these are ordinary columns, an authenticated operator could otherwise
set any value directly — moving money into/out of Contracted with no audit row,
no CAS, and no overlap-case decision. Validation alone does not seal a state
machine; the column has to be removed from the writable payload.

**How to apply:** whenever you add a state-machine / lifecycle column to
`devis`, strip it from the generic PATCH handler (delete it from the patch body),
and on every create path either omit it or set the controlled initial value as
the LAST key of the insert object so it overrides any `...req.body` spread the
client could inject.
