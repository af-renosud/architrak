---
name: Payment-ledger atomicity
description: Invariants for the certificat client-payment ledger (locking, auto paid flip, grandfathering, draft policy)
---

Ledger mutations (create/correct/delete payment) run as ONE storage transaction: `SELECT … FOR UPDATE` on the certificat row, precondition re-check inside the tx (superseded/draft refused; locked once coverage ≥ TTC), payment write + append-only audit row (BEFORE snapshot) + conditional paid flip.

**Why:** check-then-write outside a tx let concurrent final payments both land, and a payment racing a reissue could resurrect a superseded certificat via an unconditional status update. Reviewer FAILED the first design on exactly this.

**How to apply:**
- The paid flip is one-way and conditional: `UPDATE … WHERE status NOT IN ('paid','superseded')` — never revive terminal rows even from a stale snapshot.
- Lock ordering: always lock the parent certificat first, then read payments; a pre-tx payment lookup is only for parent discovery and must be revalidated inside the lock.
- Lock/refusal is based on ACTUAL coverage, not status — grandfathered status-only paid certs still accept historical entries and never un-flip.
- Sealed certs can't be PATCHed to status=paid without full ledger coverage (409 PAYMENTS_INCOMPLETE); drafts refuse payments server-side to match the UI.
- Storage returns discriminated outcomes ({ok|not_found|superseded|draft|locked}); the service maps them to typed errors — missing rows must be not_found, never fake success.
