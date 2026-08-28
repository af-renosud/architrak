import { z } from "zod";

/**
 * Centralized, type-safe environment configuration.
 *
 * Single source of truth for every server-side `process.env` read.
 * The schema is parsed once at module load. If validation fails, the
 * process logs the offending key NAMES (never values) and exits with
 * code 1 — fail-fast, no leaked secrets.
 *
 * Frontend env (Vite `import.meta.env.VITE_*`) is intentionally NOT
 * covered here.
 *
 * Replit-managed auto-generated integrations under
 * `server/replit_integrations/**` are treated as vendored and continue to
 * read `process.env` directly so platform regenerations stay clean.
 *
 * Required vs optional policy: a variable is `required` only if the
 * server cannot boot without it. Feature-scoped secrets (auth, AI,
 * ArchiDoc, object storage, etc.) are `optional` because the existing
 * code paths already handle their absence by disabling the relevant
 * feature at first use.
 */

// Treats `undefined` and empty/whitespace-only strings as "not set". This
// preserves the previous `process.env.X || ""` semantics so optional
// feature-scoped vars don't crash boot when present-but-empty.
const optionalString = () =>
  z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().min(1),
    )
    .optional();

const optionalUrl = () =>
  z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().url(),
    )
    .optional();

// Parses common boolean string forms ("true"/"false"/"1"/"0"/"yes"/"no")
// into a real boolean. Empty/undefined → default. Anything unrecognized
// fails validation (fail-fast on garbage flag values).
const booleanFlag = (defaultValue: boolean) =>
  z.preprocess(
    (v) => {
      if (v === undefined) return defaultValue;
      if (typeof v === "boolean") return v;
      if (typeof v !== "string") return v;
      const normalized = v.trim().toLowerCase();
      if (normalized === "") return defaultValue;
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
      return v; // let z.boolean() reject it
    },
    z.boolean(),
  );

const optionalEnum = <T extends [string, ...string[]]>(values: T) =>
  z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.enum(values),
    )
    .optional();

