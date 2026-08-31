---
name: No-invoice deposit evidence
description: Integrity rules for confirming a supplier deposit paid without a supplier invoice.
---

Treat confirmation of a supplier deposit without an invoice as a financial provenance event, not a convenience state change. Lock the devis, project, and source evidence; require explicit paid wording plus an exact rounded amount; create or reuse one internal certificat; and keep the audit row append-only.

**Why:** A supplier may legitimately omit an opening deposit invoice, but inferring payment without exact evidence can fabricate financial history. Concurrent archive, deletion, reanalysis, and replay requests can otherwise detach or mutate the only supporting PDF.

**How to apply:** Freeze the source storage identity and content fingerprint in the audit row, reject archived projects in the transaction and at typed-record inserts, coordinate reanalysis with the source-row lock, and commit database deletion before deleting object-storage bytes.