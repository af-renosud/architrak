---
name: Client sees sealed releases, never live content
description: Every client-facing quotation surface serves an immutable sealed release; edits reach the client only via an explicit update.
---
Rule: client surfaces (project share link and per-quotation link) serve ONLY the latest sealed client release — frozen page payload, copied context images, copied original PDF and the EN+FR package, each with SHA-256. Questions/replies stay live. Architect previews stay live. A release is prepared outside locks and committed only if the content version is unchanged; release rows are trigger-protected against UPDATE/DELETE and have no FKs so they outlive deletions.

**Why:** On 2026-11-25 the user needed the exact copy of a replaced quotation "as shared with the client" and none existed (contexts edited after sharing). They said a sealed copy of exactly what the client sees — translations, context images, everything in the combined PDF — is "absolutely imperative". Sealing only at publish would not match a live-rendered portal, so the portal itself was switched to serve sealed copies.

**How to apply:** Any new client-visible field must be part of the sealed payload or the package, never read live in a public route. Anything shared before releases existed was only backfill-sealed at its then-current content; earlier views are unrecoverable. E-signature envelopes pin their own PDF separately.