const envSchema = z.object({
  // --- Runtime ---------------------------------------------------------
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().positive().default(5000),
  ),

  // --- Persistence (boot-critical) -------------------------------------
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(1),

  // --- Google OAuth (feature-scoped) -----------------------------------
  GOOGLE_CLIENT_ID: optionalString(),
  GOOGLE_CLIENT_SECRET: optionalString(),

  // --- AI providers (feature-scoped) -----------------------------------
  GEMINI_API_KEY: optionalString(),
  // server/services/gemini.ts returns a canned cost-analysis instead of
  // calling the real Gemini API. Lets browser tests exercise the draft →
  // confirm workflow without a key. Refused in production (see check below).
  E2E_FAKE_GEMINI: booleanFlag(false),
  AI_INTEGRATIONS_OPENAI_API_KEY: optionalString(),
  AI_INTEGRATIONS_OPENAI_BASE_URL: optionalUrl(),

  // --- DocRaptor (feature-scoped) --------------------------------------
  DOCRAPTOR_API_KEY: optionalString(),

  // --- ArchiDoc sync + webhooks (feature-scoped) -----------------------
  ARCHIDOC_BASE_URL: optionalUrl(),
  ARCHIDOC_SYNC_API_KEY: optionalString(),
  // Validation-only ArchiDoc staging connection. These never replace the
  // application's normal ArchiDoc connection; the explicit release validator
  // opts into them when both are configured.
  ARCHIDOC_STAGING_BASE_URL: optionalUrl(),
  ARCHIDOC_STAGING_SYNC_API_KEY: optionalString(),
  ARCHIDOC_WEBHOOK_SECRET: optionalString(),
  ARCHIDOC_POLLING_ENABLED: booleanFlag(false),
  // Supplier direct-payment canary gate. Unset/empty means no project may
  // preview, create, reissue or newly seal a supplier certificate. Add only
  // explicit stable ArchiDoc project IDs, comma-separated, to widen the
  // rollout. Tests preserve historical fixture behavior when the variable is
  // absent; production and development fail closed.
  SUPPLIER_DIRECT_PAYMENT_PROJECT_ALLOWLIST: optionalString(),

  // --- Gmail inbox scanning (per-user OAuth monitor) --------------------
  // Task #305: Gmail inbox scanning used to be (mis)gated behind
  // ARCHIDOC_POLLING_ENABLED — switching ArchiDoc to webhook mode silently
  // killed Gmail scanning in production for two months. Gmail scanning now
  // has its own flag, defaulting ON; the monitor itself still no-ops when
  // object storage is not configured.
  GMAIL_POLLING_ENABLED: booleanFlag(true),

  // Task #322 — global intake watermark. Emails received BEFORE this
  // instant are never captured by the Gmail monitor and never picked up by
  // the background email-document processor, even across restarts. Default
  // is Monday 2026-08-10 09:00 Europe/Paris (CEST, UTC+2): the beta reset
  // point after the 428-doc backlog was written off.
  EMAIL_INTAKE_MIN_RECEIVED_AT: z
    .string()
    .default("2026-08-10T07:00:00Z")
    .refine((v) => !Number.isNaN(Date.parse(v)), {
      message: "EMAIL_INTAKE_MIN_RECEIVED_AT must be an ISO date-time string",
    }),

  // --- Firm identity (Task #425) ----------------------------------------
  // Server-controlled identity of the architecture firm itself, used to
  // deterministically confirm that a caught invoice was ISSUED BY the firm
  // (facture d'honoraires) before typing it architect_fee_invoice. The AI
  // classification alone is never trusted for this. FIRM_SIRET is the
  // 14-digit SIRET (digits only, separators tolerated); FIRM_LEGAL_NAMES is
  // a CSV of accepted letterhead names. Defaults cover the deployed firm.
  FIRM_SIRET: optionalString(),
  FIRM_LEGAL_NAMES: z
    .string()
    .default("SAS ARCHITECTS-FRANCE,ARCHITECTS-FRANCE"),
  // CSV of mail domains the firm sends from. Mail from these domains always
  // passes the email prefilter so the firm's own fee invoices reach AI
  // classification. Default matches the workspace's Google OAuth domain.
  FIRM_EMAIL_DOMAINS: z.string().default("renosud.com"),

  // --- Archisign envelope orchestration + webhook (AT4) ----------------
  // ARCHISIGN_API_KEY is a CSV of one or more keys to support overlapping
  // rotation windows (§3.6); the FIRST entry is used for new outbound
  // calls. ARCHISIGN_WEBHOOK_SECRET is the shared HMAC v2 secret for the
  // inbound /api/webhooks/archisign channel — born v2-only (§2.4 P0).
  //
  // ARCHISIGN_PDF_TOKEN_SECRET is a dedicated HMAC secret used exclusively
  // for minting/verifying the short-lived PDF fetch tokens exposed at
  // /api/public/devis-pdf/:token (AT4). Keeping it separate from
  // ARCHISIGN_WEBHOOK_SECRET ensures that a webhook-secret compromise does
  // not automatically grant read access to stored translated contract PDFs.
  // When unset, the system falls back to ARCHISIGN_WEBHOOK_SECRET for
  // backward compatibility, but operators SHOULD provision a dedicated
  // value to achieve full separation of concerns.
  ARCHISIGN_BASE_URL: optionalUrl(),
  ARCHISIGN_API_KEY: optionalString(),
  ARCHISIGN_WEBHOOK_SECRET: optionalString(),
  ARCHISIGN_PDF_TOKEN_SECRET: optionalString(),

  // --- Architrak outbound webhook to Archidoc (AT5) --------------------
  // ARCHITRAK_WEBHOOK_SECRET is the shared HMAC v2 secret AT5 uses to
  // sign outbound deliveries to Archidoc's /work-authorisations endpoint
  // (single key per environment per G16). Hard-fail at send time if
  // unset — AT5 never falls through to unsigned traffic.
  // ARCHIDOC_WORK_AUTH_URL overrides the default
  //   `${ARCHIDOC_BASE_URL}/api/integrations/architrak/work-authorisations`
  // (covers test envs where the path differs).
  ARCHITRAK_WEBHOOK_SECRET: optionalString(),
  ARCHIDOC_WORK_AUTH_URL: optionalUrl(),

  // --- Object storage (feature-scoped) ---------------------------------
  DEFAULT_OBJECT_STORAGE_BUCKET_ID: optionalString(),
  PRIVATE_OBJECT_DIR: optionalString(),
  PUBLIC_OBJECT_SEARCH_PATHS: z.string().optional(),

  // --- Google Drive auto-upload (feature-scoped, Task #198) ------------
  // Pushes a copy of every devis/facture/certificat PDF into the
  // Renosud shared Drive at:
  //   {project folder} / FINANCIAL / LIVE PROJECT FINANCIAL /
  //   1 DEVIS & FACTURE FOLDERS / {Lot} {project} {devisCode}
  // Service-account model: the JSON below MUST be the credentials of a
  // service account that has been granted "Content manager" on the
  // shared drive identified by GOOGLE_DRIVE_SHARED_DRIVE_ID. The flag
  // is OFF by default — even if creds + drive id are present the
  // worker stays silent until DRIVE_AUTO_UPLOAD_ENABLED is truthy.
  // This lets us deploy schema + code changes ahead of operator
  // provisioning credentials, and gives a fast on/off kill switch.
  GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: optionalString(),
  GOOGLE_DRIVE_SHARED_DRIVE_ID: optionalString(),
  DRIVE_AUTO_UPLOAD_ENABLED: booleanFlag(false),

  // --- Overlap & supersession detection engine (Task #231) -------------
  // Per-project background reconciliation pass that detects dangerous
  // document relationships (e.g. a consolidated devis silently absorbing
  // earlier individual devis). It changes NO financial total and fires NO
  // user-facing alert. ON by default; flip to false as a kill switch if
  // embedding/reasoning cost or load needs to be paused. The AI layers
  // additionally require GEMINI_API_KEY — absent it, the engine degrades
  // to deterministic arithmetic-only detection.
  OVERLAP_DETECTION_ENABLED: booleanFlag(true),

  // --- Rate limit store selector ---------------------------------------
  RATE_LIMIT_STORE: optionalEnum(["memory", "postgres"]),

  // --- Public-facing portal base URL (contractor query portal) ---------
  // Used to build /p/check/:token links in outgoing emails. Falls back to
  // the request's own origin when unset.
  PUBLIC_BASE_URL: optionalString(),

  // --- Devis check portal token TTL (sliding window, in days) ----------
  // Tokens expire `expiresAt = lastUsedAt + N days` (or createdAt + N if
  // never used). A scheduled job revokes tokens past their expiry.
  //
  // Lifecycle policy: this TTL is the IDLE-CEILING safety net only. The
  // primary lifecycle trigger is "devis fully invoiced" — once
  // sum(invoice HT) >= adjusted devis HT, the token is auto-revoked
  // regardless of how much TTL remains (see
  // storage.revokeDevisCheckTokensForFullyInvoicedDevis). The sliding
  // window therefore only kicks in when a devis is genuinely abandoned
  // mid-flight. Default 90 days. Set to 0 to disable the idle ceiling
  // entirely (tokens then live until the devis closes out).
  DEVIS_CHECK_TOKEN_TTL_DAYS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(0).default(90),
  ),

  // --- E2E / browser-test backdoor (NEVER enable in production) --------
  // Gates the dev-only POST /api/auth/dev-login endpoint. Requires
  // NODE_ENV !== "production" AND this flag set to a truthy string.
  ENABLE_DEV_LOGIN_FOR_E2E: booleanFlag(false),

  // --- E2E fake Gmail client (NEVER enable in production) -------------
  // When set to a truthy string AND NODE_ENV !== "production",
  // server/gmail/client.ts returns an in-memory fake gmail client whose
  // users.messages.send always succeeds. Lets browser tests exercise the
  // bundled-send flow without hitting a real Gmail OAuth connection.
  E2E_FAKE_GMAIL: booleanFlag(false),

  // --- E2E ArchiDoc RIB mock (NEVER enable in production) -------------
  // Starts a tiny local HTTP server that serves a protected RIB PDF
  // endpoint with the exact headers expected by the supplier send flow.
  // Keeps browser release-gate runs self-contained without any external
  // ArchiDoc dependency.
  E2E_ARCHIDOC_MOCK_RIB: booleanFlag(false),

  // --- Pre-publish smoke boot (script/prepublish-check.ts) -------------
  // When true, server boot skips ALL background workers: schedulers,
  // sweepers, boot-time reconciliation and seeding. Used to safely
  // smoke-boot the production bundle locally without any side effects
  // (no emails, no external syncs, no boot writes). Never set in a real
  // deployment — the app would serve requests but do no background work.
  SMOKE_BOOT: booleanFlag(false),

  // --- Replit connector identity (Gmail OAuth bridge) ------------------
  REPLIT_CONNECTORS_HOSTNAME: optionalString(),
  REPL_IDENTITY: optionalString(),
  WEB_REPL_RENEWAL: optionalString(),

  // --- Outstanding architect-fee weekly digest -------------------------
  // Recipient list for the Monday-morning outstanding architect-fee
  // summary emailed to the accounting team. Comma-separated for multiple
  // addressees. Unset = the digest scheduler runs but logs a skip
  // notice instead of sending. The Gmail "From" is the connected
  // account.
  OUTSTANDING_FEES_DIGEST_RECIPIENTS: optionalString(),

  // Hour-of-day (server local time, 0-23) at which the Monday digest
  // fires. Defaults to 8 (08:00 local). The scheduler ticks hourly and
  // sends once when the local hour first reaches this value on a Monday.
  OUTSTANDING_FEES_DIGEST_HOUR: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(0).max(23).default(8),
  ),

  // --- Operator alerts (post-deploy maintenance scripts) ---------------
  // Recipient for operational alerts emitted by post-deploy maintenance
  // jobs (e.g. the page-hint backfill). Unset = alerts only land in the
  // deploy log, never in an inbox. Set to a comma-separated list of
  // addresses to opt in. The Gmail "From" is the connected account.
  OPERATOR_ALERT_EMAIL: optionalString(),

  // --- Deploy / replit identifiers (best-effort context for alerts) ----
  REPL_ID: optionalString(),
  REPL_SLUG: optionalString(),
  REPLIT_DEPLOYMENT_ID: optionalString(),

  // --- Pennylane accounting integration (Task #214, feature-scoped) ----
  // One-click push of architect-honoraires customer_invoices to the
  // firm's Pennylane books. Strict architect-side-only scope —
  // contractor / supplier data is NEVER pushed (the architect is not
  // the contractor's customer). See ARCHITECTURE.md §4.7 for the full
  // contract and safety-rail rationale.
  //
  // PENNYLANE_API_KEY: bearer token. Sandbox tenant for development,
  //   prod tenant for production. Refuses to push when unset.
  // PENNYLANE_BASE_URL: defaults to the v2 external API base. Override
  //   only when sandbox / staging hosts diverge.
  // PENNYLANE_PUSH_ENABLED: master kill switch. Default OFF — every
  //   wire-in (enqueue, sweeper, paid-status poller, "Invoice fees now"
  //   button) is a silent no-op until this flips true.
  // PENNYLANE_DRY_RUN: when true AND push is enabled, the worker logs
  //   the resolved external_id + payload it would have sent but does
  //   NOT hit the API. Lets the operator verify mapping on real prod
  //   data with zero side effects.
  // PENNYLANE_PROJECT_WHITELIST: comma-separated project ids. When
  //   set, ONLY those projects' honoraires push (others silently
  //   no-op at enqueue time). Empty / unset = no projects push when
  //   the env var is intentionally set to ""; absent env var = all
  //   projects push. Used to ring-fence a single dummy project
  //   during sandbox cutover (phase 10e of the rollout plan).
  PENNYLANE_API_KEY: optionalString(),
  PENNYLANE_BASE_URL: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().url(),
    )
    .default("https://app.pennylane.com/api/external/v2"),
  PENNYLANE_PUSH_ENABLED: booleanFlag(false),
  PENNYLANE_DRY_RUN: booleanFlag(false),
  PENNYLANE_PROJECT_WHITELIST: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Log key NAMES only — never values. Each issue path is the env var name.
  const invalidKeys = Array.from(
    new Set(
      parsed.error.issues
        .map((issue) => (issue.path[0] ?? "").toString())
        .filter((k) => k.length > 0),
    ),
  );
  // Emit one line per offending key with its validation code so operators
  // can act, but never the actual value.
  console.error(
    "[env] Invalid or missing environment variables — refusing to start.",
  );
  for (const issue of parsed.error.issues) {
    const key = (issue.path[0] ?? "").toString() || "<unknown>";
    console.error(`[env]   ${key}: ${issue.message} (${issue.code})`);
  }
  console.error(`[env] Offending keys: ${invalidKeys.join(", ")}`);
  process.exit(1);
}

