---
name: Running Playwright e2e in this workspace
description: How to run tests/browser specs without the shell tool killing or swallowing them
---

Rules for running `npx playwright test` here:

- **Foreground with a hard timeout + file redirect.** Use
  `timeout -k 5 95 npx playwright test <spec> > /tmp/x.log 2>&1; echo exit=$?; tail /tmp/x.log`.
  Piping straight to `tail` without redirect can yield NO output when the shell tool hits its
  2-minute wall (exit -1, empty output).
- **Background/detached processes do not survive between shell calls** — `nohup`/`setsid` runs get
  killed, so a long test cannot be polled across calls. Keep the whole run inside one call.
- **Budget:** a hermetic spec that boots its own `tsx server/index.ts` instance takes ~16s to
  healthy; a full SigningPanel-style UI spec runs ~40s total, so it fits in one 120s call.
- Chromium lives in `<workspace>/.cache/ms-playwright` (matching the repo's Playwright version);
  no `playwright install` needed.
- Hermetic specs must set `ENABLE_DEV_LOGIN_FOR_E2E=true` themselves — the shared :5000 workflow
  only sets `E2E_FAKE_GMAIL`.

**Why:** first attempts at running a new spec burned ~10 minutes on killed background runs and
silent foreground timeouts before landing on the pattern above.
**How to apply:** any time you run or debug `tests/browser/*.spec.ts`.
