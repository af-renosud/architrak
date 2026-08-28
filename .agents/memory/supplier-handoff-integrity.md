---
name: Supplier handoff integrity
description: Integrity rules for on-demand ArchiDoc supplier certificate data across seal and dispatch.
---

Supplier certificate creation uses the on-demand ArchiDoc handoff as its authoritative payment input. Sealing must use one explicit-date handoff snapshot for source-bank comparison, protected-RIB verification, rendering, and immutable evidence; never refetch independently between those steps. Dispatch must compare current handoff identity, date, and full content digest with the sealed evidence and require reissue on divergence. Keep the project rollout gate server-side and invisible rather than removing it from the safety boundary.

**Why:** Independent handoff fetches can observe different banking or RIB versions, causing invoice evidence to be validated against one payment instruction while another is issued or sent. Hiding rollout mechanics from users does not authorize removing the production kill switch.

**How to apply:** Any supplier preview/create/seal/send change must carry one explicit issue date, reuse the same handoff within an issuance operation, keep protected values out of browser/log output, and preserve the sealed-history rollout bypass without bypassing live identity, source, amount, or digest checks.