---
name: SMOKE_BOOT safe mode
description: How to boot the production bundle locally with zero side effects
---

The server supports `SMOKE_BOOT=true` (env flag): boot skips ALL background workers — schedulers, sweepers, boot-time ArchiDoc reconciliation and benchmark seeding — while still serving routes (`/healthz` works). Used by `npm run prepublish-check` to smoke-boot `dist/index.cjs`.

**Why:** production-mode boots forbid `E2E_FAKE_GMAIL`, and the payment scheduler's first email-capable tick fires 30s after boot — a timing-based kill window was rejected in code review as unsafe. Side-effect safety must be application-level, not timing-based.

**How to apply:** any local/CI boot of the production bundle must set `SMOKE_BOOT=true` + `RUN_MIGRATIONS_ON_START=false`, use a random preflighted port, wrap the child in GNU `timeout` (survives parent death), and check DATABASE_URL vs PROD_DATABASE_URL by host+dbname (fail closed). Never set SMOKE_BOOT in a real deployment — the app would silently do no background work.
