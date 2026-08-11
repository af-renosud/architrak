---
name: Fee-invoice ref reconciliation is global
description: Invoice-reference conflict scans must cover ALL fee entries, not just the chosen project's.
---

Rule: when reconciling an inbound fee-invoice reference against fee entries, scan and lock (FOR UPDATE) matching entries across ALL projects, not only the operator-selected project; park on any different entry bearing the ref.

**Why:** a project-scoped scan let an invoice already recorded in another project be invoiced a second time (caught in code review of the works-commission confirm flow). Normalization must be done SQL-side (lower + strip non-alphanumerics, mirroring shared normalizeRef) so the scan can lock rows in the same transaction.

**How to apply:** any new confirm/reconcile path touching fee_entries pennylane_invoice_number / pennylane_invoice_ref should reuse `lockEntriesBearingRef` in architect-fee-invoice-confirm.service.
