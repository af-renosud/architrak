# DEVIS SIGN-OFF WORKFLOW — INTER-APP CONTRACT v1.0

**Status:** **FROZEN at v1.0 as of 2026-04-25.** All three apps have confirmed (Architrak self-attested as drafter; Archisign `confirmed v1.0-rc2` with explicit pre-commitment to higher rc tags; Archidoc `confirmed v1.0-rc3`). v1.0 is byte-identical to v1.0-rc3 except for this status block, the §7 sign-off table, and the file header/footer rc-tag cleanup. See §7 sign-off block for full confirmation record.
**Drafted by:** Architrak, transcribing from the three Round-3 §7 contributions.
**Source rounds:** R1 (initial proposals), R2 (negotiation + revisions), R3 (final positions + ownership-split contributions).
**Authoritative scope:** This document is the integration boundary. App-internal implementation choices (variable names, file organisation, helper extraction) are out of scope unless they affect the wire contract.

**Changes from rc1:** 15 transcription corrections applied across §1, §2, §3, §5 — all are wire-spec faithfulness fixes against the R3 source materials, no design changes.

**Changes from rc2:** One substantive faithfulness fix at §2.2.1 (clarifying that `work_authorisations` and `signed_pdf_retention_breaches` are separate tables — the `eventType` discriminator drives routing at the handler, per Archidoc Step 3 §A.1) plus two cosmetic fixes (§2.2.1 NOTE citation widened to "R3 §6 / §7.1" per §D.2; §4 secrets matrix labels relabelled `receivers/verifiers` vs `signers/receivers` for the two HMAC-emitted-secret rows per §D.1). All applied per Archidoc Step 3 review. No design changes.

---

## §0 Preamble and delta log

### §0.1 The three apps and their workflow position

| App | Role | Owns |
|---|---|---|
| **Architrak** | Financial workflow + signing orchestrator | Devis lifecycle (`signOffStage`), client review portal, insurance gate enforcement, Archisign envelope lifecycle on behalf of devis |
| **Archidoc** | Project + document management | Source of truth for projects, contractors, contractor insurance, client contacts, DQE library; recipient of work-authorisation notifications |
| **Archisign** | E-signature platform | Source of truth for signing envelopes, signer identity trail, signed-PDF vault, retention SLA |

### §0.2 The five workflow stages (canonical)

1. **Quotation generation** — Archidoc emits DQE PDF via Gmail with `X-Archidoc-Dqe-Export-Id` header (lower-case form per RFC 7230 §3.2). Architrak ingests via Gmail watcher and AI-extracts.
2. **Client review/dialogue** — Optional. Architrak runs a token-auth client portal (`client_checks` table, parallel to existing contractor `devis_checks`).
3. **Insurance verification gate** — At `approved_for_signing → sent_to_client`. Mirror + live verdict + override + audit (decision locked R3, overrides R1 mirror-only proposal).
4. **Digital signature protocol** — Architrak orchestrates Archisign two-step (`/create` then `/send`). Architrak handles all envelope lifecycle events.
5. **Completion and authorisation** — On `envelope.signed`, Architrak fires outbound work-authorisation webhook to Archidoc.

### §0.3 Delta log — what changed across rounds

| Decision | R1 position | Final v1.0 position | Driver |
|---|---|---|---|
| Insurance gate model | Mirror-only with override + audit (Architrak R1 §3.1, user-locked) | Mirror + live verdict + override + audit | Archidoc R2 §3 defence-in-depth + R3 user confirmation |
| Insurance endpoint | None (mirror-only) | `POST /api/integrations/architrak/contractors/:contractorId/insurance-verdict` | Archidoc R2 §8.1 |
| `insuranceOverride` block | 5 fields | 7 fields (added `liveVerdictHttpStatus`, `liveVerdictCanProceed`) | Architrak R2 §8.3 + Archidoc R2 §5.4 |
| Event taxonomy | 5 events implied | 7 events, canonical names locked, no aliases on wire | Archisign R2 §3.2 + Architrak/Archidoc R3 acceptances |
| `envelope.retention_breach` | Not in scope | 7th event, exceptional; receivers never mutate prior `signed` state | Archisign R2 §3.3 + Architrak R3 §3 |
| HMAC scheme | Mixed (Architrak: `sha256(${ts}.${body})`; Archidoc R1: `sha256(body)`) | `sha256(${timestamp}.${rawBody})` symmetric across all three apps | Archidoc R2 §7 self-correction |
| HMAC migration | Not specified | 5-week, 4-phase plan with `ARCHISIGN_WEBHOOK_V2_TENANTS` flag | Archidoc R3 §7.3 + Archisign R3 §7.7 |
| Rate limits | Not specified | 60 RPM sustained, burst 30, 5,000/day per (key, endpoint family); 429 + Retry-After | Archisign R2 §3.4 + Architrak R3 §6 peak budget |
| Key rotation | Coordinated | Independent per key, comma-separated env-var lists, in-place rotation with overlap | Archisign R2 §3.5 |
| `/send` idempotency | 409 on re-send | 200 on re-send against `sent`/`viewed`/`queried`; 409 only on terminal states | Archisign R2 §S9 |
| Resend on expiry | Not specified | Same envelope; rotates `accessToken`, fresh OTP, invalidates prior token | Archisign R2 §S10 |
| Local PDF mirror | Both apps planned to archive | Both apps drop archive; rely on Archisign vault + re-mint endpoint | Archidoc R2 §D8 + Architrak R2 §A13 |
| Signed-PDF retention SLA | Not specified | 10 years; annual integrity check; `410 Gone` (not `404`) with `retention_breach` body if breached | Archisign R2 §3.3 + R3 §7.3 |
| `query_resolved` attribution | Not specified | 4 fields: `resolverSource`, `resolverEmail` (nullable), `resolverActor` (enum), `resolutionNote` (nullable) | Archisign R2 §3.1 + R3 §7.1 |
| Cross-path dedup for retention_breach | Implicit | Explicit emission rule: one webhook to create-time `webhookUrl` only (applies to all 7 events) | Archisign R3 §4 |
| Client contact | Single (user-locked) | Single, mirrored from Archidoc when present, local fallback | Architrak R1 §3.4 |

