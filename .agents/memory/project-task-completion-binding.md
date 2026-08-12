---
name: Project-task completion binding
description: When markTaskComplete works and when it returns "No active task to mark complete"
---

`markTaskComplete` only succeeds for a task the platform formally dispatched to the current session (user accepted the proposal and delegated it at turn start). If the user asks mid-conversation to "just run" a PENDING task and you implement it directly, `markTaskInProgress` will flip it to MAIN_IN_PROGRESS but `markTaskComplete` keeps returning `no_active_task` — there is no callback to force-complete it.

**Why:** the "active task" binding is set by the platform dispatch, not by markTaskInProgress; retrying across turns/modes does not help.

**How to apply:** if asked to run a queued task directly, do the work, then tell the user up front the tracker entry must be closed from their task panel (or by delegating the task normally next time). Don't burn turns retrying markTaskComplete.
