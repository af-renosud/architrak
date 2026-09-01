---
name: Reviewed intake identity
description: Fail-closed rules for human project-label resolution and retry-safe intake promotion.
---

Human project confirmation may resolve only a label the strict matcher cannot resolve. An exact match to another live project is never overridable. The decision must be append-only and bound to the intake row, current project, immutable source identity, content fingerprint, and authenticated actor.

**Why:** Treating every mismatch as manually overridable can route an exact label for one project into another project's accounts. A process-local routing lock also cannot prevent two application instances from promoting the same source twice.

**How to apply:** Re-check the strict resolver, project state, routing state, and current fingerprint inside the confirmation transaction. During promotion, use a database-unique source-intake key and commit the typed record plus its required database evidence row atomically; a retry may reuse only a fully committed winner.