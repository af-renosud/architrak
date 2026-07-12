---
name: Archisign /create subject & body behaviour
description: The in-force v1.2 §3.5.1.1 rendering guarantee for subject/body on envelope create, the negotiation history, and why ArchiTrak still persists the signer note locally.
---

# Archisign envelope `subject` / `body` on `/create`

ArchiTrak sends `subject` and `body` to Archisign's `POST /api/v1/envelopes/create`.

## Contract state: v1.2 §3.5.1.1 IN FORCE since 2026-07-13 (countersigned 2026-07-12)

- **`subject` — guaranteed rendered** verbatim as a **contiguous substring** of
  the invitation email's RFC 5322 Subject header. Archisign frames the header
  `[<firm name>] <configurable prefix> <our subject>` (default prefix
  "Signature Required:") — the framing is permitted; altering/splitting/dropping
  our string is a breach. Same framed construction on every re-send. ≤ 256 code
  points, `400 subject_too_long`, no silent truncation.
- **`body` — Archisign elected RENDERED** (countersign 2026-07-12): rendered
  under a "Message from the sender:" heading, plain text, HTML-escaped,
  ≤ 2 000 code points, `400 body_too_long`.
- **`emailRendering` echo shipped** on the `/create` 201:
  `{ subjectApplied, bodyApplied }`, absence-tolerant. ArchiTrak's client
  consumes BOTH halves as the drift detector: `subjectApplied=false` for a
  sent subject and `bodyApplied=false` for a non-empty sent body each warn,
  persist a per-devis drift timestamp, and surface in the ops UI. A false
  `bodyApplied` with NO body sent is clause-correct (no message block) and
  must never be treated as drift.
- Change control: any change to the above (incl. framing shape, election,
  limits) requires a further versioned amendment; silent drift is a breach.
- Lineage quirk: Archisign records this amendment as **v1.4 in its own copy**
  (it holds v1.0 + bilateral v1.3/v1.3.1, no v1.1 — v1.1 was
  Architrak↔Archidoc-only). Cross-copy identifiers are the clause anchor
  §3.5.1.1 + proposal date 2026-07-12. Version tags are per-copy — expect
  numbering mismatches with counterparties and reconcile by anchor + date.

## Unresolved factual dispute (verification item, not a contract gap)

Our July 2026 human inbox check saw NO rendered `body` block; Archisign's
2026-07-12 reply asserts the "Message from the sender:" rendering was live all
along. One observation is wrong or the template changed. Recorded as a dispute
note at contract §3.5.1. Since RENDERED is now a MUST, verify on the next real
envelope: check `bodyApplied: true` on the 201 AND that the message block
appears in the signer email. `bodyApplied: false` on a non-empty body = breach.

**Trust caution (still valid):** Archisign written descriptions have been
contradicted by live inbox checks before — for signer-email behaviour, a human
inbox check is the only definitive evidence. The echo now gives a machine
signal, but the email itself is the ground truth.

## How ArchiTrak handles the architect's note

Persisted locally in `devis.archisign_signer_message`, written one-shot in the
post-`/create` block (resume branch skips `/create`, never overwrites), and
ALSO delivered via ArchiTrak's own context email from the architect's Gmail.
Local persistence + context email stay REQUIRED under the RENDERED guarantee
(audit copy + delivery redundancy).

## Live verification recipe

- `/create` alone leaves the envelope in `draft` and sends NO email — safe probe.
  `/send` triggers the invitation email. Short `expiresAt` (15 min) self-cleans.
- `GET /api/v1/envelopes/:id` on the live Archisign returns SPA HTML, not JSON —
  no API echo of `subject` besides the create-time `emailRendering` object.
- The workspace Gmail connector token carries only `gmail.send` + labels scopes —
  it CANNOT read any inbox (`messages.list`/`getProfile` → 403), so end-to-end
  email inspection must go through the user. Also, the connector API's
  `connector_names=google-mail` filter returns 0 items — query unfiltered.