/**
 * Refuse to boot if the dev-only E2E login backdoor is enabled in
 * production. The route itself is already gated, but a misconfigured
 * deployment would silently keep the flag set without anyone noticing.
 * Failing loud at boot makes the mistake impossible to miss.
 *
 * Exported for tests; called immediately below for the real boot path.
 */
export function assertNoDevLoginBackdoorInProduction(
  cfg: Pick<Env, "NODE_ENV" | "ENABLE_DEV_LOGIN_FOR_E2E" | "E2E_FAKE_GMAIL" | "E2E_FAKE_GEMINI">,
  exit: (code: number) => never = process.exit as (code: number) => never,
  log: (msg: string) => void = (m) => console.error(m),
): void {
  if (cfg.NODE_ENV === "production" && cfg.ENABLE_DEV_LOGIN_FOR_E2E) {
    log(
      "[env] Refusing to start: ENABLE_DEV_LOGIN_FOR_E2E must NOT be set when NODE_ENV=production. " +
        "Unset ENABLE_DEV_LOGIN_FOR_E2E (or set it to false) before redeploying.",
    );
    exit(1);
  }
  if (cfg.NODE_ENV === "production" && cfg.E2E_FAKE_GMAIL) {
    log(
      "[env] Refusing to start: E2E_FAKE_GMAIL must NOT be set when NODE_ENV=production. " +
        "Unset E2E_FAKE_GMAIL (or set it to false) before redeploying.",
    );
    exit(1);
  }
  if (cfg.NODE_ENV === "production" && cfg.E2E_FAKE_GEMINI) {
    log(
      "[env] Refusing to start: E2E_FAKE_GEMINI must NOT be set when NODE_ENV=production. " +
        "Unset E2E_FAKE_GEMINI (or set it to false) before redeploying.",
    );
    exit(1);
  }
}

