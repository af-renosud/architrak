# DEVIS SIGN-OFF WORKFLOW — STEP 4 IMPLEMENTATION BREAKDOWN

**Status:** **Locked 2026-04-25.** All three open items closed:

- (a) **Archidoc disposed G11** (`intendedWorkLot` lot-scoped when provided, project-scoped fallback when absent) and applied a 3-task adjustments delta on #331 / #332 / #333; #329 + #330 untouched.
- (b) **Architrak confirmed case-insensitive label-match** for the lot-taxonomy lookup-algorithm sub-question (code-match deferred to v1.1 alongside a formal taxonomy-alignment ceremony if interop volume grows).
- (c) **Archisign confirmed AT1–AT5** and provided tightened reverse-dep annotations on AS3 / AS4 / AS5 (replaces their §C of 2026-04-25; now reflected in §1.3 below).

Subsequent changes follow the standard v1.1 amendment cycle against `docs/INTER_APP_CONTRACT_v1.0.md`.

**Scope:** Operational counterpart to `docs/INTER_APP_CONTRACT_v1.0.md` (frozen 2026-04-25). Consolidates the three apps' implementation task breakdowns, cross-app sequencing, and gap synthesis. All wire shapes and contract semantics are sourced from v1.0; this document does not redefine or amend them — anything contract-level lives in v1.0 and changes there require a v1.1 amendment cycle.

**Drafted by:** Architrak (consolidator), incorporating Archidoc's #329–#333 + 7 gaps and Archisign's AS1–AS5 + 10 gaps + cross-app sequencing graph from their Step 4 replies of 2026-04-25, plus Archidoc's G11 disposition + adjustments delta and Archisign's tightened reverse-dep table from their Stage-2 replies of 2026-04-25.

**Contract reference:** All `§N.M` references resolve against `docs/INTER_APP_CONTRACT_v1.0.md`.

---

## §1 Per-app task breakdowns

### §1.1 Architrak — AT1 through AT5