### §0.4 Pre-existing artefacts that the contract relies on but does not redefine

- Architrak's existing `devis_checks` table and contractor query loop (the `client_checks` table is a parallel sibling).
- Archidoc's existing `/api/integrations/archidoc/projects` sync to Architrak (the `clientContact` mirror travels on this channel).
- Archidoc's existing `contractor.updated` webhook to Architrak (the insurance mirror is kept fresh by this channel).
- Archisign's existing `/api/webhooks/archisign` channel into Archidoc for non-devis envelopes (plans, contracts) — this channel is also subject to the v2 HMAC migration but its payloads are out of scope here.
- All three apps' existing `webhook_events` / `webhook_events_in` (or equivalent) idempotency tables — the contract requires their use but does not redefine them.

### §0.5 Field-name disambiguation (guard against rc1 confusion)

Two fields in this contract are both spelled with the substring "event" but are **not the same field** and live on different wires:

- **`event`** (Archisign-emitted webhooks, common envelope, §3.2) — values from the seven canonical names in §3.1
- **`eventType`** (Architrak → Archidoc work-authorisation webhook, §5.3) — discriminator with two values: `"work_authorised"` (default) and `"signed_pdf_retention_breach"`

Receiver implementations must read the right field name on the right channel.

---

## §1 Lifecycle, transitions, gate semantics, retry policy *(Architrak owns)*

### §1.1 `signOffStage` enum — frozen

```ts
export const signOffStageEnum = pgEnum("sign_off_stage", [
  "received",                       // pre-existing
  "checked_internal",               // pre-existing
  "client_review_in_progress",      // NEW
  "client_agreed",                  // NEW
  "client_rejected",                // NEW (terminal)
  "approved_for_signing",           // pre-existing
  "sent_to_client",                 // pre-existing — semantics tightened
  "client_signed_off",              // pre-existing — semantics tightened
  "void",                           // pre-existing (terminal)
]);
```

Terminal stages: `client_rejected`, `void`, `client_signed_off`. The latter is *logically* terminal but technically still receives `envelope.retention_breach` events without changing stage (see §1.2).

### §1.2 Transition table — frozen

| From | To | Trigger | Side-effects |
|---|---|---|---|
| `received` | `checked_internal` | Architect confirms AI-extracted data | none |
| `checked_internal` | `client_review_in_progress` | Architect kicks off optional client review | open new `client_checks` row, send token-auth client portal email |
| `client_review_in_progress` | `client_agreed` | Architect marks resolved (no open `client_checks`) | close all `client_checks` rows |
| `client_review_in_progress` | `client_rejected` | Architect rejects (terminal) | close all `client_checks`, send rejection email |
| `checked_internal` ∨ `client_agreed` | `approved_for_signing` | Architect approves for signing | none |
| `approved_for_signing` | `sent_to_client` | Architect clicks "Send to client" → **insurance gate** (§1.3) → Archisign `/create` → Archisign `/send` | persist `archisignEnvelopeId` |
| `sent_to_client` | `sent_to_client` | `envelope.queried` from Archisign | open `client_checks` row mirroring `queryText`, with `originSource = archisign_query` and `archisignQueryEventId` populated |
| `sent_to_client` | `sent_to_client` | `envelope.query_resolved` from Archisign | close matching `client_checks` row, populate attribution from `resolverSource`/`resolverEmail`/`resolverActor`/`resolutionNote` |
| `sent_to_client` | `client_signed_off` | `envelope.signed` from Archisign | persist `identityVerification` (8-field object, §3.4) and `signedPdfFetchUrl` snapshot, fire outbound work-authorisation webhook to Archidoc |
| `sent_to_client` | `void` | `envelope.declined` from Archisign | persist `voidReason ← declineReason` |
| `sent_to_client` | `approved_for_signing` | `envelope.expired` from Archisign | surface "Resend" action; on architect resend, transition back to `sent_to_client` via existing envelope's `/send` (§3.5.4) |
| `client_signed_off` | `client_signed_off` | `envelope.retention_breach` from Archisign | open `signed_pdf_retention_breaches` row, surface red banner, fire downstream re-notification to Archidoc (§5.3.2) |
| `*` (non-terminal) | `void` | Architect manual void | persist `voidReason` |

### §1.3 Insurance gate semantics — at `approved_for_signing → sent_to_client`

1. Architrak calls `POST /api/integrations/architrak/contractors/:contractorId/insurance-verdict` with `{ projectId, intendedWorkLot? }`, bearer-authed via `ARCHIDOC_SYNC_API_KEY`.
2. Outcomes:
   | Response | Gate verdict | Architect action |
   |---|---|---|
   | `200` + `canProceed: true` | Green | Proceed |
   | `200` + `canProceed: false` | Red | **Overridable** with mandatory reason |
   | `404` | Red | **Non-overridable** (data fix: contractor must be assigned to project in Archidoc) |
   | `503` or timeout >5s | Red | **Overridable** with prominent "Archidoc unreachable" warning |
3. Override writes to Architrak's `insurance_overrides` table (see §2.1.4) capturing `liveVerdictHttpStatus`, `liveVerdictResponse` (jsonb), `mirrorStatusAtOverride`, `mirrorSyncedAtAtOverride`, `overrideReason`, `overriddenByUserEmail`, `liveVerdictCanProceed`.
4. The full override block is echoed verbatim into the work-authorisation webhook's `insuranceOverride` field (see §5.3.1) and on Archidoc's side lands inside `insurance_audit_log.metadata` rather than as new columns on `work_authorisations` (per Archidoc R3 §6).
5. The mirror persists for list badges and dashboard hints; it is **no longer the gate's source of truth.**

### §1.4 Outbound retry policy — Architrak as sender

Applies to: Architrak → Archisign (`/create`, `/send`, `/signed-pdf-url`); Architrak → Archidoc (`/work-authorisations`, including the `signed_pdf_retention_breach` discriminated variant).

