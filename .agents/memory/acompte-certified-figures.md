---
name: Acompte in Certified figures
description: How the financial summary counts acompte certificats without double-counting recouped deposits
---

Opening deposit **requests** must remain distinct from deposits **already paid**. A contractor PDF may print the full contract totals and separately request a percentage as a “FACTURE D'ACOMPTE”; the lower requested sum is not inherently an extraction error.

**Why:** the user's contractor example prints full TTC €69,674 alongside a 30% request of €20,902.20. Treating every net amount as full TTC minus deductions produces a false warning.

**How to apply:** require explicit source wording and matching percentage arithmetic before exempting this case; never infer a paid deposit or suppress unrelated discrepancies. Preserve the full-contract extracted totals as source evidence, but populate the financial invoice with the verified deposit request (not the full contract), converting TTC to HT only with a single consistent document-declared TVA rate.

Contractors commonly request an opening deposit only as a gross TTC amount. The user wants substantial explanatory context identifying the full contract reference, requested percentage/TTC, source TVA, and derived HT/TVA—not just corrected numbers.

**Why:** suppressing a mismatch warning alone left full-contract totals in the editable invoice and forced the architect to manually reverse-calculate HT, risking over-certification.

**How to apply:** new invoice ingestion (including manual intake promotion) uses the verified request; existing drafts get an explicit apply action rather than silent overwrites. Linked HT/TTC edits need a source-backed single rate; missing, conflicting or multiple rates require review. Requested deposits remain distinct from already-paid deductions.

An optional apply-deposit button and correct source extraction are not sufficient financial safeguards.

**Why:** a legacy full-contract draft was confirmed and approved despite retaining explicit evidence of a smaller opening request; its full-value commission was then created. Validating gross source arithmetic alone does not validate the amount being approved.

**How to apply:** amount-basis conflicts need server-authoritative resolution at confirmation, approval and certificate use. Correcting an approved invoice must account for dependent fees and pre-existing certificates, including legacy certificates without explicit source links; absence of junction rows is not evidence of independence.

"Certified" per devis = gross facture sums + OUTSTANDING acompte (issued, non-superseded acompte cert works HT minus contractor-level `cumulativeAcompteRecoupment` read from the LATEST issued non-superseded progress cert — latest-prior rule, never max()/sum()). A source-bound immutable invoice application is authoritative proof that the deposit was recovered and therefore contributes 0, even if the devis workflow state is stale; `acompteState = 'applied'` remains the normal lifecycle representation. When that gross invoice is certified, its applied HT enters certificate previous-payments exactly once; later certificates inherit it through the prior chain. Once an application exists, the database—not only individual routes—must seal the invoice's economic and source-provenance facts.

**Why:** an acompte cert has no facture; without this a client sees a payment demand next to "Certified 0,00 €". A later gross invoice can retain its full documentary value while separately proving the exact deposit deduction. Counting both that gross invoice and the deposit overstates certified totals, while relying only on mutable workflow state can reintroduce the error.

**How to apply:** preserve gross invoice amounts for audit and show the exact applied deposit/net balance separately. Suppress the deposit from certified totals whenever immutable application evidence exists, and also advance the devis to `applied`. For invoice-derived certificates, keep gross works unchanged and add only applications belonging to the selected, not-yet-certified source invoices to previous-payments; never add the opening certificate independently. When the source evidence establishes an exact balance, freeze that decision with the certificate; later contract metadata must not reinterpret it, while unrelated certificates retain their established fallback policy. Seal protected invoice fields and deletion centrally because admin/background write paths can bypass route guards. If confirmation spans transactions, capture the protected facts after canonical validation, compare them under the application lock before inserting, and compare again under the final status-transition lock. For certificat issuance, the status gate is ready/sent/paid but rendering happens while the row is still `draft`; `treatAsIssuedCertificatIds` must govern both deposit selection and the recoupment source.