assertNoDevLoginBackdoorInProduction(parsed.data);

/**
 * Boot-time WARN (Task #126): if we're in production and the
 * operator-alert recipient list is unset, every alert from the
 * post-deploy maintenance scripts (page-hint backfill, contractor
 * backfill, post-deploy smoke gate, /healthz watchdog, ...) will
 * land in stderr only — invisible to anyone not tailing logs. The
 * 2026-04-23 incident took ~30 extra minutes to surface for exactly
 * this reason. This WARN is informational (not fatal) because the
 * variable is genuinely optional for non-production environments.
 *
 * Exported for tests; called immediately below for the real boot path.
 */
export function warnIfOperatorAlertEmailMissingInProduction(
  cfg: Pick<Env, "NODE_ENV" | "OPERATOR_ALERT_EMAIL">,
  log: (msg: string) => void = (m) => console.warn(m),
): void {
  if (cfg.NODE_ENV === "production" && !cfg.OPERATOR_ALERT_EMAIL) {
    log(
      "[env] WARN — OPERATOR_ALERT_EMAIL not configured; operator alerts will only appear in stderr. " +
        "Set this env var (comma-separated for multiple addressees) so post-deploy alerts reach an inbox.",
    );
  }
}

warnIfOperatorAlertEmailMissingInProduction(parsed.data);

