# v1.2 Amendment Proposal — §3.5.1.1 Signer-Invitation Email Rendering Guarantee

**From:** Architrak team
**To:** Archisign team
**Date:** 2026-07-12
**Protocol:** Versioned amendment to `INTER_APP_CONTRACT` per §7 ("Subsequent
changes require a v1.1 (or later) versioned amendment proposal … no in-place
edits"). Same relay mechanism as the v1.1 §5.3.2.1 amendment: review, elect,
record your countersign in §7.2 of your contract copy, and confirm back so we
can mirror the date in ours.

---

## Why we are proposing this

Architrak sends `subject` and `body` on `POST /api/v1/envelopes/create`:

- `subject` carries the client-facing English line
  `Electronic signature request — devis {code}`. A July 2026 live inbox check
  confirmed your service renders it verbatim as the invitation-email subject
  (UTF-8 em-dash intact). **This behaviour is now load-bearing for us** — but
  it is undocumented, so you could drop or change it in a refactor without
  breaching any frozen wire shape, and nothing on either side would error.
  The email would silently fall back to your default subject.
- `body` carries the architect's optional personalised note. The same July
  2026 inbox check showed `body` is **not rendered** in the current production
  template — this contradicts the written description we received in May 2026
  ("Message from the sender:" heading), which we had transcribed into §3.5.1.
  We have now corrected §3.5.1 in our copy to record the observed behaviour
  and marked the 2026-05-30 text as superseded. (No client harm on our side:
  we persist the note locally and deliver it via our own context email.)

We want the subject rendering to be a guaranteed, versioned part of the
contract, the `body` behaviour to be explicit either way, and a machine-visible
signal so a future rendering regression is detectable — `GET /envelopes/:id`
does not echo `subject`, so today only a human inbox check can catch drift.

## What we are asking you to do

1. **Review clause §3.5.1.1** (full text in our contract copy,
   `docs/INTER_APP_CONTRACT_v1.0.md`; reproduced below).
2. **Elect a `body` behaviour** — RENDERED or NOT-RENDERED. NOT-RENDERED is
   the status quo and costs you no engineering; RENDERED is our preference
   (it lets the architect's note reach the signer through your email rather
   than only through ours).
3. **Implement clause (c)** — the additive `emailRendering` echo on the
   `/create` 201 response. This is the only engineering ask for the mandatory
   part; it is backward-compatible (we already tolerate its absence).
4. **Countersign** by recording your date (UTC, `YYYY-MM-DD`) and the `body`
   election in the §7.2 table, and confirm back through the usual channel.
   The clause enters force at 00:00:00 UTC the day after the later countersign
   date.

If any constraint below doesn't fit your implementation (length limits, error
codes, template position for RENDERED), counter-propose — the numbers are
starting points, not hills.

---

## Proposed clause text (verbatim from §3.5.1.1)

**(a) `subject` — MUST render.** When `/create` receives a `subject` that is a
non-empty string after trimming, Archisign MUST set the signer-invitation
email's RFC 5322 `Subject` header to that string verbatim — no prefixing,
suffixing, truncation, or re-casing — applying RFC 2047 encoding as required
for non-ASCII content (UTF-8 accents and em-dashes MUST survive intact). The
same subject MUST be reused on every subsequent invitation email for that
envelope (idempotent re-send per §3.5.2 and resend-on-expiry per §3.5.4).
When `subject` is absent, null, or empty/whitespace after trimming, Archisign
uses its default subject. Sender constraints: plain text, no line breaks,
≤ 256 Unicode code points. Archisign MAY reject longer values with
`400 subject_too_long`; it MUST NOT silently truncate.

**(b) `body` — Archisign MUST elect exactly one behaviour at countersign time
and record the election in §7.2:**

- **RENDERED** — `body` is rendered in the signer-invitation email under a
  "Message from the sender:" heading, between the standard intro line and the
  Subject/Reference box. Plain text only: line breaks preserved, content
  HTML-escaped by Archisign (markup will not render). Empty / whitespace-only
  / null / omitted `body` shows no message block. Sender constraints:
  ≤ 2 000 Unicode code points; `400 body_too_long` rather than silent
  truncation.
- **NOT-RENDERED** — `body` is accepted for wire compatibility but never
  rendered; this contract then records the field as accepted-but-ignored, and
  Architrak continues delivering the architect's note via its own context
  email.

**(c) Rendering echo — anti-silent-drift mechanism.** The `/create` 201
response gains one additive, backward-compatible field:

```jsonc
"emailRendering": {
  "subjectApplied": true,   // true iff clause (a) will use the sender's subject on the invitation email
  "bodyApplied": false      // true iff (b) election is RENDERED and a non-empty body was supplied
}
```

Receivers MUST tolerate the field's absence (pre-v1.2 servers) and any
additional keys inside it. Architrak's consumer behaviour: when a non-empty
`subject` was sent and `subjectApplied` comes back `false`, Architrak logs an
operator-visible warning.

**(d) Change control.** Once countersigned, any change to (a)–(c) — including
dropping the subject override, changing the `body` election, moving the
template position, or altering the length limits — requires a further
versioned amendment through the §7 protocol. Silent behavioural drift is a
contract breach even when the wire shapes are unchanged.

---

## §7.2 sign-off table (as it stands in our copy)

| App | v1.2 amendment scope reviewed | Countersigned? | `body` election | Countersigned by | Date (UTC) |
|---|---|---|---|---|---|
| Architrak | §3.5.1.1 (drafter; sender of `subject`/`body`; consumer of the `emailRendering` echo) | yes | n/a (sender) | Architrak team | 2026-07-12 |
| Archisign | §3.5.1.1 (renderer; owner of the invitation-email template and the `/create` response shape) | pending | pending | -- | -- |

Archidoc is out of scope (it does not send these fields today; the clause
applies to it identically as a sender if it ever does — no separate
countersign needed).

## What Architrak has already done on its side

- Corrected §3.5.1's descriptive paragraph to the observed behaviour
  (subject rendered / body not rendered, July 2026 live check) and marked the
  2026-05-30 body-rendering text as superseded.
- Added §3.5.1.1 (PROPOSED) + §7.2 to our contract copy with our countersign
  recorded.
- Wired the clause-(c) consumer: our `/create` client already tolerates and
  reads an optional `emailRendering` object and logs an operator-visible
  warning when `subjectApplied === false` for a non-empty sent subject. This
  is inert until you ship the echo.
