---
name: Stale query cache eats remounted-editor content
description: With staleTime Infinity, autosave paths must invalidate their query on success or remounted editors show stale data
---

The query client uses `staleTime: Infinity`, so any autosave/flush-on-unmount
widget must invalidate its query on **successful** save (not just on
error/conflict), or a remounted instance initialises from stale cache and the
saved content silently vanishes until a full reload.

**Why:** a real browser tab-switch test caught this; jsdom tests of the save
queue alone could not.

**How to apply:** when a widget doesn't re-render from props, re-syncing from
fresher server data must treat a pending debounce as an unsaved edit and adopt
the server revision as the save baseline atomically, or edits get wiped /
falsely conflict.

Same class of bug for **background workers**: when a server-side queue
(intake analysis/routing, sweepers) creates records asynchronously, no client
mutation ever fires, so cached list queries stay stale forever. Whatever UI
observes the worker's progress (polling status list) must invalidate the
affected record-list queries when it sees a promotion/completion transition —
and on its FIRST observation must compare against the cached lists (via
`queryClient.getQueryData`) rather than assuming a baseline, or promotions
that happened between visits stay invisible.