/**
 * Boot-time WARN (Task #165): if NODE_ENV=production but
 * ARCHIDOC_BASE_URL points at a host that is clearly a dev or staging
 * backend (replit.dev preview hosts, localhost, *.staging.*, etc.),
 * the deployed app will silently mirror the wrong project list. Task
 * #164 surfaced the source host on the API + dialog, but a banner-less
 * misconfig sat in prod for ~a week before anyone opened the dialog.
 * Logging a WARN at boot makes the mistake impossible to miss in the
 * deploy console; the runtime banner (Projects page) covers the case
 * where nobody is tailing logs.
 *
 * Returns the offending host (string) when misconfigured, otherwise
 * null. Pure function — exported so the API surface and tests can
 * reuse the exact same predicate.
 */
export function detectMisconfiguredArchidocBaseUrl(
  cfg: Pick<Env, "NODE_ENV" | "ARCHIDOC_BASE_URL">,
): string | null {
  if (cfg.NODE_ENV !== "production") return null;
  if (!cfg.ARCHIDOC_BASE_URL) return null;
  let host: string;
  try {
    host = new URL(cfg.ARCHIDOC_BASE_URL).host.toLowerCase();
  } catch {
    return null;
  }
  // Dev/staging signals. `replit.dev` covers Replit preview hostnames
  // (the actual root cause of the 2026-04 incident). The other entries
  // are belt-and-braces for common non-prod patterns.
  const devSignals = [
    "replit.dev",
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    ".local",
    "staging.",
    ".staging.",
    "-staging.",
  ];
  for (const signal of devSignals) {
    if (host.includes(signal)) return host;
  }
  return null;
}

