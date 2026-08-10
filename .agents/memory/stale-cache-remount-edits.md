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