- 3 attempts, 1s/3s backoff, 10s per-attempt timeout
- Retry on 5xx + network errors only (plus 429 with `Retry-After` honoured per §3.6)
- 4xx fails immediately and dead-letters into Architrak's `webhook_deliveries_out` table
- Stable `eventId` UUID across retries (consumers dedup)
- Admin UI exposes a one-click "Retry" button per dead-letter row

**Exception — insurance verdict call:** total 5-second budget (architect-blocking UX), not 10s/attempt × 3.

### §1.5 Inbound retry expectation — Architrak as receiver

Applies to: Archisign → Architrak (the seven canonical events).

- 200 within 5s on first delivery and on every retry
- Dedup by `eventId` against `webhook_events` table
- 401 on signature/timestamp issues (non-retryable from Archisign's view)
- 410 on unknown envelope (non-retryable)
- All other errors map to 5xx so Archisign's own retry logic engages

### §1.6 Architrak's peak rate (declared for §3.6 budget calibration)

10–25 envelopes per 30-min architect session (largest tenant, Monday-morning batch); <200/day per tenant. Per Archisign R3 §5: 25-in-30-min is ~0.83 RPM (well below 60 RPM); a 25-in-5-min worst-case burst consumes 25 of 30 burst tokens with 5 head-room and 1 token/sec refill; 200/day is 4% of the 5,000/day ceiling. No budget adjustment requested.

---

## §2 Schema deltas across all three apps + v2 migration timeline *(Archidoc owns; Architrak transcribes)*

> **Footnote (per Archidoc R3 transcription pitfall #1):** `signed_pdf_retention_breaches` appears in **both** Architrak's and Archidoc's schema. These are **parallel tables in separate databases**, not a shared table. Architrak's instance handles devis-derived envelopes (rows created on receipt of `envelope.retention_breach` for envelopes Architrak created); Archidoc's instance handles non-devis envelopes (plans, contracts — created via Archidoc's own pre-existing Archisign integration). Archisign's emission rule (§3.7) guarantees disjoint envelope sets, so the two tables never reference the same envelope.

### §2.1 Architrak schema deltas

#### §2.1.1 `client_checks` (NEW)
Parallel to existing `devis_checks` but for client-side dialogue. Same security/gating model.

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `devisId` | int FK → devis.id, NOT NULL | indexed |
| `status` | enum (`open`, `resolved`, `cancelled`) | |
| `queryText` | text NOT NULL | mirrors Archisign `envelope.queried.queryText` if originated there |
| `originSource` | enum (`architrak_internal`, `archisign_query`) | |
| `archisignQueryEventId` | text NULL | populated when `originSource = archisign_query` |
| `resolvedBySource` | enum (`architrak_internal`, `archisign_admin_ui`, `external`) NULL | from `envelope.query_resolved.resolverSource` |
| `resolvedByUserEmail` | text NULL | from `envelope.query_resolved.resolverEmail` (nullable per §3.3) |
| `resolvedByActor` | enum (`architect`, `system`) NULL | from `envelope.query_resolved.resolverActor` |
| `resolutionNote` | text NULL | from `envelope.query_resolved.resolutionNote` (nullable per §3.3) |
| `openedAt` | timestamptz NOT NULL | |
| `resolvedAt` | timestamptz NULL | |

#### §2.1.2 `client_check_messages` (NEW)
Conversation log for `client_checks`. Mirrors existing `devis_check_messages` shape.

#### §2.1.3 `client_check_tokens` (NEW)
Token-auth credentials for the client portal. Mirrors existing contractor portal token table.

#### §2.1.4 `insurance_overrides` (NEW)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `devisId` | int FK → devis.id NOT NULL | indexed |
| `userId` | int FK → users.id NOT NULL | architect who overrode |
| `overrideReason` | text NOT NULL | mandatory |
| `mirrorStatusAtOverride` | text NOT NULL | snapshot |
| `mirrorSyncedAtAtOverride` | timestamptz NOT NULL | snapshot |
| `liveVerdictHttpStatus` | int NOT NULL | 200/404/503/0 (timeout) |
| `liveVerdictCanProceed` | boolean NULL | NULL if non-200 |
| `liveVerdictResponse` | jsonb NULL | full response body when available |
| `overriddenByUserEmail` | text NOT NULL | denormalised for audit log immutability |
| `createdAt` | timestamptz NOT NULL DEFAULT now() | |

#### §2.1.5 `signed_pdf_retention_breaches` (NEW, parallel to Archidoc's — see footnote above)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `devisId` | int FK → devis.id NOT NULL | indexed |
| `archisignEnvelopeId` | text NOT NULL | indexed |
| `originalSignedAt` | timestamptz NOT NULL | from breach payload |
| `detectedAt` | timestamptz NOT NULL | from breach payload |
| `incidentRef` | text NOT NULL | Archisign-issued opaque identifier |
| `remediationContact` | text NOT NULL | from breach payload |
| `receivedAt` | timestamptz NOT NULL DEFAULT now() | |
| `acknowledgedAt` | timestamptz NULL | architect ack timestamp |
| `acknowledgedByUserId` | int FK → users.id NULL | |

#### §2.1.6 `webhook_deliveries_out` (NEW)
Outbound delivery log + dead-letter queue for Architrak's outbound webhooks. Schema follows existing inbound `webhook_events` pattern with addition of `attemptCount`, `lastAttemptAt`, `lastErrorBody`, `state` (`pending`/`succeeded`/`dead_lettered`).

#### §2.1.7 New columns on `devis`
- `archidocDqeExportId` text NULL — read from Gmail header (case-insensitive)
- `archisignEnvelopeId` text NULL, indexed
- `identityVerification` jsonb NULL — populated on `envelope.signed` with the 8-field block per §3.4 (single object, not an array)
- `signedPdfFetchUrlSnapshot` text NULL — convenience snapshot of the URL delivered with `envelope.signed`; receivers must re-mint via §3.5.3 once expired

#### §2.1.8 New columns on `projects`
- `clientContactName` text NULL
- `clientContactEmail` text NULL
- (Source of truth: Archidoc when present via `/projects` sync; Architrak local edit as fallback.)

#### §2.1.9 Enum deltas
- `signOffStage`: add `client_review_in_progress`, `client_agreed`, `client_rejected`
- New enum `client_check_status`: `open`, `resolved`, `cancelled`
- New enum `client_check_origin`: `architrak_internal`, `archisign_query`
- New enum `client_check_resolver_source`: `architrak_internal`, `archisign_admin_ui`, `external`
- New enum `client_check_resolver_actor`: `architect`, `system`

All Architrak deltas ship as one atomic Drizzle migration.

### §2.2 Archidoc schema deltas

Per Archidoc R3 §6 + §7.1 inventory.

#### §2.2.1 `work_authorisations` (NEW)
Receives the work-authorisation webhook from Architrak. Full schema per Archidoc R2 §6 (out of scope to re-transcribe column-by-column here; key shape: `architrakDevisId`, `projectId`, `contractorId`, `archisignEnvelopeId`, `signedAt`, `identityVerification` jsonb, `dqeExportId`, `webhookEventId` UNIQUE for dedup). The `eventType` discriminator on the inbound payload (§5.3) is read at the handler: `"work_authorised"` payloads insert into `work_authorisations`; `"signed_pdf_retention_breach"` payloads insert into `signed_pdf_retention_breaches` (§2.2.3) with a FK link to the existing `work_authorisations` row. There is no `eventType`, `incidentRef`, or `originalSignedAt` column on `work_authorisations` itself.

> **Note on `insuranceOverride` storage:** Per Archidoc R3 §6 / §7.1, the `insuranceOverride` block (§5.3.1, 7 fields) is stored verbatim in the existing `insurance_audit_log.metadata` JSONB column rather than added as columns on `work_authorisations`. This is Archidoc's internal storage choice; it does not affect the wire shape Architrak emits. **Open for Step 3 confirmation by Archidoc** that this is the intended row shape and that no `insuranceOverride` columns sit on `work_authorisations` itself.

#### §2.2.2 `webhook_events_in` (NEW)
Standard idempotency table for inbound webhooks (both from Architrak and from Archisign).

#### §2.2.3 `signed_pdf_retention_breaches` (NEW — parallel to Architrak's, see footnote)
Per Archidoc R3 §6, with `eventSource` column (`'archisign' | 'architrak'`) recording which path delivered the breach first. Full schema:

```ts
export const signedPdfRetentionBreaches = pgTable("signed_pdf_retention_breaches", {
  id: varchar("id", { length: 255 }).primaryKey(),
  eventId: varchar("event_id", { length: 255 }).notNull().unique(),
  eventSource: varchar("event_source", { length: 32 }).notNull(),  // 'archisign' | 'architrak'
  archisignEnvelopeId: varchar("archisign_envelope_id", { length: 64 }).notNull(),
  workAuthorisationId: varchar("work_authorisation_id", { length: 255 })
    .references(() => workAuthorisations.id, { onDelete: "set null" }),  // nullable: orphan envelopes valid
  archidocProjectId: varchar("archidoc_project_id", { length: 255 })
    .references(() => projects.id, { onDelete: "set null" }),
  originalSignedAt: timestamp("original_signed_at").notNull(),
  detectedAt: timestamp("detected_at").notNull(),
  incidentRef: varchar("incident_ref", { length: 255 }).notNull(),
  remediationContact: text("remediation_contact").notNull(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  acknowledgedAt: timestamp("acknowledged_at"),
  acknowledgedByUserEmail: varchar("acknowledged_by_user_email", { length: 255 }),
}, (t) => [
  index("idx_retention_breach_envelope").on(t.archisignEnvelopeId),
  index("idx_retention_breach_project").on(t.archidocProjectId),
  index("idx_retention_breach_work_auth").on(t.workAuthorisationId),
]);
```

#### §2.2.4 Other Archidoc deltas
- Drops `archivedPdfStoragePath` on existing envelope-related table (no local PDF mirror per Archidoc R2 §D8)
- `insurance_audit_log.metadata` (existing JSONB column) accepts the 7-field `insuranceOverride` block verbatim; no new columns required
- No breaking changes to existing tables

All Archidoc deltas ship as one atomic Drizzle migration `drizzle/00XX_devis_signoff_workflow.sql`.

### §2.3 Archisign schema deltas

Per Archidoc R3 §7.1 cross-app inventory. App-internal (the contract does not constrain) but transcribed for completeness:

- New table: `webhook_deliveries` (idempotency + dead-letter; mirrors Architrak's `webhook_deliveries_out` pattern)
- New columns on existing `envelopes` table: `expiresAt`, `declineReason`, `origin`
- New status enum value on envelope status: `expired`
- Access-token rotation fields on `signers` (Archisign-internal mechanics for §3.5.4 resend semantics)

Single atomic Drizzle migration on the Archisign side.

### §2.4 v2 HMAC migration timeline

5-week plan, 4 phases. Architrak's new inbound channel ships v2 from day one (no dual-verify). Migration cost is absorbed entirely by Archisign (dual-emit) and Archidoc (dual-verify) on the pre-existing `/api/webhooks/archisign` channel.

| Phase | Weeks | Archisign action | Archidoc action | Architrak action | Risk |
|---|---|---|---|---|---|
| **P0: Pre-flight** | Week 0 | Add `ARCHISIGN_WEBHOOK_V2_TENANTS` env var, deploy without enabling v2 | Confirm test env ready for verifier dev | N/A — born v2 | None |
| **P1: Dual-emit** | Weeks 1–2 | Enable dual-emit for Archidoc test tenant first, then production tenant after week 1 | Verifier ignores unknown headers; baseline logging captures v1 success metrics | N/A | Low |
| **P2: Dual-verify, prefer-v2** | Weeks 3–4 | Continues dual-emit unchanged | Ship updated `verifyArchisignWebhook.ts`; metric counter `archisign_webhook_verify_path{version}`; require ≥1 week of `v1=0` count | N/A | Medium — verifier bug breaks Archidoc inbound |
| **P3: Cut-over** | Week 5 | Drop legacy header; v2-only emission | Verifier hard-requires v2; legacy code path deleted; status code aligned to 401 | N/A — by construction P2 covers 100% | Low |

`ARCHISIGN_WEBHOOK_V2_TENANTS` is cleared at P3 cutover.

---

## §3 Envelope and event taxonomy, retention SLA, rate limits, orchestration, HMAC wire spec *(Archisign owns; Architrak transcribes)*

> **Annotation (per Archidoc R3 transcription pitfall #2):** Each app implements the v2 HMAC verifier in its own naming convention — Architrak: `server/middleware/hmac-verifier.ts` (kebab-case); Archidoc: `server/middleware/hmacVerifier.ts` (camelCase); Archisign: `server/services/WebhookSignature.ts`. The algorithm is **byte-identical** across all three (see §3.9.1 reference implementation). The path divergence is intentional, not a typo.
>
> **Boundary note (per Archisign R3 transcription pitfall #2):** The `insuranceOverride` block (with `liveVerdictHttpStatus`/`liveVerdictCanProceed` fields per §1.3 / §2.1.4 / §5.3.1) travels on Architrak's outbound webhook to Archidoc only. **Archisign never sees it.** It is not echoed in any Archisign-emitted webhook payload.

### §3.1 Seven canonical events

Wire names locked. No aliases. Receivers' verifier whitelists accept only these seven values.

| Event | When emitted | Receiver state change |
|---|---|---|
| `envelope.sent` | After successful `/send` and signer email dispatch | Receiver records sent state |
| `envelope.queried` | Signer raises a query via Archisign portal | Receiver opens query (Architrak: `client_checks` row) |
| `envelope.query_resolved` | Query closed (Archisign admin UI or external) | Receiver closes query with attribution |
| `envelope.declined` | Signer or admin declines | Receiver transitions to terminal `void` (Architrak) |
| `envelope.expired` | Sweeper detects `expiresAt` passed without signature | Receiver allows resend (§3.5.4) |
| `envelope.signed` | All required signers signed and PDF stamped | Receiver fires downstream side-effects (Architrak: work-auth to Archidoc) |
| `envelope.retention_breach` | Annual integrity check fails for this envelope | Receiver records audit, surfaces incident; **does not** mutate prior `signed` state |

Lifecycle ordering (informational): `sent → (queried ↔ query_resolved)* → terminal (signed | declined | expired)`. `retention_breach` is post-terminal and only follows `signed`.

### §3.2 Common envelope event payload shape

```jsonc
{
  "eventId": "uuid-stable-across-retries",          // dedup key
  "event": "envelope.<name>",                        // canonical name from §3.1
  "envelopeId": 5678,                                // integer, opaque to receivers
  "externalRef": "architrak:devis:1234" | null,      // caller-supplied at create
  "metadata": { /* verbatim object from create */ } | null,
  "occurredAt": "ISO-8601"
  // ... per-event fields per §3.3
}
```

> **Note:** the wire field name is **`event`**, not `eventType`. The discriminator field `eventType` exists only on Architrak → Archidoc work-authorisation webhooks (§5.3) and carries different values (`work_authorised` | `signed_pdf_retention_breach`). Per §0.5.

### §3.3 Per-event additional fields

Verbatim per Archisign R3 §7.1.

```jsonc
// envelope.sent
{ ..., "event": "envelope.sent",
  "signers": [{ "email": "client@firm.fr", "name": "Marie Client" }] }

// envelope.queried
{ ..., "event": "envelope.queried",
  "queryId": "q_abc",
  "signerEmail": "client@firm.fr",
  "queryText": "What is the scope of lot 03?",
  "queriedAt": "ISO-8601" }

// envelope.query_resolved
{ ..., "event": "envelope.query_resolved",
  "queryId": "q_abc",
  "resolvedAt": "ISO-8601",
  "resolverSource": "archisign_admin_ui" | "external",
  "resolverEmail": "admin@firm.fr" | null,
  "resolverActor": "architect" | "system",
  "resolutionNote": "Scope clarified by phone" | null }

// envelope.declined
{ ..., "event": "envelope.declined",
  "declinedBy": "client@firm.fr" | "archisign_admin",   // string discriminator, not nested
  "declinedAt": "ISO-8601",
  "declineReason": "Wrong amount" }

// envelope.expired
{ ..., "event": "envelope.expired",
  "expiredAt": "ISO-8601" }   // = the original expiresAt set at create

// envelope.signed
{ ..., "event": "envelope.signed",
  "signedAt": "ISO-8601",
  "signedPdfFetchUrl": "https://archisign.../signed-pdf?token=...",   // 15-min TTL
  "signedPdfFetchUrlExpiresAt": "ISO-8601",
  "identityVerification": { /* 8-field object per §3.4 */ } }

// envelope.retention_breach
{ ..., "event": "envelope.retention_breach",
  "originalSignedAt": "ISO-8601",
  "detectedAt": "ISO-8601",
  "incidentRef": "INC-2036-04-26-0001",
  "remediationContact": "vault-ops@archisign.fr" }
```

### §3.4 `identityVerification` block — frozen 8-field schema

Embedded inside the `envelope.signed` payload as a **single object** (not an array). Both receivers persist verbatim into a single jsonb column without flattening.

```jsonc
"identityVerification": {
  "method":            "otp_email",          // enum, single value today
  "otpIssuedAt":       "ISO-8601",
  "otpVerifiedAt":     "ISO-8601",
  "signerIpAddress":   "203.0.113.42",       // IPv4 or IPv6
  "signerUserAgent":   "Mozilla/5.0 ...",
  "lastViewedAt":      "ISO-8601",
  "signedAt":          "ISO-8601",
  "authenticationId":  "auth_abc123"         // Archisign's own audit-trail FK
}
```

### §3.5 Three endpoint contracts

#### §3.5.1 `POST /api/v1/envelopes/create`

```
Header: X-API-KEY: <ARCHITRAK_API_KEY | ARCHIDOC_API_KEY>
Body:   { pdfFetchUrl, externalRef?, metadata?, signers[], fields[],
          webhookUrl, expiresAt?, identityVerification: { method } }

Response 201: { envelopeId, status: "draft", createdAt, expiresAt,
                signers: [{ id, accessToken, accessUrl, otpDestination }] }

Errors:
  401  invalid X-API-KEY
  400  pdfFetchUrl unfetchable within 60s budget
  413  PDF > 25 MiB
  429  rate-limited (per §3.6)
  503  vault transient
```

`pdfFetchUrl` is fetched server-side by Archisign within 60s. Architrak/Archidoc must serve a signed URL with TTL ≥ 60s (Architrak uses 15-min TTL by convention, comfortably above the budget).

#### §3.5.2 `POST /api/v1/envelopes/:envelopeId/send`

```
Header: X-API-KEY: <same key as create>
Body:   {} (idempotent on send)

Response 200 — on first send AND on re-send against status ∈ {sent, viewed, queried}:
  { envelopeId, status, sentAt }

Errors:
  401
  404  envelope not found
  409  envelope status ∈ {signed, declined, expired, void}
  429
  503
```

Idempotency-on-resend (§AS9 / Architrak AT5) makes Architrak's outbound retry safe by contract.

#### §3.5.3 `GET /api/v1/envelopes/:envelopeId/signed-pdf-url`

```
Header: X-API-KEY: <ARCHITRAK_API_KEY | ARCHIDOC_API_KEY>

Response 200: { url, expiresAt }   // 15-min signed-URL TTL

Errors:
  401
  404
  410  retention_breach — body shape per §3.8
  429
  503
```

#### §3.5.4 Resend-on-expiry semantics

On `envelope.expired`, the receiver may call `POST /:envelopeId/send` against the **same** envelope (no new `/create`). Archisign rotates the signer's `accessToken`, invalidates the previous token, and issues a fresh OTP on next signer access. The receiver's stored `signers[].accessToken` is therefore stale post-resend; the receiver does not surface or rely on it post-resend.

If the architect needs a different signer entirely, they perform a fresh `/create` (new envelope, new `envelopeId`, new audit chain) — explicit architect choice, never automatic.

### §3.6 Rate limits

Sustained 60 RPM, burst 30 (token bucket, 1 token/second refill), daily ceiling 5,000/day. All counters per **(API key, endpoint family)** pair. Endpoint families:

- `create` → `POST /api/v1/envelopes/create`
- `send` → `POST /:envelopeId/send`
- `read` → `GET /:envelopeId`, `GET /:envelopeId/signed-pdf-url`

#### §3.6.1 429 response shape (per Archisign R3 §5)

```
Status: 429 Too Many Requests
Headers:
  Retry-After: <seconds>
  X-RateLimit-Remaining: <count>
Body: {
  "error": "rate_limit_exceeded",
  "retryAfter": <seconds>,            // exact match to Retry-After header
  "limit": "sustained" | "burst" | "daily",
  "currentUsage": <int>,
  "ceiling": <int>
}
```

#### §3.6.2 X-RateLimit-Remaining on every 200

`X-RateLimit-Remaining: <count>` is set on **every 200 response**, not just 429s. Architrak surfaces this as a green/amber/red "vault throughput" indicator in the admin UI pre-emptively.

#### §3.6.3 Soft alarms

If a tenant breaches 80% of any limit, Archisign alerts and contacts the tenant owner via `remediationContact`. Architrak coordinates with Archisign before requesting a raise.

### §3.7 Webhook emission rule — single delivery to create-time `webhookUrl` *(per Archisign R3 §4)*

For all seven events (including `envelope.retention_breach`), Archisign emits **exactly one webhook** per `eventId`, to the `webhookUrl` recorded at envelope-create time. Archisign does not maintain a registry of "all interested receivers" per envelope, does not consult caller tenant identity at emission time, and does not fan out to a list.

Consequences for the devis workflow:

- **Devis envelopes** (created by Architrak, `webhookUrl = ARCHITRAK_BASE/api/webhooks/archisign`) — Archisign emits to **Architrak only**. Architrak's downstream re-notification to Archidoc (§5.3.2) is the sole way Archidoc learns about the devis-envelope breach.
- **Non-devis envelopes** (created by Archidoc, `webhookUrl = ARCHIDOC_BASE/api/webhooks/archisign`) — Archisign emits to **Archidoc only**. Architrak does not learn about these envelopes from Archisign at all.

This rule is the basis for the "parallel, not shared" footnote on `signed_pdf_retention_breaches` (§2). Future contributors should not assume Archisign fans out across receivers.

### §3.8 10-year retention SLA + `410 retention_breach` body

- **Retention period:** 10 years from `signedAt` per envelope.
- **Annual integrity check:** Archisign runs an integrity job once per calendar year that walks the vault and verifies every retained envelope is retrievable. Envelopes that fail the check are marked `retention_breach` internally.
- **Read-side error code on breached envelopes:** both `GET /api/v1/envelopes/:envelopeId` and `GET /api/v1/envelopes/:envelopeId/signed-pdf-url` return:

```
Status: 410 Gone
Content-Type: application/json
Body: {
  "error": "retention_breach",
  "envelopeId": 5678,
  "originalSignedAt": "ISO-8601",
  "detectedAt": "ISO-8601",
  "incidentRef": "string",
  "remediationContact": "string"
}
```

- **One-shot webhook on breach detection:** Archisign emits `envelope.retention_breach` (per §3.3) to the `webhookUrl` recorded at envelope-create time. Per §3.7, single emission to a single receiver.
- **410 is not 404** — the legal distinction matters. `404` says "we never had this." `410 + retention_breach` says "we had it, we know it was signed at `originalSignedAt`, and we know the bytes are no longer retrievable as of `detectedAt`." This preserves the audit position even when the artefact is gone.
- **410 is definitive and indefinite** — no caches, no half-states, no surprise resurrections. Receivers do not retry. The `incidentRef` is the human escalation channel; remediation is out-of-band.

### §3.9 v2 HMAC wire spec

- **Algorithm:** HMAC-SHA256, hex-encoded
- **Signed material:** `${X-Archisign-Timestamp}.${rawBody}` — literal `.` joiner; raw request bytes (not re-stringified parsed JSON); timestamp is decimal unix-ms string
- **Headers on every Archisign-emitted webhook:**
  - `X-Archisign-Signature: sha256=<hex>` (post-v2; legacy `X-Archisign-Signature` co-emitted during P1 dual-emit per §2.4)
  - `X-Archisign-Timestamp: <unix ms>`
- **Replay window:** ±5 minutes server time, enforced via `crypto.timingSafeEqual` on recomputed signature
- **Receiver error codes:** missing/malformed header → 401 (non-retryable); stale timestamp → 401; signature mismatch → 401 (Archidoc's existing 403 aligns to 401 at P3 cutover per their R2 §4)
- **Body size cap:** 1 MiB → 413
- **Symmetric:** Architrak/Archidoc emissions to Archisign use the same scheme (Archisign is not a receiver in the devis workflow today, but the scheme is reusable)

#### §3.9.1 Reference verifier (byte-identical across all three apps)

```ts
function verify({ secret, rawBody, timestampHeader, signatureHeader }): boolean {
  if (!timestampHeader || !signatureHeader) return false;
  const ts = parseInt(timestampHeader, 10);
  if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestampHeader}.${rawBody}`)
    .digest('hex');
  const received = signatureHeader.replace(/^sha256=/, '');
  if (expected.length !== received.length) return false;   // length guard before timingSafeEqual
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(received, 'hex')
  );
}
```

The `length !== length` guard before `crypto.timingSafeEqual` is a hard contract requirement, not stylistic — `timingSafeEqual` throws on length mismatch.

### §3.10 Event payload size and ordering

- Event payloads ≤ 1 MiB
- Archisign does not guarantee delivery ordering between distinct events of the same envelope (e.g. `envelope.queried` and `envelope.query_resolved` may be observed out-of-order under retry); receivers must use `occurredAt` for ordering and `eventId` for dedup

---

## §4 Co-owned secrets matrix

| Variable | Holder app (source of truth) | Other app(s) using | Purpose | Rotation policy |
|---|---|---|---|---|
| `ARCHIDOC_API_KEY` | Archisign | Archidoc (caller) | Authenticates Archidoc → Archisign endpoint calls | Comma-separated list per §3.6 / Archisign R2 §3.5; rotation initiated by Archisign, copy distributed to Archidoc out-of-band; revocation independent of `ARCHITRAK_API_KEY` |
| `ARCHITRAK_API_KEY` | Archisign | Architrak (caller) | Authenticates Architrak → Archisign endpoint calls | Comma-separated list; same rotation pattern; independent of `ARCHIDOC_API_KEY` |
| `ARCHISIGN_WEBHOOK_SECRET` | Archisign (single value, distributed) | Architrak, Archidoc (receivers/verifiers) | HMAC secret for Archisign-emitted webhooks (§3.9) | Same value distributed to both receivers; rotation announced by Archisign with a 2-week dual-secret window where both old and new are accepted; comma-separated list on receiver side during the window |
| `ARCHISIGN_WEBHOOK_V2_TENANTS` | Archisign | none (Archisign-internal) | Per-tenant feature flag for v2 dual-emit during §2.4 P1 phase | Cleared at P3 cutover; not a secret per se — flag value, no rotation |
| `ARCHISIGN_BASE_URL` | Archisign (publishes) | Archidoc, Architrak (callers) | Per-environment Archisign API base URL | Per-environment, no rotation |
| `ARCHIDOC_SYNC_API_KEY` | Archidoc | Architrak (caller) | Authenticates Architrak → Archidoc calls (insurance-verdict §1.3, plus pre-existing project/contractor sync polls) | Rotation initiated by Archidoc; comma-separated list on Architrak side during overlap window |
| `ARCHITRAK_WEBHOOK_SECRET` | Architrak (single value, distributed) | Archidoc (receiver/verifier) | HMAC secret for Architrak → Archidoc webhooks (work-authorisation channel) | Rotation initiated by Architrak; 2-week dual-secret window; comma-separated list on Archidoc side during the window |

---

## §5 Frozen wire payloads — every webhook event + every endpoint request/response shape, in one place

> Distilled from §1, §2, §3. This section adds nothing new; it's the single lookup target for receiver/sender developers.

### §5.1 Architrak ↔ Archisign — endpoint requests/responses

#### `POST /api/v1/envelopes/create` — see §3.5.1

#### `POST /api/v1/envelopes/:envelopeId/send` — see §3.5.2

#### `GET /api/v1/envelopes/:envelopeId/signed-pdf-url` — see §3.5.3

### §5.2 Archisign → Architrak — webhook events

All seven events follow §3.2 common envelope (field name **`event`**) with §3.3 per-event additions. Headers per §3.9 (`X-Archisign-Signature: sha256=<hex>`, `X-Archisign-Timestamp: <unix ms>`).

Verbatim payload shapes per §3.3 above. The signed event in particular:

```jsonc
// envelope.signed — note: identityVerification is a single object, not an array
{
  "eventId": "uuid-stable-across-retries",
  "event": "envelope.signed",
  "envelopeId": 5678,
  "externalRef": "architrak:devis:1234",
  "metadata": { "...": "round-tripped from /create" },
  "occurredAt": "2026-04-25T10:30:00Z",
  "signedAt": "2026-04-25T10:30:00Z",
  "signedPdfFetchUrl": "https://archisign.../signed-pdf?token=...",
  "signedPdfFetchUrlExpiresAt": "2026-04-25T10:45:00Z",
  "identityVerification": {
    "method": "otp_email",
    "otpIssuedAt": "2026-04-25T10:25:00Z",
    "otpVerifiedAt": "2026-04-25T10:26:00Z",
    "signerIpAddress": "203.0.113.42",
    "signerUserAgent": "Mozilla/5.0 ...",
    "lastViewedAt": "2026-04-25T10:29:00Z",
    "signedAt": "2026-04-25T10:30:00Z",
    "authenticationId": "auth_abc123"
  }
}
```

### §5.3 Architrak → Archidoc — outbound webhooks

`POST /api/integrations/architrak/work-authorisations`
Auth: `X-Architrak-Signature: sha256=<hex>` + `X-Architrak-Timestamp: <unix ms>` per §3.9 scheme, `ARCHITRAK_WEBHOOK_SECRET` per §4.
Discriminator field: **`eventType`** (not `event` — see §0.5).

#### §5.3.1 Default variant — `eventType: "work_authorised"`

```jsonc
{
  "eventId": "uuid-stable-across-retries",
  "eventType": "work_authorised",
  "architrakDevisId": 456,
  "projectId": 789,                       // Architrak's project id
  "archidocProjectId": "abc-123",         // mirror of Archidoc's project id
  "contractorId": 1011,
  "archisignEnvelopeId": "1234567890",
  "signedAt": "2026-04-25T10:30:00Z",
  "identityVerification": {                // 8-field object per §3.4 (NOT signerIdentityTrail, NOT array)
    "method": "otp_email",
    "otpIssuedAt": "2026-04-25T10:25:00Z",
    "otpVerifiedAt": "2026-04-25T10:26:00Z",
    "signerIpAddress": "203.0.113.42",
    "signerUserAgent": "Mozilla/5.0 ...",
    "lastViewedAt": "2026-04-25T10:29:00Z",
    "signedAt": "2026-04-25T10:30:00Z",
    "authenticationId": "auth_abc123"
  },
  "dqeExportId": "DQE-2026-001",          // nullable; from Gmail header at ingestion
  "insuranceOverride": {                   // present iff override at gate; lands in Archidoc's insurance_audit_log.metadata
    "overrideReason": "Insurance certificate received by post, not yet uploaded",
    "mirrorStatusAtOverride": "expired",
    "mirrorSyncedAtAtOverride": "2026-04-20T08:00:00Z",
    "liveVerdictHttpStatus": 200,
    "liveVerdictCanProceed": false,
    "liveVerdictResponse": { "canProceed": false, "reason": "Decennale expired 2026-03-01" },
    "overriddenByUserEmail": "architect@firm.fr"
  }
}
```

#### §5.3.2 Discriminated variant — `eventType: "signed_pdf_retention_breach"`

Fired when Architrak receives `envelope.retention_breach` for a devis whose `work_authorised` was previously delivered. Payload shape per Archidoc R3 §4 verbatim:

```jsonc
{
  "eventId": "uuid-stable-across-retries",
  "eventType": "signed_pdf_retention_breach",
  "architrakDevisId": 1234,
  "archisignEnvelopeId": "5678",
  "archidocProjectId": "abc-123",          // from Architrak's project mirror
  "incidentRef": "INC-2036-04-26-0001",
  "remediationContact": "vault-ops@archisign.fr",
  "originalSignedAt": "2026-04-25T10:30:00Z",
  "detectedAt": "2036-04-26T03:00:00Z"
}
```

The `eventType` field is **additive and backward-compatible**: absence on Archidoc's side defaults to `"work_authorised"`.

### §5.4 Architrak → Archidoc — insurance verdict request

`POST /api/integrations/architrak/contractors/:contractorId/insurance-verdict`
Auth: `Authorization: Bearer <ARCHIDOC_SYNC_API_KEY>` per §4.

```jsonc
// Request
{ "projectId": 789, "intendedWorkLot": "lot 03 — gros oeuvre" }   // intendedWorkLot optional

// 200 OK
{ "canProceed": true, "reason": null, "checkedAt": "..." }
// or
{ "canProceed": false, "reason": "Decennale expired 2026-03-01", "checkedAt": "..." }

// 404 Not Found  (contractor not on project — non-overridable per §1.3)
// 503 Service Unavailable  (overridable with prominent warning)
```

Architrak applies the §1.4 outbound retry policy with one exception: the gate call uses a 5-second total budget (architect-blocking UX), not the standard 10s/attempt × 3.

### §5.5 Archidoc → Architrak — pre-existing channels (referenced, not redefined)

- `contractor.updated` webhook (insurance mirror refresh)
- `/api/integrations/archidoc/projects` sync poll (project + clientContact mirror)
- DQE extract email with `x-archidoc-dqe-export-id` Gmail header (lower-case form per RFC 7230 §3.2; case-insensitive read at Architrak ingestion)

These pre-date this contract. Their continued operation is a precondition; their wire shapes are not changed by v1.0.

---

## §6 Open items intentionally deferred to v2 of the contract

None today. The contract is complete and consistent at v1.0. This section is a placeholder for future amendments. Any new design content raised at Step 3 review must be queued here rather than modifying §1–§5.

---

## §7 Sign-off block

| App | Round 3 §7 source | Confirmed at Step 3? | Confirmed by | Date |
|---|---|---|---|---|
| Architrak | (this draft is the source) | self-attested by drafter | Architrak | 2026-04-25 |
| Archidoc | R3 §6 + §7 + §7.3 + §7.4 | `confirmed v1.0-rc3` (rc2 returned `confirmed-with-correction` per §A.1 + §D.1 + §D.2; all three deltas verified verbatim in rc3 review) | Archidoc | 2026-04-25 |
| Archisign | R3 §7.1–§7.7 + §8 | `confirmed v1.0-rc2` with explicit pre-commitment to higher rc tags (rc3 changes are Archidoc-internal §2 only, do not touch §3 or §4 Archisign-owned content; confirmation transitively applies to v1.0-rc3 and to this v1.0 freeze) | Archisign | 2026-04-25 |

**Contract is frozen at v1.0 as of 2026-04-25.** All three apps have confirmed; no further review cycles. Subsequent changes require a v1.1 (or later) versioned amendment proposal through the same R1 → R2 → R3 → Step 3 read-and-confirm protocol — no in-place edits to v1.0.

---

## End of consolidated contract v1.0 (FROZEN 2026-04-25)
