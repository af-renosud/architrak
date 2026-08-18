---
name: Certificat source scoping
description: How certificat PDFs/seals/derivations must follow explicit certificat_sources rows; multi-facture grouping rules.
---

- The certificat PDF generator scopes its content (devis details, IBAN mismatch gate, annexe, driveSeed, sourceInvoiceIds) to the certificat's `certificat_sources` invoice rows when any exist; EMPTY sources = legacy whole-contractor scope (manual/acompte certs). Any new render/link path must respect this split.
- **Why:** a grouped (multi-facture) certificat that rendered every contractor invoice would visually authorize payment for factures it doesn't certify.
- Grouped creation lives in one service (`certificat-from-invoices.service`); single-invoice endpoints are wrappers. Creation is one tx: advisory lock (projectId, contractorId) + ordered FOR UPDATE on invoices AND parent devis + re-derivation under lock + a TX-SCOPED join re-check that no live cert already sources any selected invoice + STRICT source insert (no onConflictDoNothing; count must equal N or rollback).
- Mixed-TVA selections are refused (409 TVA_MIXED) via `checkInvoiceSetTvaCompatibility` (aggregate effective rate, ±2 cents per facture); documentary TVA resolution takes an explicit `documentaryBasisInvoices` so the rate reflects only the certified documents.
- Reissue copies the original's `certificat_sources` rows inside the supersede tx, or the replacement loses invoice provenance.
- The seal path takes the same (projectId, contractorId) advisory lock inside `storage.sealCertificat` and, under it, REFUSES the whole seal (typed conflict error, full rollback — no seal columns, no snapshot) when any source row is already claimed by another non-superseded certificat. Refuse, don't skip: the rendered PDF's figures include the contested facture, so dropping only the link would still issue a double payment authorization. Superseded certs never block; grouped creation's tx-scoped re-check covers the reverse ordering.
