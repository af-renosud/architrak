---
name: Archisign /create subject & body behaviour
description: How Archisign treats the undocumented subject/body fields on envelope create, and why ArchiTrak persists the signer note locally.
---

# Archisign envelope `subject` / `body` on `/create`

ArchiTrak sends `subject` and `body` to Archisign's `POST /api/v1/envelopes/create`,
but **neither field is documented** in the inter-app contract §3.5.1 (the documented
body is `{ pdfFetchUrl, externalRef?, metadata?, signers[], fields[], webhookUrl,
expiresAt?, identityVerification }`).

Empirically (confirmed from a recovered live "Document Ready for Signing" email):
- **`subject` IS rendered** in the signer email (appears in the Subject/Reference box).
- **`body` is NOT rendered** — Archisign's email template has no slot for a custom
  message, so the architect's personalised note silently disappears on their side.

**Why this matters:** the personalised note typed in the "Envoyer à la signature"
dialog was previously *only* forwarded as `body` and kept nowhere, so it was lost
entirely (not shown to the client, not stored by us).

**How ArchiTrak handles it now:** the note is persisted locally in
`devis.archisign_signer_message`, written one-shot in the post-`/create` block
(resume branch skips `/create`, never overwrites). Making the note actually reach
the client still depends on Archisign rendering `body` in their signer-email
template — that is a change on the Archisign side, not ours.
