---
name: Email intake noise cuts
description: Constraints around attachment dedupe, echo suppression, and project auto-assignment in the email intake
---
- **Product constraint (2026-11-02):** the user reports that auditing irrelevant email attachments takes more work than manually uploading documents. Optimise intake for reduced human review, not merely reduced AI processing.
  **Why:** parking documents is not enough if the ordinary list still asks an architect to inspect them.
  **How to apply:** evaluate future intake proposals by actionable review volume and missed relevant documents; keep recovery available without making parked items routine work.
- **Financial-only intake scope (2026-11-02):** the user states inbound devis/factures are always PDF attachments, with the client name in the email and almost always in the PDF. Require exact client/project correlation plus financial-document terminology inside the PDF (DEVIS or FACTURE, with AVOIR and AVENANT also relevant). Plans, details and other nonfinancial documents are explicitly irrelevant, not a separate reference-ingestion feature.
  **Why:** known-sender matching admits too much material unrelated to the financial workflow.
  **How to apply:** narrow admission to content evidence; unknown senders may qualify, known senders alone may not. This supersedes the old product requirement for unconditional firm-domain admission; preserve legitimate fee invoices through the same content gate. This is the agreed scope, not a claim that implementation has changed.
- **Financial vocabulary emphasis:** the user confirmed the financial-only scope and specifically emphasised HT, TTC and TVA as expected financial indicators.
  **Why:** dismissing these as merely generic keywords understates their value in recognising financial content.
  **How to apply:** treat one or more as strong corroborating evidence, especially beside amounts or tax rates, while retaining exact client/project identity and financial-document-purpose checks.
- **Quotation vocabulary (2026-11-10):** the user requested recognition of any whole-word “devis” inside a PDF, not just a heading starting with it.
  **Why:** legitimate quotations use prefixes such as “Réf. Devis” and repeat titles on later pages.
  **How to apply:** search throughout the PDF; preserve explicit nonfinancial-title exclusions and client identity safeguards. Recognition alone is not project assignment.
- **Echo suppression must not become admission by sender:** recognise generated-document purpose/provenance; a service domain alone does not establish that every attached document is already retained.
- **Attachment dedupe**: sha256 fingerprint with a partial UNIQUE index; capture does lookup→append-source, and on insert conflict (code 23505, unwrap pg `cause`) the loser appends itself to the winner. Appending a source never changes extractionStatus (skipped stays terminal/hidden).
- **Identity authority:** exact PDF client/project evidence takes precedence over email context. Email body/subject may fill absent identity, not override conflicting PDF identity; sender and filename tokens are not assignment evidence.
- **Shared clients and firm invoices:** an exact project name disambiguates a shared client name, without overriding conflicting project/client evidence. Retain Sent-folder scan coverage for firm fee invoices; content still decides admission.
  **Why:** shared clients otherwise produce false ambiguity, and a blanket Sent exclusion loses the existing fee-invoice capture workflow.

**Why:** these were the three prod noise causes (duplicate captures, self-echoes, unassigned completed docs); loosening any guard regresses Tasks #322/#425/#503 behavior.
