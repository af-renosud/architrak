---
name: Integration test worker isolation
description: Avoid interference between real-database integration tests and development background synchronization.
---

Pause the development application workflow when running integration tests that create temporary ArchiDoc-linked suppliers or technical lots in the shared development database.

**Why:** A background ArchiDoc sync can mark the synthetic supplier orphaned and technical lots inactive midway through a test run. Planning tests then fail with valid domain errors even though their initial fixtures were active. The same tests passed with the workflow paused.

**How to apply:** Stop the workflow, run the affected integration tests serially, and restore the original workflow afterward. Do not weaken active-partner validation or alter test expectations to accommodate this interference.