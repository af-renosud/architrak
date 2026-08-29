---
name: Trigger redefinition inheritance
description: Prevents later migrations from silently dropping protections added by intermediate trigger-function versions.
---

When a migration uses `CREATE OR REPLACE FUNCTION` for a shared database trigger, base the new body on the latest preceding definition and preserve every existing branch before adding the narrow exception or field.

**Why:** Replacing a mature trigger from an older migration can make the new feature work while silently removing newer audit, provenance, or transition guards. Clean replay may still succeed because the SQL is valid; behavioral integration tests are what expose the loss.

**How to apply:** Search migration history for every definition of the function, diff the latest one against the proposed replacement, and run behavioral tests for both the new exception and all protected transitions.