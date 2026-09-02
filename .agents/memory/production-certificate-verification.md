---
name: Production certificate verification
description: Constraints for confirming certificate previews against live production data without issuing certificates
---

Production certificate verification requires an authenticated operator session; the agent's browser may not have one, so the operator must open the live preview and confirm the displayed totals.

**Why:** The production API is session-protected, and bypassing authentication or using development-login flags would not validate the real operator path.

**How to apply:** Confirm the published build and matching production records first, then use the operator's read-only preview flow. Never click certificate creation unless the operator explicitly requests it.