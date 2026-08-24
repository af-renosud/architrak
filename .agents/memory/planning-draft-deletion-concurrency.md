---
name: Planning draft deletion concurrency
description: Locking rule for safely deleting a disposable uploaded Planning draft while imports may start concurrently.
---

Deletion of an uploaded Planning draft must take an exclusive lock on its project before checking active imports, deleting the revision, and deciding whether its object-storage key may be removed. Import-job and PDF-revision creation must take a compatible shared project lock first. Each distinct upload must also receive an immutable per-import object key; only intentional re-scrapes may share the original source key.

**Why:** Locking matching import rows does not protect an empty result under PostgreSQL Read Committed, so the shared project lock closes the race before deletion commits. That lock ends at commit, however. If separate same-SHA uploads reuse one deterministic key, a replacement can upload after commit and then be erased by already-authorized cleanup of the old draft. A per-import generation key makes stale cleanup incapable of targeting the replacement.

**How to apply:** Keep the project-lock convention on every Planning path that creates an import or PDF-backed revision. The database delete guard should acquire the same exclusive lock so direct deletion follows the application safety boundary too. Generate upload keys from both the import-job identity and SHA; never revert to a project+SHA-only key. Test both interleavings: an import entering before commit must block/refuse deletion, and a replacement upload after commit must survive old-key cleanup.