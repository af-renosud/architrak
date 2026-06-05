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
  `/api/overlap-cases/:id/resolve` (human), each writing an append-only
  `accounting_state_changes` row via a compare-and-set transition. Freshly
  ingested devis start `provisional`; every ingest path (intake queue AND the
  direct `/devis/upload` route) must `enqueueReconciliation(projectId)` after a
  successful upload or the row stays out of Contracted indefinitely.

**Why:** the generic PATCH validates *shape* but not *transition legality*.
Because these are ordinary columns, an authenticated operator could otherwise
set any value directly — moving money into/out of Contracted with no audit row,
no CAS, and no overlap-case decision. Validation alone does not seal a state
machine; the column has to be removed from the writable payload.

**How to apply:** whenever you add a state-machine / lifecycle column to
`devis`, add a `delete patchBody.<col>` in the generic PATCH handler next to the
existing `delete patchBody.acompteState` / `delete patchBody.accountingState`
block, and confirm the create path uses an explicit insert literal (not a
`...req.body` spread) so the initial value can't be injected either.
