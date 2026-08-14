---
name: Regex boundaries with accented letters
description: JS \b silently fails around accented letters, and this project's TS target rejects the `u` regex flag (TS1501).
---
The rule: never rely on `\b` around words containing accented letters — JS classifies them as non-word chars, so the boundary silently never matches. This project's TS target also rejects the `u` regex flag, so `\p{L}` lookarounds are unavailable; build boundaries from an explicit Latin-letter character class instead.

**Why:** `\b` boundaries around French keywords match nothing, and the obvious `u`-flag fix fails the typecheck.

**How to apply:** whenever matching French/accented keywords with word boundaries.
