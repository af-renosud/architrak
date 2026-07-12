---
name: Archisign /create subject & body behaviour
description: How Archisign treats the undocumented subject/body fields on envelope create, and why ArchiTrak persists the signer note locally.
---

# Archisign envelope `subject` / `body` on `/create`

ArchiTrak sends `subject` and `body` to Archisign's `POST /api/v1/envelopes/create`.
As of 2026-07-12 the contract §3.5.1 accurately documents the *observed* behaviour
(subject rendered / body NOT rendered), and a **v1.2 amendment (§3.5.1.1) is
PROPOSED but not countersigned** — it would make subject rendering a versioned
MUST, force Archisign to elect RENDERED/NOT-RENDERED for `body`, and add an
additive `emailRendering` echo to the `/create` 201 so drift is detectable
(ArchiTrak's client already consumes the echo tolerantly and warns on
`subjectApplied=false`). Until Archisign records its countersign + body election
in contract §7.2 (relay package: `docs/AMENDMENT_PROPOSAL_v1.2_signer_email_fields.md`),
there is still NO guarantee — Archisign can change rendering without breach.

**Trust caution:** the 2026-05-30 contract text claiming body was rendered came
from an Archisign-side *written description* and was disproved by a live inbox
check — for signer-email behaviour, only a human inbox check is evidence.

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

## Live verification recipe (July 2026 — English subject confirmed)

The English subject ("Electronic signature request — devis …", UTF-8 em-dash)
was confirmed rendering correctly in a real signer email by a human inspecting
the inbox. Useful facts for re-verifying:
- `/create` alone leaves the envelope in `draft` and sends NO email — safe probe.
  `/send` triggers the invitation email. Short `expiresAt` (15 min) self-cleans.
- There is no API echo of `subject`: `GET /api/v1/envelopes/:id` on the live
  Archisign returns the SPA HTML, not JSON. Only a human inbox check works.
- The workspace Gmail connector token carries only `gmail.send` + labels scopes —
  it CANNOT read any inbox (`messages.list`/`getProfile` → 403), so end-to-end
  email inspection must go through the user. Also, the connector API's
  `connector_names=google-mail` filter returns 0 items — query unfiltered.
