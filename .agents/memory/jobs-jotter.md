---
name: Jobs jotter persistence
description: User requirement for the floating Jobs pad and its retention boundary.
---

Jobs is a persistent floating jotter for notes taken while processing quotations. Notes must be stored in the database, not browser storage, and closing the pad must never delete them.

**Why:** The user wants to stop keeping working notes outside the app and explicitly asked for database persistence through accidental closure.

**How to apply:** Preserve notes across project navigation and reopening; require explicit deletion. Treat it as a personal cross-project pad scoped to the signed-in account. Keep save status honest and retain drafts on errors or concurrent edits rather than silently overwriting either version.
