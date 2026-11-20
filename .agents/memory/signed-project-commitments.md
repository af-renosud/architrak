---
name: Signed project commitment scope
description: Project commitment totals must exclude quotations not yet signed.
---
Include only signed quotations or quotations explicitly recorded as signed in project commitment/liability totals. Show pending quotations as unsigned and excluded, not as contracted works.

Also show a combined signed-plus-unsigned quotation total directly beneath the pending quotation amount, with both HT and TTC.

**Why:** The user wants an overall quotation-budget figure alongside, not instead of, the signed-only legal commitment.

**How to apply:** Label this combined figure separately; never feed it back into signed commitment, certified or remaining-work totals.

**Why:** The user identified an unsigned quotation included in a payment certificate's total project commitments and explicitly requested signed-only totals.

**How to apply:** Keep pending budget/pipeline visibility separate from contractual commitment reporting. Do not infer signature from accounting activation or approval to sign. Preserve actual financial evidence on unsigned records as a visible exception rather than silently removing it.

Moving backwards from approved or signed workflow stages must require an explicit secondary confirmation rather than applying on a single stage click.

**Why:** The user reported an accidental backward click on a manually signed quotation, making it appear unsigned and blocked despite its retained signed evidence.

**How to apply:** Preserve signed evidence and distinguish reopening internal review from revoking a signature. Recovery should reuse verified existing evidence rather than require another signature.

Public project links are a different disclosure boundary from architect reports. Never extend their existing signed-summary payload with unrestricted project-wide pending or excluded-evidence totals.

**Why:** Even an aggregate can disclose the exact price of an unpublished draft by subtraction. Publishing one quotation to a token does not authorize showing other draft prices.

**How to apply:** Keep pending/evidence aggregates operator-only unless explicitly authorised for disclosure. The separately approved client-budget selection now authorises only its reviewed summary snapshots, independent of full-document publication; see [Client budget disclosure](client-budget-disclosure.md). Test selected and unselected drafts.

Quotation list frames must distinguish signed quotations (green) from quotations sent for signature and still awaiting it (orange); unsent quotations remain neutral.

**Why:** The user could identify signed quotations but could not quickly distinguish sent quotations from unsent ones.

**How to apply:** Preserve the distinction when cards expand; do not imply that an expired, rejected or cancelled signature request is still awaiting signature.