| Task | Title | Cross-app deps | Cross-app dependents |
|---|---|---|---|
| **AT1** | Schema migration: `signOffStage` enum extension; new tables `client_checks` family (parallel to existing `devis_checks`), `insurance_overrides`, `signed_pdf_retention_breaches` (parallel to Archidoc's per §2 footnote — disjoint envelope sets, no shared rows), `webhook_deliveries_out`, `webhook_events_in`; new columns on `devis`/`projects`. Stubs `docs/wire-fixtures/` directory + README per G1 | None | None — internal; unblocks AT2–AT5 |
| **AT2** | Client review portal: token-auth landing page (parallel to existing contractor `devis_checks` portal), query thread UI integrating with `envelope.queried` / `envelope.query_resolved`, "agree" / "reject" actions writing `client_checks` rows | None at code-landing; query-thread wire E2E needs AS3 (§2.1 below) | None |
| **AT3** | Insurance gate orchestration: live-verdict client into AD2, mirror+live+override+audit decision tree per §1.3, override modal, 7-field `insuranceOverride` block written to `insurance_audit_log.metadata`, gate enforcement at `approved_for_signing → sent_to_client` transition. **Passes `intendedWorkLot` as case-insensitive lot label per G11 closure**; mirror-only dev fallback exercises full decision tree minus the live-verdict happy path (Archisign §A micro-observation 2026-04-25) | AD2 (#331) deployed in target env for live-verdict E2E (can ship to dev with mirror-only fallback) | AD3 (#332) — `insuranceOverride` block flows to work-auth endpoint when present (mutual with AT4) |
| **AT4** | Archisign two-step orchestration + inbound webhook receiver: client for AS4 endpoints (`/create`, idempotent `/send`, resend-on-expiry), "Send to client" button wiring, **HMAC v2 verifier born v2** (no migration — channel is new), 7-event receiver with dedup against `webhook_events_in`, lifecycle transitions per §1.2, `accessToken` refresh-on-resend handling | AS3 (event emissions for byte-faithful interop), AS4 (endpoints) | AD3 (#332) — work-auth endpoint signs with `ARCHITRAK_WEBHOOK_SECRET` v2 against AT4 emissions (mutual with AT3) |
| **AT5** | Outbound work-authorisation webhook to Archidoc + retention-breach handling: both `eventType` variants per §5.3.1 / §5.3.2 (always emits explicit `eventType` — never relies on Archidoc default), retry policy + dead-letter queue + admin retry UI per §1.4, `envelope.retention_breach` reception → re-notify Archidoc with `signed_pdf_retention_breach` payload pinned against §5.3.2 fixture (NOT the §3.8 410 body shape) | AS4 (`/signed-pdf-url` for re-mint), AS5 (realistic E2E source for `envelope.retention_breach`), AD3 (#332) deployed in target env to fire against | None — terminal |

**HMAC v2 asymmetry:** Architrak's task list is one item lighter than Archidoc's because Architrak ships v2-only on the new `/api/webhooks/archisign` channel. There is no Architrak parallel to Archidoc's AD4 dual-verify migration — Architrak has no pre-existing legacy channel to migrate gently. (Confirmed by Archisign 2026-04-25.)

### §1.2 Archidoc — AD1 through AD5 (= #329 through #333)

(Source: Archidoc Step 4 reply, 2026-04-25, plus Stage-2 adjustments delta of 2026-04-25. AD1–AD5 abbreviations from Archisign's cross-app graph; #329–#333 are Archidoc's internal project task IDs. Mapping: AD1=#329 schema, AD2=#331 insurance-verdict, AD3=#332 work-auth, AD4=#330 HMAC v2 verifier, AD5=#333 Gmail header + re-mint.)

| Task | Title | Cross-app deps | Notes |
|---|---|---|---|
| **AD1 (#329)** | Schema migration | None | Wire shapes in §2.2 + §5.3 are frozen; no live coordination needed to apply |
| **AD4 (#330) — code landing (P0/P1)** | HMAC v2 verifier module + ignore-unknown-headers behaviour | None | Self-contained per §2.4 P1 row |
| **AD4 (#330) — P2 (prefer-v2 activation)** | Dual-verify; metric `archisign_webhook_verify_path{version}`; require ≥1 week of `v1=0` count before P3 | Archisign v2 dual-emit deployed in test env | Per §2.4 P1 → P2 sequencing |
| **AD4 (#330) — P3 (cutover)** | Hard-require v2; drop v1 fallback; legacy code path deleted; status code aligned to 401 | Archisign P3 cutover | Per §2.4 P3 row |
| **AD2 (#331)** | Insurance-verdict endpoint | None for landing; reverse-dep: AT3 E2E | Architrak's gate tests can run end-to-end only once this is deployed in their test env; AT3 dev runs against mirror-only |
| **AD3 (#332) — `work_authorised` variant** | Work-authorisations endpoint accepting AT5 outbound webhook | `ARCHITRAK_WEBHOOK_SECRET` provisioned in Archidoc's secret store before any smoke test | Reverse-dep: AT5 needs AD3 live to fire against |
| **AD3 (#332) — `signed_pdf_retention_breach` variant E2E** | Same endpoint, polymorphic-on-`eventType` routing into `signed_pdf_retention_breaches` table | Archisign `envelope.retention_breach` emission task + Architrak downstream re-notification (AT5) | Code can land against fixture; full E2E requires upstream chain. Per §0.3 + §3.7 cross-path dedup |
| **AD5 (#333) — Gmail header (`X-Archidoc-Dqe-Export-Id`)** | Outbound header on devis-PDF emails | None | Architrak reads case-insensitively; no coordination needed |
| **AD5 (#333) — re-mint client code landing** | Calls `/signed-pdf-url`; tests against fixture responses for 200/410/429/503 | None | Self-contained |
| **AD5 (#333) — re-mint client E2E** | Live exercise against Archisign endpoint | Archisign `/signed-pdf-url` live | Per §3.5.3 |
| **AD5 (#333) — re-mint client 410 retention_breach branch E2E** | Live exercise of breach surfacing | Archisign retention_breach surfacing on the signed-pdf-url endpoint | Per §3.8 |

Internal Archidoc dep graph: #332 → #329 + #330; #333 → #329.

#### §1.2.1 Adjustments delta applied 2026-04-25 (per Archidoc Stage-2 reply)

Three of five tasks touched; #329 + #330 untouched (no gap disposition affects them).

- **#331 (AD2):** (a) Encodes G11 lot-scoped semantics — `coverage_scope` matching, mismatch → `200 { canProceed: false, reason: "Contractor's insurance does not cover lot \"<intendedWorkLot>\"" }` overridable per §1.3; absent → project-scoped fallback. (b) G7 — Archidoc emits **literal 503** on transient errors; AT3's "treat all 5xx uniformly as overridable" is the receiver-side robustness pair. The 503-emit + any-5xx-tolerate pairing is now complete on both sides.
- **#332 (AD3):** (a) §2.2 timing annotation: code lands Week 3, AD3↔AT4 live-integration test fires end-of-Week-3 happy-path window. (b) G1 — tests load fixtures from Architrak's `docs/wire-fixtures/`. (c) G8 — `eventType`-absent default in AD3 is **defensive code only**; AT5 always emits the explicit field per Architrak commitment.
- **#333 (AD5):** (a) G10 — assert Gmail `X-Archidoc-Dqe-Export-Id` header presence and lower-case form in tests. (b) G1 — re-mint client tests load Archisign-side fixtures from the same `docs/wire-fixtures/` location. (c) G6 acknowledgement — Archisign-direct breach path uses **deterministic synthesis** (idempotent on re-mint retries), distinct from AT5's UUIDv7 outbound generation; no algorithm change but the asymmetry is documented in §3.1 G6.

**Net Archidoc pattern (post-adjustments):** Code-landing critical path remains self-contained — all five tasks ship in any order subject to within-Archidoc deps. Cross-app coordination kicks in at integration-test and rollout phases, where Archisign is upstream of both Archidoc and Architrak for the v2 HMAC + signed-PDF chains.

### §1.3 Archisign — AS1 through AS5

(Source: Archisign Step 4 reply, 2026-04-25, **superseded** by tightened §C of Stage-2 reply 2026-04-25. Each entry names the specific AT/AD task and variant that consumes the surface, not just the app.)

| Task | Title | Cross-app deps | Cross-app dependents |
|---|---|---|---|
| **AS1** | Schema foundation for v1.0 wire contract | None | None — purely internal |
| **AS2** | API key, rate-limit, and v2 HMAC middleware | None | AD4 P1 (verifier needs the v2 emission to baseline against — AS2 ships the `WebhookSignature` module; AS3 turns dual-emit on) |
| **AS3** | Wire events, payloads, and idempotent dispatch | None | AT4 (full — inbound 7-event verifier + handlers + dedup against `webhook_events_in` + lifecycle transitions per §1.2); AT2 (E2E only — query-thread integration via `envelope.queried` / `envelope.query_resolved` per §2.1; AT2 code lands Week 1 with stub, wire E2E moves to Week 3); AD4 P1 (dual-emit traffic for Archidoc to baseline against per §2.4 P1 row) |
| **AS4** | Endpoints: `pdfFetchUrl`, `/send` idempotency, `/signed-pdf-url` re-mint | None | AT4 (envelope two-step orchestration: client for `/create`, idempotent `/send`, resend-on-expiry with `accessToken` refresh per G3); AT5 (`/signed-pdf-url` consumed by re-mint client + 410 retention_breach body parsing pinned against §3.8 fixture); AD5 (#333) re-mint client E2E (live exercise per §3.5.3); AD5 (#333) re-mint client 410 retention_breach branch E2E (live exercise per §3.8) |
| **AS5** | Background jobs: `expiresAt` sweeper + annual integrity check | None | AT4 (`envelope.expired` reception → §1.2 transition `sent_to_client → approved_for_signing`); AT5 (`envelope.retention_breach` reception → downstream re-notify to Archidoc with §5.3.2 payload); AD3 (#332) `signed_pdf_retention_breach` variant E2E (full upstream chain: AS5 emits → AT5 forwards → AD3 receives) |

**Net additions vs Archisign's prior §C:** AS3 gained AT2 (E2E only) per §2.1; AS4 dropped AT3 (was a conflation — AT3 deps on AD2 not AS4, since AT3 is insurance-gate orchestration not envelope orchestration); rows now name specific task IDs and variants (e.g. AD3 polymorphic-on-`eventType` `signed_pdf_retention_breach` variant) rather than just app names.

**Net Archisign pattern:** All five tasks are cross-app-zero-dep at code-write time — no Archisign code waits on the other two apps. Coordination is at integration-test and deployment-cutover time only. This is the property that lets §2's parallel execution work.

---

## §2 Cross-app sequencing — critical-path execution order

Adapted from Archisign §A.4 with two Architrak refinements (§2.1 + §2.2 below). Goal: shortest time-to-end-to-end-integration-test.

| Time | Parallel-safe tasks | Notes |
|---|---|---|
| Day 0 | AS1, AD1 (#329), AT1 | Three schema migrations independent — ship same day in any order |
| Week 1 | AS2, AD2 (#331), AT2 | AT2 lands code with query-thread integration as a stub (§2.1) |
| Week 2 | AS3, AS4 | AS3 begins P1 dual-emit to Archidoc test tenant once landed |
| Week 3 | AT3, AT4, AD3 (#332) | AD3 *code* lands Week 3; AD3↔AT4 *integration* test fires end-of-Week-3 (§2.2) |
| Weeks 3–4 | AD4 P2 (#330) | Per §2.4 P2 |
| Week 4 | AS5, AT5, AD5 (#333) | |
| Week 5 | P3 cutover | Archisign drops legacy emission; AD4 hard-requires v2 |

### §2.1 AT2 hidden dep on AS3
AT2's core flow (token-auth, browse devis, agree/reject) is fully independent. The query-thread feature integrates with `envelope.queried` / `envelope.query_resolved` events, which means it has a hidden dep on AS3 (Week 2). AT2 ships in Week 1 with the query-thread integration as a stub; full wire E2E moves to Week 3. Doesn't change the critical path.

### §2.2 AD3 code-landing vs integration
AD3 (#332) code lands in Week 3, but AD3↔AT4 integration testing requires AT4 to be emitting work-auth webhooks v2-signed with `ARCHITRAK_WEBHOOK_SECRET`. That fires at the end of Week 3 in the happy-path E2E window. **Archidoc has annotated this on #332 per their Stage-2 reply 2026-04-25.**

### §2.3 Two natural E2E windows fall out of this sequence

- **End of Week 3 — happy path:** devis → AT3↔AD2 (insurance gate) → AT4↔AS4 (envelope create+send) → signer signs → AS3→AT4 (`envelope.signed`) → AT4→AD3 (`work_authorised`)
- **End of Week 4 — sad paths:** declined / expired-then-resend (AS5↔AT4↔AS4) / `retention_breach` (AS5→AT4→AD3 via §5.3.2)

---

## §3 Gap synthesis — 16 unique items dispositioned (all closed)

Combines Archidoc's 7 gaps + Archisign's 10 gaps; G1 absorbs both apps' shared-fixture concern (AD-B1 + AS-B1). All items closed as of 2026-04-25 lock.

### §3.1 Handled by explicit Architrak commitment in AT-tasks (8 items)

| # | Source | Item | Architrak commitment |
|---|---|---|---|
| **G1** | AS-B1 + AD-B1 | Shared test fixtures (esp. `identityVerification` 8-field block) | Architrak hosts canonical fixtures at `docs/wire-fixtures/` in the Architrak repo; AT4 + AT5 tests load from there; both sister apps reference by relative path. Created during AT1 with stub fixtures + README; populated through AT2–AT5. **Confirmed by both sister apps in Stage-2 replies 2026-04-25.** |
| **G2** | AS-B3 | `pdfFetchUrl` minimum TTL invariant | AT4's URL-minting helper enforces 5-minute floor as a code invariant (not just convention); Architrak's 15-min default stays |
| **G3** | AS-B5 | `/send` resend rotates `accessToken` | AT4 refreshes stored `accessToken` / `accessUrl` from `/send` response; never re-displays the create-time `accessUrl` post-resend. (Archisign confirms AS4 returns rotated signers in `/send` 200 body explicitly.) |
| **G4** | AS-B6 | §5.3.2 downstream payload ≠ §3.8 410 body | AT5 explicitly distinguishes "what Archisign returned us" from "what we tell Archidoc"; downstream payload pinned against §5.3.2 fixture. (Archisign confirms AS4 §3.8 emission shape matches.) |
| **G5** | AS-B8 | `expiresAt` floor (≥ now()+1min per AS4) | AT4 default = 30 days; create-envelope helper validates ≥ now()+1min before call |
| **G6** | AS-B10 | `eventId` UUIDv7-with-timestamp-prefix in shared test envs | AT4 dedup table + AT5 outbound generation use UUIDv7; documented in `docs/wire-fixtures/README.md`. **Cross-app generation-algorithm asymmetry recorded 2026-04-25:** Archidoc's Archisign-direct breach path (#333 re-mint) uses **deterministic synthesis from `${incidentRef}:${envelopeId}`** because re-mint retries must collapse to the same DB row (distinguished by an `event_source` column on Archidoc's side); AS3 outbound and AT5 outbound both use UUIDv7. No interop impact — generation sources never cross at the same dedup key. |
| **G7** | AD-#4 | 5xx discipline at insurance-verdict endpoint | AT3 treats all 5xx (502/503/504) plus network timeouts uniformly as overridable-with-warning per §1.3 — not just literal 503. **Pair complete 2026-04-25:** Archidoc emits literal 503 on transient errors per #331 adjustments delta; AT3 receiver-side any-5xx tolerance handles intervening proxy/LB cases. |
| **G8** | AD-#6 | `eventType` always-emit | AT5 always emits explicit `eventType`; never relies on Archidoc's "absent → `work_authorised`" backward-compat default. (Archidoc notes the default is defensive code only per #332 adjustments delta.) |

### §3.2 Handled inside other apps' tasks (3 items)

| # | Source | Item | Disposition |
|---|---|---|---|
| **G9** | AS-B2 | `webhookUrl` immutability per envelope | Operational acknowledgement only — Architrak deployment runbook treats envelope-level `webhookUrl` as immutable for the envelope's lifetime. AT4 create-envelope payload uses canonical prod `webhookUrl`. No code change. (Archisign confirms AS3 emission code reads `envelopes.webhookUrl` recorded at create time and never re-reads from any registry.) |
| **G10** | AS-B7 | Gmail `X-Archidoc-Dqe-Export-Id` case-insensitivity | Existing Architrak Gmail watcher reads case-insensitively per §0.2 / §5.5; AT5 test pins the assertion. **Archidoc has pinned the lower-case-form assertion in AD5 tests per #333 adjustments delta 2026-04-25.** |
| **G11** | AS-B9 | `intendedWorkLot` semantics (lot-scoped vs advisory) | **CLOSED 2026-04-25.** Archidoc disposition: **lot-scoped when provided** (AND of contractor-assigned + all required policies active at `now()` + at least one policy's `coverage_scope` matches `intendedWorkLot`); project-scoped fallback when absent. Mismatch returns `200 { canProceed: false, reason: "Contractor's insurance does not cover lot \"<intendedWorkLot>\"" }`, overridable per §1.3. AT3 always passes the lot when identifiable from the devis-by-lot model. **Sub-question on lookup algorithm:** Architrak picks **case-insensitive label-match** for v1.0 (Archidoc's default — no shared taxonomy ceremony required; acceptable for the lot-name set in use today). Code-match deferred to v1.1 alongside a formal lot-taxonomy alignment ceremony if interop volume grows. |

### §3.3 v1.1 amendment candidates — none block v1.0 (4 items)

| # | Source | Item | Why deferred |
|---|---|---|---|
| **G12** | AD-#2 | `ARCHITRAK_WEBHOOK_SECRET` initial provisioning ceremony | §4 documents holder + rotation + dual-secret window but not first-time generation/exchange channel. Operational addition; no wire change. Track for v1.1. |
| **G13** | AD-#3 | `ARCHITRAK_API_KEY` analogue if Architrak adds an Archidoc-callable endpoint | **N/A for v1.0 — hard commitment recorded:** Architrak adds no Archidoc-callable endpoints in the v1.0 implementation; the work-auth flow is one-way (Architrak → Archidoc via webhook). Any future Architrak endpoint that Archidoc would call requires a new `ARCHITRAK_API_KEY` row in §4, which by definition triggers a v1.1 amendment cycle through the standard R1→R2→R3→Step-3 protocol. **Acknowledged by Archidoc in Stage-2 reply 2026-04-25 — closed cleanly on a category that could otherwise expand silently.** |
| **G14** | AD-#7 | `webhook_events_in` retention/cleanup SLA | Long-term operational concern; no immediate impact. |
| **G15** | AD-#8 | "Architect-of-record" notification on breach (Archidoc multi-owner model) | Architrak's project model is single-owner so the gap is asymmetric; banner-only is the v1.0 default per Archidoc's stance. Per-tenant setting tracked for v1.1. |

### §3.4 Architrak-side coordination decisions resolved (1 item)

| # | Source | Item | Architrak decision |
|---|---|---|---|
| **G16** | AS-B4 | `ARCHITRAK_API_KEY` per-env vs per-tenant scoping | **Single key per environment.** Within §1.6 25-envelope-burst-in-5-min budget. Revisit at §4 v1.1 if Architrak grows past 5 active tenants under one key. |

---

## §4 Open items — all closed 2026-04-25

1. ✅ **G11 — `intendedWorkLot` semantics:** Archidoc resolved as lot-scoped when provided, project-scoped fallback when absent. Architrak confirmed case-insensitive label-match for v1.0 lookup algorithm. See §3.2 G11.
2. ✅ **Adjustment-notes window for Archidoc:** Delta applied to #331 / #332 / #333; #329 + #330 untouched. See §1.2.1.
3. ✅ **Archisign confirmation of Architrak's AT-task list + reverse-dep annotations:** Confirmed; tightened §C reverse-deps reflected in §1.3.

This document is now **Locked**. Implementation-phase scoping (project-task creation per AT1–AT5, AD1–AD5, AS1–AS5) proceeds against this Locked baseline.

---

## §5 Implementation-phase handoff notes

Operational guidance from Archisign (Stage-2 reply §D, 2026-04-25) on isolated-parallel-agent execution:

> AS3 + AS4 both touch `routes.ts` and `NotificationService.ts` in Archisign's codebase, so true parallel execution by isolated task agents would generate merge conflicts. The cleanest fan-out is `AS1 → AS2 → {AS3, AS4} → AS5`, with AS3 + AS4 either sequential or two consecutive isolated agents (not concurrent).

This same property likely applies to **Architrak's AT-tasks** (AT3 + AT4 may both touch route handlers and shared service modules; AT4 + AT5 both touch the webhook delivery surface) and to **Archidoc's #331 + #332** (both extend the contractor-validation handler family). When each app moves to project-task creation under their respective workflows, prefer dependency-chained sequencing for tasks that share files; isolated parallel agents only for truly disjoint file sets (e.g. schema migrations, which all three apps can run truly in parallel on Day 0).

This is operational guidance per app, not a contract concern — file-conflict avoidance is each app's internal scoping decision and does not affect the cross-app sequencing in §2.

---

## End of Step 4 implementation breakdown