export function warnIfArchidocBaseUrlMisconfigured(
  cfg: Pick<Env, "NODE_ENV" | "ARCHIDOC_BASE_URL">,
  log: (msg: string) => void = (m) => console.warn(m),
): void {
  const offendingHost = detectMisconfiguredArchidocBaseUrl(cfg);
  if (offendingHost) {
    log(
      `[env] WARN — NODE_ENV=production but ARCHIDOC_BASE_URL host "${offendingHost}" looks like a dev/staging backend. ` +
        "The deployed app will mirror the WRONG Archidoc project list. " +
        "Update ARCHIDOC_BASE_URL to the production Archidoc host before serving traffic.",
    );
  }
}

warnIfArchidocBaseUrlMisconfigured(parsed.data);

/**
 * Boot-time WARN: if ARCHISIGN_WEBHOOK_SECRET is configured (meaning
 * Archisign is active) but ARCHISIGN_PDF_TOKEN_SECRET is absent, the
 * PDF fetch token endpoint cannot be used and the send-to-signer flow
 * will fail at mint time. More importantly, leaving these two secrets
 * unified means a webhook-secret leak would also expose the PDF
 * download surface. Operators MUST provision a dedicated
 * ARCHISIGN_PDF_TOKEN_SECRET — distinct from ARCHISIGN_WEBHOOK_SECRET —
 * before using the Archisign send-to-signer feature.
 *
 * Exported for tests; called immediately below for the real boot path.
 */
export function warnIfArchisignPdfTokenSecretMissing(
  cfg: Pick<Env, "ARCHISIGN_WEBHOOK_SECRET" | "ARCHISIGN_PDF_TOKEN_SECRET">,
  log: (msg: string) => void = (m) => console.warn(m),
): void {
  if (cfg.ARCHISIGN_WEBHOOK_SECRET && !cfg.ARCHISIGN_PDF_TOKEN_SECRET) {
    log(
      "[env] WARN — ARCHISIGN_WEBHOOK_SECRET is set but ARCHISIGN_PDF_TOKEN_SECRET is not. " +
        "The Archisign send-to-signer flow requires a dedicated ARCHISIGN_PDF_TOKEN_SECRET " +
        "to mint PDF fetch tokens. Set this to a distinct secret value (never the same as " +
        "ARCHISIGN_WEBHOOK_SECRET) to enable the PDF download endpoint and eliminate " +
        "cross-scope secret reuse.",
    );
  }
}

warnIfArchisignPdfTokenSecretMissing(parsed.data);

export const env: Readonly<Env> = Object.freeze(parsed.data);
