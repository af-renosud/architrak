---
name: Acompte in Certified figures
description: How the financial summary counts acompte certificats without double-counting recouped deposits
---

"Certified" per devis = gross facture sums + OUTSTANDING acompte (issued, non-superseded acompte cert works HT minus contractor-level `cumulativeAcompteRecoupment` read from the LATEST issued non-superseded progress cert — latest-prior rule, never max()/sum()). A source-bound immutable invoice application is authoritative proof that the deposit was recovered and therefore contributes 0, even if the devis workflow state is stale; `acompteState = 'applied'` remains the normal lifecycle representation. Once that application exists, the database—not only individual routes—must seal the invoice's economic and source-provenance facts.

**Why:** an acompte cert has no facture; without this a client sees a payment demand next to "Certified 0,00 €". A later gross invoice can retain its full documentary value while separately proving the exact deposit deduction. Counting both that gross invoice and the deposit overstates certified totals, while relying only on mutable workflow state can reintroduce the error.

**How to apply:** preserve gross invoice amounts for audit and show the exact applied deposit/net balance separately. Suppress the deposit from certified totals whenever immutable application evidence exists, and also advance the devis to `applied`. Seal protected invoice fields and deletion centrally because admin/background write paths can bypass route guards. If confirmation spans transactions, capture the protected facts after canonical validation, compare them under the application lock before inserting, and compare again under the final status-transition lock. For certificat issuance, the status gate is ready/sent/paid but rendering happens while the row is still `draft`; `treatAsIssuedCertificatIds` must govern both deposit selection and the recoupment source.
