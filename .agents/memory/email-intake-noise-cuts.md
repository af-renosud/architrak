---
name: Email intake noise cuts
description: Constraints around attachment dedupe, echo suppression, and project auto-assignment in the email intake
---
- **Firm-domain pass is a guarantee**: mail from the firm's own domain (other than the linked inbox's exact address) must pass the prefilter unconditionally — fee-invoice capture depends on it and a test enforces it. Only the linked-inbox SELF address may be gated on keyword/live-name evidence.
- **Echo suppression runs before all identity signals** (Docusign/DocRaptor sender domains, "electronic signature request"/"archidoc proposal" markers) — an echo parks as `low` even when it names a live project.
- **Attachment dedupe**: sha256 fingerprint with a partial UNIQUE index; capture does lookup→append-source, and on insert conflict (code 23505, unwrap pg `cause`) the loser appends itself to the winner. Appending a source never changes extractionStatus (skipped stays terminal/hidden).
- **Auto-assignment fires only on a unique COMBINED candidate set** (client-contact sender ∪ subject/filename mentions, incl. distinctive ≥5-letter name tokens). Any conflict or ambiguity assigns nothing; confidence/status logic untouched.

**Why:** these were the three prod noise causes (duplicate captures, self-echoes, unassigned completed docs); loosening any guard regresses Tasks #322/#425/#503 behavior.
