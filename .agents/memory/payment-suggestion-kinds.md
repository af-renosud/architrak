---
name: Payment suggestion kinds describe one transfer
description: Client "we paid" and contractor "we received" replies are two views of the SAME transfer — confirm must close the counterpart.
---

Rule: certificat payment suggestions come in kinds (client_paid, contractor_received) with a per-(certificat, kind) pending-unique index, so both can be open at once. Confirming EITHER one records the ledger entry and must atomically dismiss all other open suggestions on that certificat in the same transaction.

**Why:** both replies report the same money movement; leaving the counterpart open lets a second confirm double-record the transfer (the paid lock only blocks the full-coverage case, not partial/overridden amounts).

**How to apply:** any new suggestion kind or confirm path must keep the counterpart auto-dismiss inside the confirm transaction; a genuine additional payment goes through the manual ledger UI. Also: outbound recipient addresses are validated with the strict single-address validator (CR/LF rejection) before any raw RFC-2822 assembly — never `includes("@")`.
