---
name: Architect invoice source and delivery
description: Architect commission invoices originate in external accounting software.
---
The user generates the architect's commission invoice in proprietary accounting software and wants to be able to send that original invoice with the outbound payment certificate.

The user identified that accounting software as Pennylane on 2026-10-06. They currently operate the two systems disconnected despite earlier integration development, and want a copyable certificate-based paragraph for manual invoice preparation.

**Why:** Existing integration code does not mean the user wants synchronization activated. The description should be reusable for eventual automation without requiring it now.

**Why:** The requested convenience is delivery of an existing accounting document, not creation of a replacement invoice inside the certificate.

**How to apply:** Preserve the external invoice as its own PDF and separate the architect's fee from the contractor payment amount. Any future attachment workflow should explicitly select the correct project invoice before dispatch.

The user requested a warning before sending without the invoice and a quickly visible attachment status in certificate records. This is a reminder with explicit “send without” confirmation, not a mandatory invoice requirement.

**Why:** Some certificates legitimately go out without an architect invoice. Financial sealing and email attachment preparation are separate steps: the invoice is prepared externally and may be attached after the certificate PDF exists.

**How to apply:** Never equate “attached now” with “sent with invoice.” Keep the actual delivery choice stable for retries, and show unknown history for older sends rather than fabricating a yes/no answer.
