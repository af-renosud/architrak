---
name: Certificate email delivery state
description: Durable rule separating certificate workflow status from proof that the client email was delivered.
---

A certificate is emailed only when it has a successful `certificat_sent` communication with a delivery time and recipient. Operators must not create that state by manually selecting “Sent”. A legacy certificate whose status says sent but lacks this evidence remains an undelivered, sendable certificate; its sealed financial figures are not reopened.

**Why:** Treating an editable status as delivery proof hid the send action after accidental status changes and trapped valid sealed certificates without ever emailing the client.

**How to apply:** Any list, badge, reminder, detail view, or send-action gate concerning client delivery must use successful communication evidence. Continue to dispatch through the existing deduplicated, atomic communication path; never implement a second resend path.