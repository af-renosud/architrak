---
name: Merge-corrupted source files
description: Task merges can commit syntactically broken files with interleaved handler fragments; how to detect and repair.
---

A task merge can land a file where fragments of different functions/handlers are spliced into each other (duplicated imports, orphan code after `export default`, `catch` without `try`). The corruption is IN the merged commit — history offers no clean version to restore.

**Why:** such a file breaks both the dev server and the deployment build with an esbuild/TS parse error, while `git status` looks clean.

**How to apply:** if a workflow or publish build fails with a parse error right after a merge, suspect merge corruption before debugging logic. Repair by reconstructing the file from its intact collaborators — the service layer it imports, client callers (exact API paths/methods), and the storage interface — not from git history. Also: a post-merge health-check failure may just be the stale pre-merge server process; restart the workflow before concluding schema/code drift.
