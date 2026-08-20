import { sql } from "drizzle-orm";
import { CLIENT_NO_PAYMENT_NOTICE } from "./signature-message-template";
import {
  pgTable,
  text,
  varchar,
  serial,
  integer,
  numeric,
  boolean,
  date,
  timestamp,
  jsonb,
  unique,
  uniqueIndex,
  index,
  check,
  doublePrecision,
  bigint,
  vector,
  foreignKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// -----------------------------------------------------------------------------
// Devis sign-off contract — shared enums and embedded-jsonb shapes (AT1)
// Sourced from `docs/INTER_APP_CONTRACT_v1.0.md` (frozen 2026-04-25).
// Tables that consume these constants are defined further down in this file.
// -----------------------------------------------------------------------------

/**
 * Canonical 9-value `signOffStage` enum per contract §1.1. The DB column is a
 * plain `text` (no DB-level CHECK by convention with the rest of this schema);
 * application-level transition guards live in `server/routes/devis.ts`
 * (`STAGE_ORDER`) and AT2/AT4 extend that table to cover the new stages.
 *
 *   - `received`, `checked_internal`, `approved_for_signing`,
 *     `sent_to_client`, `client_signed_off`, `void` — pre-existing
 *   - `client_review_in_progress`, `client_agreed`, `client_rejected` — new
 *
 * Terminal stages: `client_rejected`, `void`, `client_signed_off` (the latter
 * is logically terminal but still receives `envelope.retention_breach` events
 * without changing stage; see §1.2).
 */
export const SIGN_OFF_STAGES = [
  "received",
  "checked_internal",
  "client_review_in_progress",
  "client_agreed",
  "client_rejected",
  "approved_for_signing",
  "sent_to_client",
  "client_signed_off",
  "void",
] as const;
export type SignOffStage = (typeof SIGN_OFF_STAGES)[number];

export const DEVIS_CLOSURE_STATES = ["open", "closed"] as const;
export type DevisClosureState = (typeof DEVIS_CLOSURE_STATES)[number];

/**
 * Task #257 — mandatory client-context message bounds for the devis
 * send-to-signer flow. The architect MUST write a contextual message to
 * the client before the envelope goes out (Archisign silently drops the
 * `body` field of `/envelopes/create`, so ArchiTrak delivers the context
 * itself via the architect's Gmail). Shared between the SigningPanel
 * compose step and the server-side validation in
 * `server/routes/archisign-envelopes.ts` so the two can never drift.
 */
export const DEVIS_CLIENT_MESSAGE_MIN_LEN = 20;
// Task #442 — the Archisign contract caps `body` at 2000 code points, and
// the server appends the fixed payment notice ("\n\n" + notice) AFTER the
// architect's message. Reserve that space here so a maximal message can
// never push the combined envelope body past the upstream limit. Shared
// with the SigningPanel character counter, which shrinks in lockstep.
export const ARCHISIGN_BODY_MAX_LEN = 2000;
export const DEVIS_CLIENT_MESSAGE_MAX_LEN =
  ARCHISIGN_BODY_MAX_LEN - (CLIENT_NO_PAYMENT_NOTICE.length + 2);

/**
 * `identityVerification` 8-field block embedded in `envelope.signed`
 * payloads (contract §3.4). Persisted verbatim into a single jsonb column on
 * `devis.identity_verification` and re-emitted verbatim onto the outbound
 * work-authorisation webhook to Archidoc (§5.3.1). Must NOT be flattened.
 */
export const identityVerificationSchema = z.object({
  method: z.literal("otp_email"),
  otpIssuedAt: z.string(),
  otpVerifiedAt: z.string(),
  signerIpAddress: z.string(),
  signerUserAgent: z.string(),
  lastViewedAt: z.string(),
  signedAt: z.string(),
  authenticationId: z.string(),
});
export type IdentityVerification = z.infer<typeof identityVerificationSchema>;

/**
 * Client-check origin sources (§2.1.1). `architrak_internal` covers checks
 * raised by the architect from the admin UI; `archisign_query` covers checks
 * mirrored from `envelope.queried` webhook events.
 */
export const CLIENT_CHECK_ORIGIN_SOURCES = [
  "architrak_internal",
  "archisign_query",
] as const;
export type ClientCheckOriginSource = (typeof CLIENT_CHECK_ORIGIN_SOURCES)[number];

/** Client-check status enum (§2.1.1). */
export const CLIENT_CHECK_STATUSES = ["open", "resolved", "cancelled"] as const;
export type ClientCheckStatus = (typeof CLIENT_CHECK_STATUSES)[number];

/**
 * `query_resolved` resolver source (§3.3 + §2.1.1). Captures whether the
 * resolution came from Architrak's UI, the Archisign admin UI, or some
 * external channel (eg phone call) recorded by an architect.
 */
export const CLIENT_CHECK_RESOLVER_SOURCES = [
  "architrak_internal",
  "archisign_admin_ui",
  "external",
] as const;
export type ClientCheckResolverSource = (typeof CLIENT_CHECK_RESOLVER_SOURCES)[number];

/** `query_resolved` resolver actor (§3.3 + §2.1.1). */
export const CLIENT_CHECK_RESOLVER_ACTORS = ["architect", "system"] as const;
export type ClientCheckResolverActor = (typeof CLIENT_CHECK_RESOLVER_ACTORS)[number];

/**
 * Outbound webhook-delivery state (`webhook_deliveries_out`, §2.1.6).
 * `pending` covers both not-yet-attempted and in-retry rows; `succeeded`
 * is terminal-success; `dead_lettered` is terminal-failure surfaced in the
 * admin retry UI per §1.4.
 */
export const WEBHOOK_DELIVERY_STATES = [
  "pending",
  "succeeded",
  "dead_lettered",
] as const;
export type WebhookDeliveryState = (typeof WEBHOOK_DELIVERY_STATES)[number];

/**
 * Outbound work-authorisation webhook eventType discriminator (§5.3 / §0.5).
 * AT5 always emits the explicit field per Architrak commitment G8.
 */
export const WORK_AUTHORISATION_EVENT_TYPES = [
  "work_authorised",
  "signed_pdf_retention_breach",
] as const;
export type WorkAuthorisationEventType = (typeof WORK_AUTHORISATION_EVENT_TYPES)[number];

/**
 * Inbound webhook source for `webhook_events_in` dedup (AT1 step 2 decision).
 * Today only Archisign emits to Architrak; the column is shaped to support
 * additional inbound sources in future without a migration.
 */
export const INBOUND_WEBHOOK_SOURCES = ["archisign"] as const;
export type InboundWebhookSource = (typeof INBOUND_WEBHOOK_SOURCES)[number];

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  clientName: text("client_name").notNull(),
  clientAddress: text("client_address"),
  siteAddress: text("site_address"),
  status: text("status").notNull().default("active"),
  feePercentage: numeric("fee_percentage", { precision: 5, scale: 2 }),
  feeType: text("fee_type").notNull().default("percentage"),
  conceptionFee: numeric("conception_fee", { precision: 12, scale: 2 }),
  planningFee: numeric("planning_fee", { precision: 12, scale: 2 }),
  // Task #243 — Compte Prorata levy rate (% of gross certified works) charged
  // on each contractor's certificat and redirected to the prorata-account
  // manager. 0.00 = no prorata on this project. A marché flagged
  // is_prorata_manager collects the levy and is itself exempt from paying it.
  prorataPercentage: numeric("prorata_percentage", { precision: 5, scale: 2 }).notNull().default("0.00"),
  hasMarche: boolean("has_marche").notNull().default(false),
  archidocId: varchar("archidoc_id", { length: 255 }),
  archidocClients: jsonb("archidoc_clients"),
  lastSyncedAt: timestamp("last_synced_at"),
  archivedAt: timestamp("archived_at"),
  // Devis sign-off contract additions (AT1, contract §2.1.8).
  // Single client contact for the sign-off workflow. Source of truth is
  // Archidoc when a client contact is present (mirrored via the
  // `/api/integrations/archidoc/projects` sync poll, §5.5); local edit
  // is the fallback for projects whose Archidoc record carries no contact.
  clientContactName: text("client_contact_name"),
  clientContactEmail: text("client_contact_email"),
  // Task #198 — cached Google Drive folder id for the project's
  // "1 DEVIS & FACTURE FOLDERS" subfolder under the Renosud shared
  // drive. Resolved lazily on first upload; null = not yet resolved.
  driveFolderId: text("drive_folder_id"),
  // Task #214 — cached Pennylane customer id for the project's client.
  // Populated by the push-queue worker on first successful `customer`
  // push (idempotent via external_id="architrak:client:project:{id}").
  // Null until the first honoraires invoice for the project is pushed.
  pennylaneCustomerId: text("pennylane_customer_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("projects_archidoc_id_unique").on(table.archidocId),
]);

export const contractors = pgTable("contractors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  siret: text("siret"),
  address: text("address"),
  email: text("email"),
  phone: text("phone"),
  notes: text("notes"),
  archidocId: varchar("archidoc_id", { length: 255 }),
  contactName: text("contact_name"),
  contactJobTitle: text("contact_job_title"),
  contactMobile: text("contact_mobile"),
  town: text("town"),
  postcode: text("postcode"),
  website: text("website"),
  insuranceStatus: text("insurance_status"),
  decennaleInsurer: text("decennale_insurer"),
  decennalePolicyNumber: text("decennale_policy_number"),
  decennaleEndDate: date("decennale_end_date"),
  rcProInsurer: text("rc_pro_insurer"),
  rcProPolicyNumber: text("rc_pro_policy_number"),
  rcProEndDate: date("rc_pro_end_date"),
  specialConditions: text("special_conditions"),
  // Banking details (Task #225). Sourced from ArchiDoc; written here by
  // `buildSyncedFields` in contractor-auto-sync. IBAN/BIC are revalidated
  // before persist by `server/services/banking-validation.ts`.
  accountHolderName: varchar("account_holder_name", { length: 255 }),
  iban: varchar("iban", { length: 34 }),
  bic: varchar("bic", { length: 11 }),
  bankName: varchar("bank_name", { length: 255 }),
  ribDocumentUrl: text("rib_document_url"),
  ribDocumentName: varchar("rib_document_name", { length: 255 }),
  bankingVerifiedAt: timestamp("banking_verified_at"),
  bankingVerifiedBy: text("banking_verified_by"),
  bankingAiExtractedData: jsonb("banking_ai_extracted_data"),
  archidocPartnerType: varchar("archidoc_partner_type", { length: 32 }),
  archidocOrphanedAt: timestamp("archidoc_orphaned_at"),
  // Task #463 — contractor-level default TVA regime, used when the marché
  // carries no contract-specific rate. NULL rate = standard 20%. NOT part
  // of the ArchiDoc sync payload (locally-managed fiscal configuration).
  defaultTvaRatePercent: numeric("default_tva_rate_percent", { precision: 5, scale: 2 }),
  defaultTvaAutoliquidation: boolean("default_tva_autoliquidation").notNull().default(false),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("contractors_archidoc_id_unique").on(table.archidocId),
  check("contractors_siret_format", sql`${table.siret} IS NULL OR ${table.siret} ~ '^[0-9]{14}$'`),
  check("contractors_archidoc_partner_type_chk", sql`${table.archidocPartnerType} IS NULL OR ${table.archidocPartnerType} IN ('contractor', 'supplier')`),
]);

export const lotCatalog = pgTable("lot_catalog", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  descriptionFr: text("description_fr").notNull(),
  descriptionUk: text("description_uk"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("lot_catalog_code_unique").on(table.code),
]);

export const lots = pgTable("lots", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  lotNumber: text("lot_number").notNull(),
  descriptionFr: text("description_fr").notNull(),
  descriptionUk: text("description_uk"),
  // Task #198 — single per-lot Drive folder that holds ALL financial
  // docs for this lot (devis incl. avenants/PV-MV, factures, certificats,
  // future credit notes). Resolved + cached on first upload.
  driveFolderId: text("drive_folder_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("lots_project_id_idx").on(table.projectId),
  unique("lots_project_lot_unique").on(table.projectId, table.lotNumber),
]);

export const marches = pgTable("marches", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  contractorId: integer("contractor_id").notNull().references(() => contractors.id),
  marcheNumber: text("marche_number"),
  priceType: text("price_type").notNull().default("forfaitaire"),
  totalHt: numeric("total_ht", { precision: 12, scale: 2 }).notNull(),
  totalTtc: numeric("total_ttc", { precision: 12, scale: 2 }).notNull(),
  retenueGarantiePercent: numeric("retenue_garantie_percent", { precision: 5, scale: 2 }).default("5.00"),
  // Task #243 — when true, this contractor furnished a bank guarantee
  // (garantie à première demande) in lieu of the cash Retenue de Garantie,
  // so the holdback is bypassed (computed as 0) on their certificats.
  hasBankGuarantee: boolean("has_bank_guarantee").notNull().default(false),
  // Task #243 — when true, this marché is the project's Compte Prorata
  // manager: it COLLECTS the prorata levy and is itself exempt from paying it.
  isProrataManager: boolean("is_prorata_manager").notNull().default(false),
  // Task #462 — how the deposit (acompte) paid on this contractor's devis is
  // recovered on certificats: 'asap' (default), 'percent' (each certificat
  // recoups percent% of the deposit) or 'progress_threshold' (full recoupment
  // once gross progress ≥ threshold% of the contract total).
  acompteRecoupmentRule: text("acompte_recoupment_rule").notNull().default("asap"),
  acompteRecoupmentPercent: numeric("acompte_recoupment_percent", { precision: 5, scale: 2 }),
  acompteRecoupmentThresholdPercent: numeric("acompte_recoupment_threshold_percent", { precision: 5, scale: 2 }),
  // Task #464 — réception des travaux. The GPA (garantie de parfait
  // achèvement, art. 1792-6 Code civil) runs for ONE YEAR from this date;
  // its end date is derived (réception + 1 an), never stored. Once the GPA
  // has expired the retenue de garantie of a still-withholding contract is
  // due for release (surfaced in the UI, released explicitly on the solde
  // certificat — never automatically).
  receptionDate: date("reception_date"),
  // Task #566 — PV de réception (procès-verbal). Formalises the réception
  // des travaux with a draft → approved lifecycle: a draft carries either an
  // uploaded PV document OR a manual attestation note, plus the reception
  // date (written into `receptionDate` so GPA/RG timing reads ONE source).
  // Approval is server-set only (dedicated endpoint stamps approver + time
  // in the same row update, atomically with the date). The final-payment
  // gate (solde certificat / retenue release / seal / send) requires
  // status 'approved' with a reception date — see
  // server/services/pv-reception.service.ts. NULL status = no PV yet.
  pvReceptionStatus: text("pv_reception_status"),
  pvDocumentStorageKey: text("pv_document_storage_key"),
  pvDocumentFileName: text("pv_document_file_name"),
  pvAttestationNote: text("pv_attestation_note"),
  pvApprovedByUserId: integer("pv_approved_by_user_id").references(() => users.id),
  pvApprovedAt: timestamp("pv_approved_at"),
  // Task #463 — TVA regime for this contract's certificats de paiement.
  // `tvaRatePercent` NULL means "no contract-specific rate": fall back to
  // the contractor's default, then to the standard 20%. When
  // `tvaAutoliquidation` is true (sous-traitance BTP, art. 283 CGI), the
  // certificat applies 0% TVA and prints the mandatory legal mention —
  // TVA is due by the client/main contractor, not by us.
  tvaRatePercent: numeric("tva_rate_percent", { precision: 5, scale: 2 }),
  tvaAutoliquidation: boolean("tva_autoliquidation").notNull().default(false),
  paymentSchedule: jsonb("payment_schedule"),
  signedDate: date("signed_date"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("marches_project_id_idx").on(table.projectId),
  index("marches_contractor_id_idx").on(table.contractorId),
]);

export const devis = pgTable("devis", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  contractorId: integer("contractor_id").notNull().references(() => contractors.id),
  lotId: integer("lot_id").references(() => lots.id, { onDelete: "set null" }),
  marcheId: integer("marche_id").references(() => marches.id, { onDelete: "set null" }),
  devisCode: text("devis_code").notNull(),
  devisNumber: text("devis_number"),
  ref2: text("ref2"),
  descriptionFr: text("description_fr").notNull(),
  descriptionUk: text("description_uk"),
  amountHt: numeric("amount_ht", { precision: 12, scale: 2 }).notNull(),
  amountTtc: numeric("amount_ttc", { precision: 12, scale: 2 }).notNull(),
  // Per-devis architect-commission override (Task — see ARCHITECTURE.md).
  // NULL = inherit `projects.fee_percentage`; 0.00 = explicitly zero
  // (e.g. professional-services devis that don't carry a commission);
  // any other value = use this rate for invoices approved against this
  // devis instead of the project's blanket rate. Resolution lives in
  // server/services/{invoice-approval,outstanding-fees}.service.ts.
  feePercentageOverride: numeric("fee_percentage_override", { precision: 5, scale: 2 }),
  invoicingMode: text("invoicing_mode").notNull().default("mode_a"),
  status: text("status").notNull().default("pending"),
  // Task #232 — accounting state guard. Controls whether this devis counts
  // toward the project's Contracted / Certified / Reste-à-Réaliser buckets.
  //   provisional — freshly ingested (PDF upload / intake); NOT yet counted.
  //                 Cleared to `active` by the first reconciliation pass that
  //                 finds no unresolved overlap touching it.
  //   active       — genuinely contracted; counts toward the buckets. Existing
  //                 rows backfill to `active` (DB default) so behaviour is
  //                 unchanged for everything that predates this column.
  //   superseded   — folded into another devis (arithmetic proof, or a
  //                 recorded human decision); removed from the buckets.
  // See ACCOUNTING_STATES + accountingStateChanges (append-only audit). A
  // devis NEVER leaves Contracted silently — only via proof or human decision.
  accountingState: text("accounting_state").notNull().default("active"),
  // sign_off_stage: see SIGN_OFF_STAGES tuple below for the canonical
  // 9-value v1.0-contract enum (`docs/INTER_APP_CONTRACT_v1.0.md` §1.1).
  // No DB-level CHECK constraint by convention with the rest of this
  // schema — application-level transition guards live in
  // server/routes/devis.ts (STAGE_ORDER) and AT2/AT4 extend that table.
  signOffStage: text("sign_off_stage").notNull().default("received"),
  voidReason: text("void_reason"),
  dateSent: date("date_sent"),
  dateSigned: date("date_signed"),
  pvmvRef: text("pvmv_ref"),
  // Task #198 — cached Drive file id + viewer link for the devis PDF
  // copy in `{lot}/{project}/{devisCode}` subfolder. Populated by the
  // drive-upload worker after a successful push; null while pending.
  driveFileId: text("drive_file_id"),
  driveWebViewLink: text("drive_web_view_link"),
  driveUploadedAt: timestamp("drive_uploaded_at"),
  pdfStorageKey: text("pdf_storage_key"),
  pdfFileName: text("pdf_file_name"),
  validationWarnings: jsonb("validation_warnings"),
  aiExtractedData: jsonb("ai_extracted_data"),
  aiConfidence: integer("ai_confidence"),
  // Devis sign-off contract additions (AT1, contract §2.1.7).
  // archidocDqeExportId — read from Gmail header `x-archidoc-dqe-export-id`
  // (case-insensitive form per RFC 7230 §3.2 / contract §0.2). Echoed onto
  // the work-authorisation webhook to Archidoc as `dqeExportId` (§5.3.1).
  archidocDqeExportId: text("archidoc_dqe_export_id"),
  // archisignEnvelopeId — opaque integer-as-string returned by Archisign
  // `/create`; persisted on transition to `sent_to_client` (§1.2).
  archisignEnvelopeId: text("archisign_envelope_id"),
  // identityVerification — verbatim 8-field block from `envelope.signed`
  // payload (§3.4); persisted as a SINGLE jsonb object (not an array)
  // and never flattened. AT5 echoes this verbatim onto the outbound
  // work-authorisation webhook (§5.3.1). Stored as generic jsonb to
  // match the existing schema convention for `validation_warnings` /
  // `ai_extracted_data`; consumers parse with `identityVerificationSchema`.
  identityVerification: jsonb("identity_verification"),
  // signedPdfFetchUrlSnapshot — convenience snapshot of the URL delivered
  // with `envelope.signed`. The URL TTL is 15 minutes; once expired,
  // receivers must re-mint via `GET /api/v1/envelopes/:id/signed-pdf-url`
  // (§3.5.3). The snapshot is therefore advisory only.
  signedPdfFetchUrlSnapshot: text("signed_pdf_fetch_url_snapshot"),
  // Task #206 — object-storage key of the locally-persisted signed PDF
  // downloaded from Archisign on the `envelope.signed` webhook. Closes
  // the audit loop so the signed artefact survives the Archisign 90-day
  // retention window. Populated one-shot post-stage-transition; never
  // rolled back. The same PDF is also mirrored into the per-lot Drive
  // folder via the AT5-style drive_uploads queue (docKind=devis_signed).
  signedPdfStorageKey: text("signed_pdf_storage_key"),
  // Task #206 (retry) — durable async retry state for the signed-PDF
  // persistence job. The webhook handler always tries first (detached
  // setImmediate), but if that attempt fails the sweeper picks the
  // row back up using these columns: increments attempts, schedules
  // the next attempt with exponential backoff, and gives up after
  // MAX_SIGNED_PDF_RETRY_ATTEMPTS. Reset to (0, NULL, NULL) on
  // successful persistence.
  signedPdfRetryAttempts: integer("signed_pdf_retry_attempts").notNull().default(0),
  signedPdfNextAttemptAt: timestamp("signed_pdf_next_attempt_at"),
  signedPdfLastError: text("signed_pdf_last_error"),
  // AT4 envelope-tracking columns (contract §3.5.1 / §1.2). All nullable;
  // populated on transition to `sent_to_client` and updated by the inbound
  // 7-event receiver. accessUrl is the ONLY persisted URL — it comes from
  // /create's response and is never re-read from /send (§3.5.4 / G3).
  // archisignAccessUrlInvalidatedAt is set on `envelope.expired` to
  // soft-invalidate the stored URL while preserving it for audit (§1.2).
  archisignAccessUrl: text("archisign_access_url"),
  archisignAccessUrlInvalidatedAt: timestamp("archisign_access_url_invalidated_at", { withTimezone: true }),
  // archisignEnvelopeStatus — last-seen state from inbound webhooks.
  // Receiver whitelists: sent | viewed | queried | signed | declined | expired.
  // Distinct from devis.signOffStage (which reflects Architrak workflow);
  // both are updated atomically in webhook handlers.
  archisignEnvelopeStatus: text("archisign_envelope_status"),
  archisignEnvelopeExpiresAt: timestamp("archisign_envelope_expires_at", { withTimezone: true }),
  // archisignOtpDestination — masked phone/email shown in /create response
  // (§3.5.1). Persisted for UI display only; not used for auth.
  archisignOtpDestination: text("archisign_otp_destination"),
  // archisignPinnedPdfStorageKey — the exact PDF object Archisign fetches
  // for this devis' envelope. Written at send time (before the fetch token
  // is minted) so post-send translation/context/analysis edits can never
  // change the bytes the signer receives. Cleared implicitly on re-send
  // (overwritten with the freshly generated key).
  archisignPinnedPdfStorageKey: text("archisign_pinned_pdf_storage_key"),
  // archisignSignerMessage — the architect's optional personalised note,
  // captured in the "Envoyer à la signature" dialog and forwarded to
  // Archisign /create as the envelope `body`. Persisted here so the note
  // is never lost: Archisign does not echo it back, and (depending on their
  // email template) may not surface it to the signer. Written one-shot on
  // first send only — the resume branch skips /create, so it is never
  // overwritten on retry. NULL when the architect left the field empty.
  archisignSignerMessage: text("archisign_signer_message"),
  // archisignSubjectDriftAt — Task #279. Set when Archisign's /create
  // response carried the (proposed v1.2 §3.5.1.1) `emailRendering` echo
  // with `subjectApplied: false` for a subject we sent: the signer
  // invitation went out under Archisign's DEFAULT subject, not ours.
  // Non-blocking by design (the envelope proceeds); this timestamp is the
  // persisted operator-visible signal, surfaced on the SigningPanel and
  // the /admin/ops/archisign-rendering-drift page. Reset to NULL on each
  // fresh /create whose echo does NOT report drift (or is absent —
  // pre-v1.2 servers), so the flag always describes the CURRENT envelope.
  archisignSubjectDriftAt: timestamp("archisign_subject_drift_at", { withTimezone: true }),
  // archisignBodyDriftAt — Task #283. Set when Archisign's /create response
  // carried the §3.5.1.1(c) `emailRendering` echo with `bodyApplied: false`
  // for a non-empty body we sent. Since the v1.2 amendment entered force
  // (2026-07-13; Archisign elected RENDERED and countersigned 2026-07-12),
  // this means the architect's personal note silently vanished from the
  // signer-invitation email — a contract breach. Non-blocking by design
  // (the envelope proceeds; our own context email still delivers the note);
  // this timestamp is the persisted operator-visible signal, surfaced on
  // the SigningPanel and the /admin/ops/archisign-rendering-drift page.
  // Reset to NULL on each fresh /create whose echo does NOT report body
  // drift (or is absent — pre-v1.2 servers), so the flag always describes
  // the CURRENT envelope.
  archisignBodyDriftAt: timestamp("archisign_body_drift_at", { withTimezone: true }),
  // Manual sign-off provenance (secondary signing pathway). The primary
  // path stays the Archisign webhook; this records a devis authenticated
  // by an operator uploading the signed copy directly (paper signature,
  // envelope signed inside Archisign but OUTSIDE the ArchiDoc↔Archisign
  // integration, another e-sign provider, …).
  //   signedOffVia        — "archisign" | "manual_upload"; NULL for rows
  //                         signed before this column existed (treat as
  //                         archisign when stage is client_signed_off).
  //   manualSignoffAt/By  — when + which operator recorded it.
  //   manualSignoffNote   — REQUIRED operator justification (audit).
  //   manualSignoffExternalRef — optional reference correlating the copy
  //                         to an external signing event (e.g. an Archisign
  //                         envelope id created outside the integration).
  // All are server-written only; the generic PATCH strips them.
  signedOffVia: text("signed_off_via"),
  manualSignoffAt: timestamp("manual_signoff_at", { withTimezone: true }),
  manualSignoffBy: text("manual_signoff_by"),
  manualSignoffNote: text("manual_signoff_note"),
  manualSignoffExternalRef: text("manual_signoff_external_ref"),
  // Task #649 — works-completion closure is deliberately separate from
  // client signature. A devis may only move open → closed through the
  // dedicated PV-gated endpoint, which stamps both audit fields atomically.
  // These columns are server-owned and omitted from insertDevisSchema.
  closureState: text("closure_state").notNull().default("open"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedByUserId: integer("closed_by_user_id").references(() => users.id),
  // Immutable snapshot of the exact marché/PV relationship validated at
  // closure time. The live devis or marché may be corrected later, but the
  // legal closure record must retain what was approved at that transition.
  closureMarcheId: integer("closure_marche_id").references(() => marches.id),
  closureProjectId: integer("closure_project_id").references(() => projects.id),
  closureContractorId: integer("closure_contractor_id").references(() => contractors.id),
  closureReceptionDate: date("closure_reception_date"),
  // Structured devis-code (Task #176). The architect supplies three parts:
  //   1. lotRef    — picked from `lot_catalog` (then `lotCatalogId` is set
  //                   and `lotRefText` mirrors the catalog code) OR typed
  //                   free-text (`lotCatalogId` null, `lotRefText` holds it).
  //                   Free-text refs are NOT promoted into the master list.
  //   2. lotSequence — auto-suggested per-project next integer for that lot
  //                    reference; uniqueness enforced by the partial index
  //                    below.
  //   3. description — free text composed into `devisCode` only; not stored
  //                    separately (we split it back out of `devisCode` at
  //                    edit time using the dot delimiter).
  // The composed `{lotRef}.{number}.{description}` string lives in the
  // existing `devisCode` column so all read paths keep working unchanged.
  // Legacy free-text-only devis carry NULLs in all three columns until an
  // architect edits them through the structured form (lazy migration).
  lotCatalogId: integer("lot_catalog_id").references(() => lotCatalog.id, { onDelete: "set null" }),
  lotRefText: text("lot_ref_text"),
  lotSequence: integer("lot_sequence"),
  // Task #215 — Acompte (deposit) workflow. French BTP devis routinely
  // require a 30% deposit on order/signature; the contractor issues a
  // SEPARATE facture d'acompte that subsequent progress invoices must
  // deduct ("déduction acompte versé") to avoid double-billing.
  //
  //   acompteRequired               — flips the gate on for this devis.
  //                                    Default false (no acompte).
  //   acomptePercent / acompteAmountHt — spec extracted from the devis
  //                                    PDF or set manually. At least one
  //                                    of the two should be present
  //                                    when acompteRequired is true.
  //   acompteTrigger                — verbatim payment-terms phrase that
  //                                    triggered detection (e.g.
  //                                    "30% à la commande"). Audit-only.
  //   acompteState                  — lifecycle: 'none' | 'pending' |
  //                                    'invoiced' | 'paid' | 'applied'.
  //                                    See migrations/0037 for the full
  //                                    state-machine description. No
  //                                    DB-level CHECK by convention.
  //   acompteInvoiceId              — facture d'acompte once linked.
  //   acomptePaidAt                 — when state advanced to 'paid'.
  //   allowProgressBeforeAcompte    — per-devis override of the
  //                                    invoice/situation gate. Default
  //                                    false (gate ON per task spec).
  acompteRequired: boolean("acompte_required").notNull().default(false),
  acomptePercent: numeric("acompte_percent", { precision: 5, scale: 2 }),
  acompteAmountHt: numeric("acompte_amount_ht", { precision: 12, scale: 2 }),
  acompteTrigger: text("acompte_trigger"),
  acompteState: text("acompte_state").notNull().default("none"),
  // FK to invoices(id) is declared in migrations/0037_devis_acompte.sql.
  // We intentionally do NOT mirror it via .references() here because that
  // would create a circular Drizzle declaration (invoices already
  // references devis), which collapses TS inference of both tables to
  // `any`. The DB enforces the constraint either way.
  acompteInvoiceId: integer("acompte_invoice_id"),
  acomptePaidAt: timestamp("acompte_paid_at", { withTimezone: true }),
  // Task #491 — provenance of the 'paid' transition: 'invoice' (facture
  // d'acompte path) or 'certificat_no_invoice' (deposit raised via the
  // acompte certificat, no supplier invoice ever existed). Null until paid.
  acomptePaidVia: text("acompte_paid_via"),
  allowProgressBeforeAcompte: boolean("allow_progress_before_acompte").notNull().default(false),
  // Task #225 — Gemini-extracted IBAN/BIC printed on the supplier devis.
  // Compared against contractors.iban at certificat-issue time; a mismatch
  // blocks issuance until an architect records a banking_mismatch_overrides row.
  extractedIban: varchar("extracted_iban", { length: 34 }),
  extractedBic: varchar("extracted_bic", { length: 11 }),
  // Task #619 — free-text notes field on the devis header. Optional; set
  // and cleared by the architect via the "Edit References" dialog. Does not
  // affect amounts, states, seals, or PDF output.
  notes: text("notes"),
  // Task #650 — Planning Envelope provenance. Nullable; set immutably when
  // this devis was promoted from an approved planning revision. The FK to
  // planning_revisions is declared SQL-only in migrations/0104 to avoid
  // Drizzle circular inference (planning_revisions already references devis
  // through promoted_devis_id). A partial UNIQUE index in the migration
  // enforces one devis per promoted revision.
  sourcePlanningRevisionId: integer("source_planning_revision_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("devis_project_id_idx").on(table.projectId),
  index("devis_contractor_id_idx").on(table.contractorId),
  index("devis_archisign_envelope_id_idx").on(table.archisignEnvelopeId),
  check("devis_closure_state_chk", sql`${table.closureState} IN ('open', 'closed')`),
  check(
    "devis_closure_audit_chk",
    sql`(${table.closureState} = 'open' AND ${table.closedAt} IS NULL AND ${table.closedByUserId} IS NULL AND ${table.closureMarcheId} IS NULL AND ${table.closureProjectId} IS NULL AND ${table.closureContractorId} IS NULL AND ${table.closureReceptionDate} IS NULL) OR (${table.closureState} = 'closed' AND ${table.closedAt} IS NOT NULL AND ${table.closedByUserId} IS NOT NULL AND ${table.closureMarcheId} IS NOT NULL AND ${table.closureProjectId} IS NOT NULL AND ${table.closureContractorId} IS NOT NULL AND ${table.closureReceptionDate} IS NOT NULL)`,
  ),
  // Partial unique index `devis_project_lot_ref_seq_unique` is intentionally
  // declared ONLY in migrations/0029_devis_structured_lot_code.sql, not here.
  // Drizzle-kit (as of 0.31) misaligns opclasses for indexes that mix plain
  // columns with sql`...` expressions (it emits e.g. `project_id text_ops`
  // which Postgres rejects with: operator class "text_ops" does not accept
  // data type integer). Keeping the index out of the schema prevents the
  // schema-based deploy generator from re-emitting that broken DDL.
  // Application-level uniqueness is enforced by isLotSequenceTaken /
  // findNextLotSequence in server/lib/devis-code.ts before insert/update.
]);

export const devisLineItems = pgTable("devis_line_items", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 3 }),
  unit: text("unit"),
  unitPriceHt: numeric("unit_price_ht", { precision: 12, scale: 2 }),
  totalHt: numeric("total_ht", { precision: 12, scale: 2 }).notNull(),
  percentComplete: numeric("percent_complete", { precision: 5, scale: 2 }).default("0.00"),
  checkStatus: text("check_status").notNull().default("unchecked"),
  checkNotes: text("check_notes"),
  // 1-indexed PDF page where this line was extracted from. Nullable because
  // (a) the upload-time AI may not reliably emit it, and (b) older line items
  // pre-dating Task #111 carry no page hint. The contractor portal uses this
  // to deep-link the embedded PDF viewer to the relevant page; absence simply
  // suppresses the click-to-jump affordance for that question.
  pdfPageHint: integer("pdf_page_hint"),
  // Bounding box of the line on its PDF page, normalized to [0,1] of the
  // page width / height (origin = top-left). Used by the pdf.js-based
  // contractor portal viewer (Task #113) to draw a per-line highlight
  // rectangle when the contractor clicks a question. Nullable: when absent
  // the portal degrades to the page-level scroll behaviour from Task #111.
  // Shape: { x: number, y: number, w: number, h: number } with each value
  // in [0, 1].
  pdfBbox: jsonb("pdf_bbox").$type<{ x: number; y: number; w: number; h: number } | null>(),
}, (table) => [
  index("devis_line_items_devis_id_idx").on(table.devisId),
]);

export const avenants = pgTable("avenants", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  avenantNumber: text("avenant_number"),
  type: text("type").notNull(),
  descriptionFr: text("description_fr").notNull(),
  descriptionUk: text("description_uk"),
  amountHt: numeric("amount_ht", { precision: 12, scale: 2 }).notNull(),
  amountTtc: numeric("amount_ttc", { precision: 12, scale: 2 }).notNull(),
  dateSigned: date("date_signed"),
  status: text("status").notNull().default("draft"),
  pvmvRef: text("pvmv_ref"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("avenants_devis_id_idx").on(table.devisId),
]);

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  contractorId: integer("contractor_id").notNull().references(() => contractors.id),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  // Task #451 — the old loose-text `certificate_number` column was dropped;
  // certificat linkage is now the FK-grounded `certificat_sources` junction.
  invoiceNumber: text("invoice_number").notNull(),
  amountHt: numeric("amount_ht", { precision: 12, scale: 2 }).notNull(),
  tvaAmount: numeric("tva_amount", { precision: 12, scale: 2 }).notNull(),
  amountTtc: numeric("amount_ttc", { precision: 12, scale: 2 }).notNull(),
  dateIssued: date("date_issued"),
  dateSent: date("date_sent"),
  datePaid: date("date_paid"),
  status: text("status").notNull().default("pending"),
  pdfPath: text("pdf_path"),
  notes: text("notes"),
  validationWarnings: jsonb("validation_warnings"),
  aiExtractedData: jsonb("ai_extracted_data"),
  aiConfidence: integer("ai_confidence"),
  // Task #198 — Drive copy of this invoice's PDF (see devis above).
  driveFileId: text("drive_file_id"),
  driveWebViewLink: text("drive_web_view_link"),
  driveUploadedAt: timestamp("drive_uploaded_at"),
  // Task #225 — Gemini-extracted IBAN/BIC printed on the supplier invoice.
  // See devis.extractedIban for the anti-fraud rationale.
  extractedIban: varchar("extracted_iban", { length: 34 }),
  extractedBic: varchar("extracted_bic", { length: 11 }),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("invoices_project_id_idx").on(table.projectId),
  index("invoices_devis_id_idx").on(table.devisId),
  index("invoices_contractor_id_idx").on(table.contractorId),
  check("invoices_amount_ht_nonneg", sql`${table.amountHt} >= 0`),
  check("invoices_amount_ttc_nonneg", sql`${table.amountTtc} >= 0`),
  check("invoices_tva_amount_nonneg", sql`${table.tvaAmount} >= 0`),
]);

export const situations = pgTable("situations", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  situationNumber: integer("situation_number").notNull(),
  dateIssued: date("date_issued"),
  cumulativeHt: numeric("cumulative_ht", { precision: 12, scale: 2 }).notNull(),
  previousHt: numeric("previous_ht", { precision: 12, scale: 2 }).notNull().default("0.00"),
  netHt: numeric("net_ht", { precision: 12, scale: 2 }).notNull(),
  retenueGarantie: numeric("retenue_garantie", { precision: 12, scale: 2 }).default("0.00"),
  netToPayHt: numeric("net_to_pay_ht", { precision: 12, scale: 2 }).notNull(),
  tvaAmount: numeric("tva_amount", { precision: 12, scale: 2 }).notNull(),
  netToPayTtc: numeric("net_to_pay_ttc", { precision: 12, scale: 2 }).notNull(),
  status: text("status").notNull().default("draft"),
  // Task #449 — source-PDF provenance: the signed "Situation de travaux"
  // document this record was keyed from. Attached either automatically by
  // the intake pipeline (exact project+contractor+devis+number match) or by
  // an operator through the reviewed one-click attach flow. All columns are
  // server-written only — the generic PATCH strips them (see routes).
  //   sourceStorageKey/FileName — object-storage copy of the signed PDF.
  //   sourceUploadedAt/By       — when + how the PDF was attached
  //                               ("intake-auto" | operator name).
  //   sourceConfirmedAt/By      — operator confirmation (draft→confirm):
  //                               auto-attached PDFs start unconfirmed;
  //                               reviewed attachments confirm immediately.
  //   sourceIntakeDocumentId    — provenance FK back to the intake row.
  sourceStorageKey: text("source_storage_key"),
  sourceFileName: text("source_file_name"),
  sourceUploadedAt: timestamp("source_uploaded_at"),
  sourceUploadedBy: text("source_uploaded_by"),
  sourceConfirmedAt: timestamp("source_confirmed_at"),
  sourceConfirmedBy: text("source_confirmed_by"),
  sourceIntakeDocumentId: integer("source_intake_document_id").references(() => projectIntakeDocuments.id, { onDelete: "set null" }),
  // Task #450 — review lifecycle: a situation created from an intake
  // 'situation' PDF keeps the raw AI extraction payload for audit;
  // confirmedAt is set exactly once by the confirm endpoint (draft →
  // confirmed). Source-PDF evidence uses the Task #449 columns above.
  aiExtractedData: jsonb("ai_extracted_data"),
  confirmedAt: timestamp("confirmed_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("situations_devis_id_idx").on(table.devisId),
  // One situations row per source intake document (partial unique) — a
  // signed PDF can never be retained as evidence on two situations. The
  // attach transaction relies on this racing safely (23505 → conflict).
  uniqueIndex("situations_source_intake_doc_unique")
    .on(table.sourceIntakeDocumentId)
    .where(sql`${table.sourceIntakeDocumentId} IS NOT NULL`),
  unique("situations_devis_number_unique").on(table.devisId, table.situationNumber),
  check("situations_cumulative_ht_nonneg", sql`${table.cumulativeHt} >= 0`),
  check("situations_net_to_pay_ttc_nonneg", sql`${table.netToPayTtc} >= 0`),
]);

export const situationLines = pgTable("situation_lines", {
  id: serial("id").primaryKey(),
  situationId: integer("situation_id").notNull().references(() => situations.id, { onDelete: "cascade" }),
  devisLineItemId: integer("devis_line_item_id").notNull().references(() => devisLineItems.id),
  percentComplete: numeric("percent_complete", { precision: 5, scale: 2 }).notNull(),
  cumulativeAmount: numeric("cumulative_amount", { precision: 12, scale: 2 }).notNull(),
  previousAmount: numeric("previous_amount", { precision: 12, scale: 2 }).notNull().default("0.00"),
  netAmount: numeric("net_amount", { precision: 12, scale: 2 }).notNull(),
  // Task #450 — traffic-light review, mirroring devis_line_items.
  // claimedPercent is the AI-extracted % from the contractor's situation PDF
  // (immutable audit value); percentComplete above is the architect-approved
  // %. checkStatus: unchecked | green | amber | red. checkNotes free text.
  claimedPercent: numeric("claimed_percent", { precision: 5, scale: 2 }),
  checkStatus: text("check_status").notNull().default("unchecked"),
  checkNotes: text("check_notes"),
}, (table) => [
  index("situation_lines_situation_id_idx").on(table.situationId),
  index("situation_lines_devis_line_item_id_idx").on(table.devisLineItemId),
  // Task #450 (review follow-up) — one line per devis line item per
  // situation; DB-level guard against concurrent duplicate creation
  // (migration 0077). Route surfaces the violation as 409.
  uniqueIndex("situation_lines_situation_devis_line_unique").on(table.situationId, table.devisLineItemId),
]);

// Task #449 — signed marché-level evidence documents (currently kind
// "commande": the signed Bon de commande / purchase order). Stored as an
// object-storage copy attached to the project (and, when unambiguous, the
// devis it authorises). No DB enum by schema convention — `kind` and
// `status` are plain text columns; the app vocabulary is
// MARCHE_DOCUMENT_KINDS / draft|confirmed. Auto-routed rows start as
// status "draft" (unreviewed); operator attachment or confirmation moves
// them to "confirmed".
export const MARCHE_DOCUMENT_KINDS = ["commande"] as const;
export type MarcheDocumentKind = (typeof MARCHE_DOCUMENT_KINDS)[number];

export const marcheDocuments = pgTable("marche_documents", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("commande"),
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name").notNull(),
  // Optional links: the devis this commande authorises, and (when known)
  // the marché record itself. Both nullable — a commande can arrive before
  // either exists.
  devisId: integer("devis_id").references(() => devis.id, { onDelete: "set null" }),
  marcheId: integer("marche_id").references(() => marches.id, { onDelete: "set null" }),
  // Provenance back to the intake pipeline row the PDF came through.
  sourceIntakeDocumentId: integer("source_intake_document_id").references(() => projectIntakeDocuments.id, { onDelete: "set null" }),
  extractedData: jsonb("extracted_data"),
  status: text("status").notNull().default("draft"),
  uploadedAt: timestamp("uploaded_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  uploadedBy: text("uploaded_by"),
  confirmedAt: timestamp("confirmed_at"),
  confirmedBy: text("confirmed_by"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("marche_documents_project_id_idx").on(table.projectId),
  index("marche_documents_devis_id_idx").on(table.devisId),
  index("marche_documents_marche_id_idx").on(table.marcheId),
  // One evidence row per intake document (concurrent/double-submit safety):
  // creation goes through ON CONFLICT DO NOTHING against this partial
  // unique index and re-reads the winner.
  uniqueIndex("marche_documents_source_intake_doc_unique")
    .on(table.sourceIntakeDocumentId)
    .where(sql`${table.sourceIntakeDocumentId} IS NOT NULL`),
]);

export const certificats = pgTable("certificats", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  contractorId: integer("contractor_id").notNull().references(() => contractors.id),
  certificateRef: text("certificate_ref").notNull(),
  dateIssued: date("date_issued"),
  totalWorksHt: numeric("total_works_ht", { precision: 12, scale: 2 }).notNull(),
  pvMvAdjustment: numeric("pv_mv_adjustment", { precision: 12, scale: 2 }).default("0.00"),
  previousPayments: numeric("previous_payments", { precision: 12, scale: 2 }).default("0.00"),
  retenueGarantie: numeric("retenue_garantie", { precision: 12, scale: 2 }).default("0.00"),
  // Task #243 — Compte Prorata deduction, computed authoritatively server-side.
  // cumulative = gross certified works × project prorata rate; period =
  // cumulative − Σ prior certificats' period prorata. Both zero when the
  // contractor's marché is the prorata manager or the project rate is 0.
  cumulativeProrataDeduction: numeric("cumulative_prorata_deduction", { precision: 12, scale: 2 }).notNull().default("0.00"),
  periodProrataDeduction: numeric("period_prorata_deduction", { precision: 12, scale: 2 }).notNull().default("0.00"),
  // Task #462 — remboursement d'acompte: recovery of the deposit paid on the
  // contractor's devis. Cumulative-to-date + this period's movement, computed
  // authoritatively server-side (see certificat-deductions.service).
  cumulativeAcompteRecoupment: numeric("cumulative_acompte_recoupment", { precision: 12, scale: 2 }).notNull().default("0.00"),
  periodAcompteRecoupment: numeric("period_acompte_recoupment", { precision: 12, scale: 2 }).notNull().default("0.00"),
  // Task #463 — the TVA rate actually APPLIED to this certificat (audit:
  // the amount alone doesn't prove which rate produced it). Server-derived
  // on every create/PATCH; frozen once sealed. `tvaAutoliquidation` true ⇔
  // rate 0.00 + the mandatory art. 283 CGI mention on the PDF.
  tvaRatePercent: numeric("tva_rate_percent", { precision: 5, scale: 2 }).notNull().default("20.00"),
  tvaAutoliquidation: boolean("tva_autoliquidation").notNull().default(false),
  // Task #479 — provenance of the applied TVA rate (audit + UI honesty):
  // 'autoliquidation' (art. 283 CGI, rate 0), 'override' (draft-level
  // architect override), 'documentary' (blended effective rate derived from
  // the contractor's invoices' HT/TTC — handles mixed 10%/20% invoices),
  // 'marche' (contract rate), 'contractor' (contractor default), 'default'
  // (last-resort statutory 20%). Server-derived on every create/PATCH;
  // frozen once sealed, like tvaRatePercent.
  tvaRateSource: text("tva_rate_source").notNull().default("default"),
  // Task #464 — solde (final) certificat for its marché. At most ONE
  // non-superseded solde certificat may exist per (project, contractor):
  // enforced by the partial unique index below + a friendly resolver check.
  isSolde: boolean("is_solde").notNull().default(false),
  // Task #464 — explicit retenue de garantie release on the solde
  // certificat. Default is WITHHELD; the architect must explicitly toggle
  // the release (after parfait achèvement, or when a caution bancaire
  // replaces the holdback). `retenueReleaseAmount` is the cumulative
  // retenue added BACK into the net to pay as a distinct positive line —
  // server-derived, never client-settable. Reason + date are the audit
  // trail (reason is architect-provided, date server-stamped). All four
  // are frozen by the issuance seal; post-seal changes go through reissue.
  retenueReleased: boolean("retenue_released").notNull().default(false),
  retenueReleaseAmount: numeric("retenue_release_amount", { precision: 12, scale: 2 }).notNull().default("0.00"),
  retenueReleaseReason: text("retenue_release_reason"),
  retenueReleaseDate: date("retenue_release_date"),
  // Task #566 — audited escape hatch for the PV de réception gate. A solde
  // certificat is normally refused until the marché's PV is approved; for
  // legacy projects the architect may override with an explicit reason.
  // Reason is architect-provided at create/PATCH; who/when are server-set.
  // All three frozen by the issuance seal (changes require reissue).
  pvOverrideReason: text("pv_override_reason"),
  pvOverrideByUserId: integer("pv_override_by_user_id").references(() => users.id),
  pvOverrideAt: timestamp("pv_override_at"),
  netToPayHt: numeric("net_to_pay_ht", { precision: 12, scale: 2 }).notNull(),
  tvaAmount: numeric("tva_amount", { precision: 12, scale: 2 }).notNull(),
  netToPayTtc: numeric("net_to_pay_ttc", { precision: 12, scale: 2 }).notNull(),
  status: text("status").notNull().default("draft"),
  notes: text("notes"),
  // Task #198 — Drive copy of the architect-signed certificat PDF.
  driveFileId: text("drive_file_id"),
  driveWebViewLink: text("drive_web_view_link"),
  driveUploadedAt: timestamp("drive_uploaded_at"),
  // Task #451 — issuance seal. A certificat is a payment instruction: once
  // issued (sent) it must never silently re-render with different numbers.
  // `pdfStorageKey` pins the exact bytes rendered at issuance; `issuedAt` +
  // `issuanceSnapshot` freeze the financial inputs that produced them. All
  // three are written exactly once by the seal service via a conditional
  // UPDATE (WHERE pdf_storage_key IS NULL) so concurrent sends elect a
  // single sealer. NULL pdfStorageKey ⇔ draft/preview-only. Corrections to
  // a sealed certificat require a reissue (new certificat), never an edit.
  pdfStorageKey: text("pdf_storage_key"),
  pdfFileName: text("pdf_file_name"),
  issuedAt: timestamp("issued_at"),
  issuanceSnapshot: jsonb("issuance_snapshot"),
  // Task #451 — optimistic-concurrency guard. Every UPDATE bumps `version`
  // (see storage.updateCertificat); the seal commits only when the version
  // captured BEFORE rendering still matches, so the pinned PDF, the
  // issuanceSnapshot and the persisted financial fields always agree.
  version: integer("version").notNull().default(1),
  // Task #457 — assisted reissue lineage. When a sealed certificat needs a
  // correction, the reissue flow clones it into a new draft and records the
  // parent here. Server-set only (stripped from create/update request
  // schemas); the partial unique index makes "at most one reissue per
  // certificat" race-free — concurrent reissues elect a single winner at
  // INSERT time, never via check-then-write.
  reissuedFromCertificatId: integer("reissued_from_certificat_id"),
  // Task #491 — non-null marks this row as an ACOMPTE (opening/deposit)
  // certificat raised straight from a signed devis, with no supplier
  // invoice. Acompte certificats sit OUTSIDE the progress waterfall: the
  // deductions resolver skips them when reading prior cumulatives, and the
  // seal never re-resolves their money. At most one live acompte certificat
  // per devis (partial unique below excludes superseded rows).
  acompteDevisId: integer("acompte_devis_id"),
  // Task #627 — frozen bank-transfer reference, derived at issue time from the
  // certified contractor invoice numbers (scoped progress) or devis code
  // (acompte / legacy). Stored once by the seal so every PDF, reissue view,
  // and payment ledger pre-fill show the exact same string.
  paymentTransferRef: text("payment_transfer_ref"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("certificats_project_ref_unique").on(table.projectId, table.certificateRef),
  index("certificats_project_contractor_idx").on(table.projectId, table.contractorId),
  foreignKey({ columns: [table.reissuedFromCertificatId], foreignColumns: [table.id], name: "certificats_reissued_from_fk" }),
  uniqueIndex("certificats_reissued_from_unique")
    .on(table.reissuedFromCertificatId)
    .where(sql`${table.reissuedFromCertificatId} IS NOT NULL`),
  // Task #491 — at most ONE live acompte certificat per devis. Race-free at
  // INSERT time; a superseded acompte certificat may be replaced by reissue.
  foreignKey({ columns: [table.acompteDevisId], foreignColumns: [devis.id], name: "certificats_acompte_devis_fk" }),
  uniqueIndex("certificats_acompte_devis_unique")
    .on(table.acompteDevisId)
    .where(sql`${table.acompteDevisId} IS NOT NULL AND ${table.status} <> 'superseded'`),
  // Task #464 — at most ONE non-superseded solde certificat per
  // (project, contractor). Race-free at INSERT/UPDATE time; the reissue
  // transaction supersedes the original BEFORE inserting the clone so a
  // solde reissue never trips this index mid-transaction.
  uniqueIndex("certificats_solde_unique")
    .on(table.projectId, table.contractorId)
    .where(sql`${table.isSolde} = true AND ${table.status} <> 'superseded'`),
  // Task #457 — closed status vocabulary; `superseded` is written only by
  // the atomic reissue transaction (enforced at the routes) and is terminal.
  check(
    "certificats_status_check",
    sql`${table.status} IN ('draft', 'ready', 'sent', 'paid', 'superseded')`,
  ),
]);

/**
 * Task #465 — certificat_payments: structured client-payment ledger per
 * certificat. Each row is a FACT (a payment received), not a workflow state:
 * partial payments accumulate, and the certificat flips to `paid` only when
 * the cumulative logged amount covers the TTC total (roundCurrency compare,
 * server-side). Entries stay correctable while the certificat is not fully
 * paid; every create/update/delete writes an audit row. Existing `paid`
 * certificats without payment rows are grandfathered readable — no rows are
 * fabricated for them.
 */
export const certificatPayments = pgTable("certificat_payments", {
  id: serial("id").primaryKey(),
  certificatId: integer("certificat_id").notNull().references(() => certificats.id, { onDelete: "cascade" }),
  datePaid: date("date_paid").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  method: text("method").notNull().default("virement"),
  reference: text("reference"),
  loggedBy: text("logged_by"),
  // `manual` today; `email` reserved for the Gmail confirmation follow-up.
  source: text("source").notNull().default("manual"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("certificat_payments_certificat_id_idx").on(table.certificatId),
  check("certificat_payments_amount_positive", sql`${table.amount} > 0`),
  check("certificat_payments_method_check", sql`${table.method} IN ('virement', 'cheque', 'autre')`),
  check("certificat_payments_source_check", sql`${table.source} IN ('manual', 'email')`),
]);

/**
 * Task #465 — append-only audit trail of payment-ledger edits. `paymentId`
 * is a plain integer (no FK) so the audit survives a deleted entry; the
 * certificat FK keeps the trail queryable per certificat. `snapshot` holds
 * the row state BEFORE the change (null for `created`).
 */
export const certificatPaymentAudits = pgTable("certificat_payment_audits", {
  id: serial("id").primaryKey(),
  certificatId: integer("certificat_id").notNull().references(() => certificats.id, { onDelete: "cascade" }),
  paymentId: integer("payment_id").notNull(),
  action: text("action").notNull(),
  snapshot: jsonb("snapshot"),
  changedBy: text("changed_by"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("certificat_payment_audits_certificat_id_idx").on(table.certificatId),
  check("certificat_payment_audits_action_check", sql`${table.action} IN ('created', 'updated', 'deleted')`),
]);

/**
 * Task #466 — draft payment suggestions detected from client "paid"
 * confirmation replies in the Gmail thread of a sent certificat.
 *
 * NOTHING is auto-recorded: the architect confirms (creating a real
 * certificat_payments row with source='email' via the atomic ledger tx) or
 * dismisses. `emailMessageId` is UNIQUE — one suggestion per inbound reply,
 * idempotent across polls. The partial unique index allows at most ONE
 * open (pending_review) suggestion per certificat, so duplicate "paid"
 * replies in the same thread never stack suggestions for the same
 * outstanding balance. `ambiguous` rows are client replies on a certificat
 * thread whose text did NOT deterministically confirm payment — surfaced
 * in the communications hub for review instead of silently dropped.
 * `paymentId` is a plain int (audit survives ledger edits).
 */
export const certificatPaymentSuggestions = pgTable("certificat_payment_suggestions", {
  id: serial("id").primaryKey(),
  certificatId: integer("certificat_id").notNull().references(() => certificats.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  communicationId: integer("communication_id").notNull(),
  emailMessageId: text("email_message_id").notNull(),
  emailThreadId: text("email_thread_id").notNull(),
  senderEmail: text("sender_email").notNull(),
  emailDate: timestamp("email_date").notNull(),
  matchedExcerpt: text("matched_excerpt"),
  suggestedAmount: numeric("suggested_amount", { precision: 12, scale: 2 }).notNull(),
  suggestedDate: date("suggested_date").notNull(),
  // Task #519 — who is confirming what: 'client_paid' = the client says
  // they paid (reply on the certificat_sent thread); 'contractor_received'
  // = the contractor confirms the money arrived (reply on the
  // certificat_contractor_notice thread). Same review queue, same atomic
  // confirm — the kind only changes labelling and the default reference.
  kind: text("kind").notNull().default("client_paid"),
  status: text("status").notNull().default("pending_review"),
  paymentId: integer("payment_id"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  // Task #529 — visibility-only archive flag (see project_communications).
  // Only already-reviewed suggestions are ever archived; open ones stay
  // in the review queue regardless.
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("certificat_payment_suggestions_message_unique").on(table.emailMessageId),
  // Task #519 — pending-uniqueness is per (certificat, kind): a client
  // "paid" suggestion must not block the contractor "received" one, but
  // duplicates of the same kind still never stack.
  uniqueIndex("certificat_payment_suggestions_pending_unique")
    .on(table.certificatId, table.kind)
    .where(sql`${table.status} = 'pending_review'`),
  index("certificat_payment_suggestions_certificat_id_idx").on(table.certificatId),
  index("certificat_payment_suggestions_project_id_idx").on(table.projectId),
  index("certificat_payment_suggestions_status_idx").on(table.status),
  check(
    "certificat_payment_suggestions_status_check",
    sql`${table.status} IN ('pending_review', 'ambiguous', 'confirmed', 'dismissed')`,
  ),
  check(
    "certificat_payment_suggestions_kind_check",
    sql`${table.kind} IN ('client_paid', 'contractor_received')`,
  ),
]);

/**
 * Task #617 — milestone_payment_suggestions: draft "client paid" suggestions
 * for DESIGN-CONTRACT MILESTONES, detected from client replies on the Gmail
 * thread of the firm's own invoiced honoraires facture (the confirmed
 * architect_fee_invoices evidence carries the thread via its email document).
 * Mirrors certificat_payment_suggestions: deterministic phrase detection,
 * nothing auto-recorded — the architect confirms (milestone → paid, paidAt
 * from the suggestion date) or dismisses. `emailMessageId` is UNIQUE, and at
 * most one open pending suggestion per milestone (partial unique index).
 */
export const MILESTONE_PAYMENT_SUGGESTION_STATUSES = ["pending_review", "ambiguous", "confirmed", "dismissed"] as const;
export type MilestonePaymentSuggestionStatus = (typeof MILESTONE_PAYMENT_SUGGESTION_STATUSES)[number];

export const milestonePaymentSuggestions = pgTable("milestone_payment_suggestions", {
  id: serial("id").primaryKey(),
  milestoneId: integer("milestone_id").notNull().references(() => designContractMilestones.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  architectFeeInvoiceId: integer("architect_fee_invoice_id"),
  emailMessageId: text("email_message_id").notNull(),
  emailThreadId: text("email_thread_id").notNull(),
  senderEmail: text("sender_email").notNull(),
  emailDate: timestamp("email_date").notNull(),
  matchedExcerpt: text("matched_excerpt"),
  suggestedAmount: numeric("suggested_amount", { precision: 12, scale: 2 }).notNull(),
  suggestedDate: date("suggested_date").notNull(),
  status: text("status").notNull().default("pending_review"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("milestone_payment_suggestions_message_unique").on(table.emailMessageId),
  uniqueIndex("milestone_payment_suggestions_pending_unique")
    .on(table.milestoneId)
    .where(sql`${table.status} = 'pending_review'`),
  index("milestone_payment_suggestions_milestone_id_idx").on(table.milestoneId),
  index("milestone_payment_suggestions_project_id_idx").on(table.projectId),
  index("milestone_payment_suggestions_status_idx").on(table.status),
  check(
    "milestone_payment_suggestions_status_check",
    sql`${table.status} IN ('pending_review', 'ambiguous', 'confirmed', 'dismissed')`,
  ),
]);

export const insertMilestonePaymentSuggestionSchema = createInsertSchema(milestonePaymentSuggestions).omit({
  id: true,
  createdAt: true,
  reviewedBy: true,
  reviewedAt: true,
});
export type MilestonePaymentSuggestion = typeof milestonePaymentSuggestions.$inferSelect;
export type InsertMilestonePaymentSuggestion = z.infer<typeof insertMilestonePaymentSuggestionSchema>;

/**
 * Task #451 — certificat_sources: FK-grounded record of exactly which
 * documents a sealed certificat certifies. Replaces the loose free-text
 * `invoices.certificate_number` (dropped in migration 0071). Each row links
 * the certificat to EITHER a situation OR an invoice (XOR enforced by CHECK).
 * Rows are written once at seal time from the documents actually included in
 * the rendered PDF, with ON CONFLICT DO NOTHING so a concurrent-send loser
 * can replay harmlessly.
 */
export const certificatSources = pgTable("certificat_sources", {
  id: serial("id").primaryKey(),
  certificatId: integer("certificat_id").notNull().references(() => certificats.id, { onDelete: "cascade" }),
  situationId: integer("situation_id").references(() => situations.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("certificat_sources_certificat_id_idx").on(table.certificatId),
  index("certificat_sources_situation_id_idx").on(table.situationId),
  index("certificat_sources_invoice_id_idx").on(table.invoiceId),
  uniqueIndex("certificat_sources_cert_situation_unique")
    .on(table.certificatId, table.situationId)
    .where(sql`${table.situationId} IS NOT NULL`),
  uniqueIndex("certificat_sources_cert_invoice_unique")
    .on(table.certificatId, table.invoiceId)
    .where(sql`${table.invoiceId} IS NOT NULL`),
  check(
    "certificat_sources_exactly_one_target",
    sql`(${table.situationId} IS NOT NULL) <> (${table.invoiceId} IS NOT NULL)`,
  ),
]);
export const fees = pgTable("fees", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  feeType: text("fee_type").notNull(),
  phase: text("phase"),
  baseAmountHt: numeric("base_amount_ht", { precision: 12, scale: 2 }).notNull().default("0.00"),
  feeRate: numeric("fee_rate", { precision: 5, scale: 2 }),
  feeAmountHt: numeric("fee_amount_ht", { precision: 12, scale: 2 }).notNull(),
  invoicedAmount: numeric("invoiced_amount", { precision: 12, scale: 2 }).default("0.00"),
  remainingAmount: numeric("remaining_amount", { precision: 12, scale: 2 }).notNull(),
  pennylaneRef: text("pennylane_ref"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("fees_project_id_idx").on(table.projectId),
]);

export const feeEntries = pgTable("fee_entries", {
  id: serial("id").primaryKey(),
  feeId: integer("fee_id").notNull().references(() => fees.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").references(() => invoices.id),
  devisId: integer("devis_id").references(() => devis.id),
  baseHt: numeric("base_ht", { precision: 12, scale: 2 }).notNull(),
  feeRate: numeric("fee_rate", { precision: 5, scale: 2 }).notNull(),
  feeAmount: numeric("fee_amount", { precision: 12, scale: 2 }).notNull(),
  // Pre-Task #214 manual entry — human-typed reference of an invoice
  // the architect created in Pennylane by hand. Retained as the
  // escape hatch when PENNYLANE_PUSH_ENABLED is off (legacy "Mark as
  // invoiced" flow). The columns below carry the structured state of
  // the automated push instead.
  pennylaneInvoiceRef: text("pennylane_invoice_ref"),
  dateInvoiced: date("date_invoiced"),
  status: text("status").notNull().default("pending"),
  // Task #214 — automated honoraires push to Pennylane. All NULL
  // until the queue worker successfully creates the customer_invoice.
  // pennylaneInvoiceId: the API-assigned id (numeric in the JSON,
  //   stored as text so we never coerce / truncate).
  // pennylanePdfStorageKey: object-storage key for the mirrored PDF
  //   we downloaded from the (short-lived) public_file_url returned
  //   by the create call. Source of truth for the email attachment +
  //   the audit trail.
  // pennylanePushedAt: first time the invoice was created in
  //   Pennylane. Never updated on subsequent paid-status polls.
  // pennylanePaidAt / pennylanePaidAmount / pennylaneStatus: written
  //   by the hourly poller from GET /customer_invoices.
  pennylaneInvoiceId: text("pennylane_invoice_id"),
  // Task #426 — the HUMAN-VISIBLE Pennylane invoice number (e.g.
  // "F-2026-138"), captured from the API response at push time. The API id
  // alone cannot reconcile an inbound facture d'honoraires PDF against the
  // entry Pennylane already carries — only the human number appears on the
  // document itself.
  pennylaneInvoiceNumber: text("pennylane_invoice_number"),
  pennylanePdfStorageKey: text("pennylane_pdf_storage_key"),
  pennylanePushedAt: timestamp("pennylane_pushed_at"),
  pennylanePaidAt: timestamp("pennylane_paid_at"),
  pennylanePaidAmount: numeric("pennylane_paid_amount", { precision: 12, scale: 2 }),
  pennylaneStatus: text("pennylane_status"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("fee_entries_fee_id_idx").on(table.feeId),
  uniqueIndex("fee_entries_invoice_unique").on(table.invoiceId).where(sql`${table.invoiceId} IS NOT NULL`),
  uniqueIndex("fee_entries_pennylane_invoice_unique")
    .on(table.pennylaneInvoiceId)
    .where(sql`${table.pennylaneInvoiceId} IS NOT NULL`),
  check("fee_entries_fee_amount_nonneg", sql`${table.feeAmount} >= 0`),
  check("fee_entries_fee_rate_pct", sql`${table.feeRate} >= 0 AND ${table.feeRate} <= 100`),
]);

// -----------------------------------------------------------------------------
// Design contracts — uploaded PDF design contract per project,
// extracted by Gemini into totals + payment milestones. Replaces the manual
// conception/planning numeric inputs in the New Project dialog. One contract
// per project (UNIQUE projectId); re-upload archives the previous PDF and
// replaces both rows.
// -----------------------------------------------------------------------------
export const DESIGN_CONTRACT_TRIGGER_EVENTS = [
  "file_opened",
  "concept_signed",
  "permit_deposited",
  "final_plans_signed",
  "manual",
] as const;
export type DesignContractTriggerEvent = (typeof DESIGN_CONTRACT_TRIGGER_EVENTS)[number];

export const DESIGN_CONTRACT_MILESTONE_STATUSES = [
  "pending",
  "reached",
  "invoiced",
  "paid",
] as const;
export type DesignContractMilestoneStatus = (typeof DESIGN_CONTRACT_MILESTONE_STATUSES)[number];

export const designContracts = pgTable("design_contracts", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  originalFilename: text("original_filename").notNull(),
  totalHt: numeric("total_ht", { precision: 12, scale: 2 }),
  totalTva: numeric("total_tva", { precision: 12, scale: 2 }),
  totalTtc: numeric("total_ttc", { precision: 12, scale: 2 }).notNull(),
  tvaRate: numeric("tva_rate", { precision: 5, scale: 2 }),
  conceptionAmountHt: numeric("conception_amount_ht", { precision: 12, scale: 2 }),
  planningAmountHt: numeric("planning_amount_ht", { precision: 12, scale: 2 }),
  contractDate: date("contract_date"),
  contractReference: text("contract_reference"),
  clientName: text("client_name"),
  architectName: text("architect_name"),
  projectAddress: text("project_address"),
  extractionConfidence: jsonb("extraction_confidence"),
  extractionWarnings: jsonb("extraction_warnings"),
  uploadedByUserId: integer("uploaded_by_user_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("design_contracts_project_unique").on(table.projectId),
  index("design_contracts_project_id_idx").on(table.projectId),
  check("design_contracts_total_ttc_nonneg", sql`${table.totalTtc} >= 0`),
]);

export const designContractMilestones = pgTable("design_contract_milestones", {
  id: serial("id").primaryKey(),
  contractId: integer("contract_id").notNull().references(() => designContracts.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  labelFr: text("label_fr").notNull(),
  labelEn: text("label_en"),
  percentage: numeric("percentage", { precision: 5, scale: 2 }).notNull(),
  amountTtc: numeric("amount_ttc", { precision: 12, scale: 2 }).notNull(),
  triggerEvent: text("trigger_event").notNull().default("manual"),
  status: text("status").notNull().default("pending"),
  reachedAt: timestamp("reached_at"),
  invoicedAt: timestamp("invoiced_at"),
  paidAt: timestamp("paid_at"),
  notes: text("notes"),
  reminderLastSentAt: timestamp("reminder_last_sent_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("design_contract_milestones_contract_id_idx").on(table.contractId),
  index("design_contract_milestones_status_idx").on(table.status),
  uniqueIndex("design_contract_milestones_contract_seq_unique").on(table.contractId, table.sequence),
  check("design_contract_milestones_pct_range", sql`${table.percentage} >= 0 AND ${table.percentage} <= 100`),
  check("design_contract_milestones_amount_nonneg", sql`${table.amountTtc} >= 0`),
  check(
    "design_contract_milestones_trigger_event_chk",
    sql`${table.triggerEvent} IN ('file_opened','concept_signed','permit_deposited','final_plans_signed','manual')`,
  ),
  check(
    "design_contract_milestones_status_chk",
    sql`${table.status} IN ('pending','reached','invoiced','paid')`,
  ),
]);

export const archidocProjects = pgTable("archidoc_projects", {
  archidocId: varchar("archidoc_id", { length: 255 }).primaryKey(),
  projectName: text("project_name").notNull(),
  code: text("code"),
  clientName: text("client_name"),
  address: text("address"),
  status: text("status"),
  clients: jsonb("clients"),
  lotContractors: jsonb("lot_contractors"),
  customLots: jsonb("custom_lots"),
  actors: jsonb("actors"),
  isDeleted: boolean("is_deleted").default(false),
  deletedAt: timestamp("deleted_at"),
  sourceBaseUrl: text("source_base_url"),
  archidocUpdatedAt: timestamp("archidoc_updated_at"),
  syncedAt: timestamp("synced_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("archidoc_projects_is_deleted_idx").on(table.isDeleted),
]);

export const archidocContractors = pgTable("archidoc_contractors", {
  archidocId: varchar("archidoc_id", { length: 255 }).primaryKey(),
  partnerType: varchar("partner_type", { length: 32 }).notNull().default("contractor"),
  name: text("name").notNull(),
  siret: text("siret"),
  address1: text("address1"),
  address2: text("address2"),
  town: text("town"),
  postcode: text("postcode"),
  officePhone: text("office_phone"),
  website: text("website"),
  tradeIds: jsonb("trade_ids"),
  insuranceStatus: text("insurance_status"),
  decennaleInsurer: text("decennale_insurer"),
  decennalePolicyNumber: text("decennale_policy_number"),
  decennaleEndDate: text("decennale_end_date"),
  rcProInsurer: text("rc_pro_insurer"),
  rcProPolicyNumber: text("rc_pro_policy_number"),
  rcProEndDate: text("rc_pro_end_date"),
  specialConditions: text("special_conditions"),
  contacts: jsonb("contacts"),
  // Banking details mirror (Task #225). 1:1 with the upstream payload.
  accountHolderName: varchar("account_holder_name", { length: 255 }),
  iban: varchar("iban", { length: 34 }),
  bic: varchar("bic", { length: 11 }),
  bankName: varchar("bank_name", { length: 255 }),
  ribDocumentUrl: text("rib_document_url"),
  ribDocumentName: varchar("rib_document_name", { length: 255 }),
  bankingVerifiedAt: timestamp("banking_verified_at"),
  bankingVerifiedBy: text("banking_verified_by"),
  bankingAiExtractedData: jsonb("banking_ai_extracted_data"),
  isDeleted: boolean("is_deleted").default(false).notNull(),
  deletedAt: timestamp("deleted_at"),
  sourceBaseUrl: text("source_base_url"),
  archidocUpdatedAt: timestamp("archidoc_updated_at"),
  syncedAt: timestamp("synced_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  check("archidoc_contractors_siret_format", sql`${table.siret} IS NULL OR ${table.siret} ~ '^[0-9]{14}$'`),
  check("archidoc_contractors_partner_type_chk", sql`${table.partnerType} IN ('contractor', 'supplier')`),
  index("archidoc_contractors_is_deleted_idx").on(table.isDeleted),
]);

export const archidocTrades = pgTable("archidoc_trades", {
  archidocId: varchar("archidoc_id", { length: 255 }).primaryKey(),
  label: text("label").notNull(),
  description: text("description"),
  category: text("category"),
  sortOrder: integer("sort_order"),
  syncedAt: timestamp("synced_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const archidocProposalFees = pgTable("archidoc_proposal_fees", {
  id: serial("id").primaryKey(),
  archidocProjectId: varchar("archidoc_project_id", { length: 255 }).notNull(),
  proServiceHt: numeric("pro_service_ht", { precision: 12, scale: 2 }),
  proServiceTva: numeric("pro_service_tva", { precision: 12, scale: 2 }),
  proServiceTtc: numeric("pro_service_ttc", { precision: 12, scale: 2 }),
  planningHt: numeric("planning_ht", { precision: 12, scale: 2 }),
  planningTva: numeric("planning_tva", { precision: 12, scale: 2 }),
  planningTtc: numeric("planning_ttc", { precision: 12, scale: 2 }),
  pmPercentage: numeric("pm_percentage", { precision: 5, scale: 2 }),
  pmNote: text("pm_note"),
  syncedAt: timestamp("synced_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("archidoc_proposal_fees_project_unique").on(table.archidocProjectId),
]);

export const archidocSyncLog = pgTable("archidoc_sync_log", {
  id: serial("id").primaryKey(),
  syncType: text("sync_type").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  completedAt: timestamp("completed_at"),
  recordsUpdated: integer("records_updated").default(0),
  malformedSiretCount: integer("malformed_siret_count").default(0).notNull(),
  errorMessage: text("error_message"),
});

export const archidocSiretIssues = pgTable("archidoc_siret_issues", {
  archidocId: varchar("archidoc_id", { length: 255 }).primaryKey(),
  name: text("name"),
  rawSiret: text("raw_siret").notNull(),
  firstSeenAt: timestamp("first_seen_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  lastSeenAt: timestamp("last_seen_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  lastSyncLogId: integer("last_sync_log_id"),
});

export const emailDocuments = pgTable("email_documents", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  emailMessageId: text("email_message_id").notNull().unique(),
  emailThreadId: text("email_thread_id"),
  emailFrom: text("email_from"),
  emailSubject: text("email_subject"),
  emailReceivedAt: timestamp("email_received_at"),
  emailLink: text("email_link"),
  attachmentFileName: text("attachment_file_name"),
  storageKey: text("storage_key"),
  documentType: text("document_type").notNull().default("unknown"),
  extractionStatus: text("extraction_status").notNull().default("pending"),
  extractedData: jsonb("extracted_data"),
  matchConfidence: numeric("match_confidence", { precision: 5, scale: 2 }),
  matchedFields: jsonb("matched_fields"),
  gmailLabelApplied: boolean("gmail_label_applied").notNull().default(false),
  // Task #531 — attachment-content dedupe. sha256 hex of the PDF bytes,
  // set at capture time; the same bytes arriving via another email are
  // recorded as an entry in additional_sources on the FIRST row instead of
  // creating a duplicate row. Both server-authoritative (omitted from the
  // insert schema so the generic PATCH body cannot touch them).
  contentFingerprint: text("content_fingerprint"),
  additionalSources: jsonb("additional_sources"),
  // Tombstone: set when an operator deletes the mirrored intake document.
  // Blocks mirrorEmailDocumentToIntake from silently recreating the intake
  // row on the next email-document update. NULL = never intentionally deleted.
  intakeDeletedAt: timestamp("intake_deleted_at"),
  // Task #310 — retry bookkeeping for the background email-document
  // processor. Server-authoritative: excluded from insertEmailDocumentSchema
  // so the generic PATCH route cannot manipulate retry state.
  processingAttempts: integer("processing_attempts").notNull().default(0),
  nextProcessAttemptAt: timestamp("next_process_attempt_at"),
  contractorId: integer("contractor_id").references(() => contractors.id),
  devisId: integer("devis_id").references(() => devis.id),
  invoiceId: integer("invoice_id").references(() => invoices.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("email_documents_project_id_idx").on(table.projectId),
  index("email_documents_extraction_status_idx").on(table.extractionStatus),
]);

// Task #503 — persistent processed-message exclusion for the Gmail poll.
// Without label permissions, `-label:` never filters and each poll re-fetched
// the same first 10 messages forever, starving newer mail. Every message is
// recorded here once its disposition is durable; the poll skips recorded ids
// regardless of label state.
export const gmailProcessedMessages = pgTable("gmail_processed_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  messageId: text("message_id").notNull(),
  // Gmail internalDate of the message — powers the durable backfill cursor
  // (poll issues `before:<min(message_date)>` so backlog paging never
  // restarts behind an ever-growing processed prefix).
  messageDate: timestamp("message_date"),
  processedAt: timestamp("processed_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("gmail_processed_messages_user_message_unique").on(table.userId, table.messageId),
]);

// Task #506 — per-message failure counter for the Gmail poll.
// When processMessage() throws for the same message on consecutive polls
// (e.g. a corrupt attachment), errors recur silently every 15 minutes.
// This table tracks the count so the dashboard can surface stuck messages
// and let the architect skip them (audit-noted, never deleted).
export const gmailMessageFailures = pgTable("gmail_message_failures", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  messageId: text("message_id").notNull(),
  failCount: integer("fail_count").notNull().default(1),
  lastFailedAt: timestamp("last_failed_at").notNull(),
  skippedAt: timestamp("skipped_at"),
  skipReason: text("skip_reason"),
}, (table) => [
  unique("gmail_message_failures_user_message_unique").on(table.userId, table.messageId),
]);

export type GmailMessageFailure = typeof gmailMessageFailures.$inferSelect;

export const projectDocuments = pgTable("project_documents", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  storageKey: text("storage_key").notNull(),
  documentType: text("document_type").notNull().default("other"),
  uploadedBy: text("uploaded_by"),
  description: text("description"),
  sourceEmailDocumentId: integer("source_email_document_id").references(() => emailDocuments.id),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("project_documents_project_id_idx").on(table.projectId),
  // Partial unique in SQL (migration 0056: WHERE source_email_document_id IS
  // NOT NULL) — hard backstop so two servers can't file the same emailed
  // attachment twice. Manual uploads carry NULL and never collide.
  uniqueIndex("project_documents_source_email_doc_idx").on(table.sourceEmailDocumentId).where(sql`${table.sourceEmailDocumentId} IS NOT NULL`),
]);

// Unified document intake (Task #229). The single "front door" for every
// financial document: manual uploads AND email attachments land here in a
// `pending` state, before any AI classification/extraction/routing (those are
// later tasks). `analysisState`/`routingState` are deliberately left as plain
// string status columns so downstream tasks can extend the vocabulary without
// a schema migration. `extractedData` is the slot the AI step (#230) will fill;
// `promotedKind`/`promotedId` record which typed record (devis, invoice, …) an
// intake item is eventually promoted into. Email-sourced rows keep a pointer
// back to their `email_documents` provenance row via `sourceEmailDocumentId`.
export const projectIntakeDocuments = pgTable("project_intake_documents", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  source: text("source").notNull().default("manual"),
  contentFingerprint: text("content_fingerprint"),
  analysisState: text("analysis_state").notNull().default("pending"),
  routingState: text("routing_state").notNull().default("unrouted"),
  extractedData: jsonb("extracted_data"),
  sourceEmailDocumentId: integer("source_email_document_id").references(() => emailDocuments.id),
  promotedKind: text("promoted_kind"),
  promotedId: integer("promoted_id"),
  uploadedBy: text("uploaded_by"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("project_intake_documents_project_id_idx").on(table.projectId),
  index("project_intake_documents_analysis_state_idx").on(table.analysisState),
  uniqueIndex("project_intake_documents_source_email_doc_idx").on(table.sourceEmailDocumentId),
]);

// ---------------------------------------------------------------------
// Background ingest & auto-routing (Task #230)
// ---------------------------------------------------------------------
// One queue row per intake document. The sweeper claims `pending` rows
// (lease → `in_flight`), retries with backoff, reclaims stale in-flight
// rows after a crash, and dead-letters after MAX attempts — mirroring
// the proven drive_uploads / pennylane_pushes machinery so we don't
// invent a new pattern. The pipeline (dedup → Gemini classify/extract →
// route into a typed draft) runs inside `attemptIntakeJob`; the intake
// document row itself carries the user-facing analysis/routing state.

// Lifecycle of the OWNING intake document (project_intake_documents):
export const INTAKE_ANALYSIS_STATES = ["pending", "analyzing", "analyzed", "failed"] as const;
export type IntakeAnalysisState = (typeof INTAKE_ANALYSIS_STATES)[number];

export const INTAKE_ROUTING_STATES = ["unrouted", "routed", "duplicate", "parked", "failed"] as const;
export type IntakeRoutingState = (typeof INTAKE_ROUTING_STATES)[number];

// Typed records the pipeline can auto-create a draft in. Situation /
// avenant / RIB are detected but parked for manual routing (later task).
export const INTAKE_PROMOTED_KINDS = ["devis", "invoice"] as const;
export type IntakePromotedKind = (typeof INTAKE_PROMOTED_KINDS)[number];

// Lifecycle of the QUEUE row itself:
export const INTAKE_JOB_STATES = [
  "pending",
  "in_flight",
  "succeeded",
  "failed",
  "dead_letter",
] as const;
export type IntakeJobState = (typeof INTAKE_JOB_STATES)[number];

export const intakeJobs = pgTable("intake_jobs", {
  id: serial("id").primaryKey(),
  intakeDocumentId: integer("intake_document_id")
    .notNull()
    .references(() => projectIntakeDocuments.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  lastAttemptAt: timestamp("last_attempt_at"),
  nextAttemptAt: timestamp("next_attempt_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("intake_jobs_doc_unique").on(table.intakeDocumentId),
  index("intake_jobs_state_next_idx").on(table.state, table.nextAttemptAt),
]);

export const insertIntakeJobSchema = createInsertSchema(intakeJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertIntakeJob = z.infer<typeof insertIntakeJobSchema>;
export type IntakeJob = typeof intakeJobs.$inferSelect;

// ---------------------------------------------------------------------
// Overlap & supersession detection engine (Task #231)
// ---------------------------------------------------------------------
// A per-project background reconciliation pass that detects dangerous
// document relationships — above all a consolidated devis that has
// absorbed earlier individual devis (silent double-counting). It is
// layered: semantic candidate matching (Gemini embeddings + pgvector)
// → deterministic subset-sum screening → Gemini reasoning with
// citations → arithmetic proof + verdict. It produces structured
// "overlap cases" and NEVER changes a financial total or fires a
// user-facing alert (those are downstream tasks).

// Embedding dimension for Gemini `text-embedding-004`. Fixed because the
// pgvector column type is dimension-bound; changing the model means a
// migration. Kept in shared so the embedding service and schema agree.
export const DEVIS_EMBEDDING_DIMENSIONS = 768;

// One cached embedding per devis (the unit of semantic comparison). The
// vector is regenerated only when `contentHash` (a hash of the canonical
// embedding text) changes, so re-runs don't re-call Gemini for unchanged
// documents.
export const documentEmbeddings = pgTable("document_embeddings", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  contentHash: text("content_hash").notNull(),
  model: text("model").notNull(),
  embedding: vector("embedding", { dimensions: DEVIS_EMBEDDING_DIMENSIONS }).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("document_embeddings_devis_unique").on(table.devisId),
  index("document_embeddings_project_idx").on(table.projectId),
]);

export const insertDocumentEmbeddingSchema = createInsertSchema(documentEmbeddings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDocumentEmbedding = z.infer<typeof insertDocumentEmbeddingSchema>;
export type DocumentEmbedding = typeof documentEmbeddings.$inferSelect;

// Relationship the engine proposes between a primary devis and one or
// more member devis. `aggregates`/`contains`/`supersedes` describe a
// consolidator absorbing earlier devis; `duplicate` is an exact re-issue;
// `unrelated` is never persisted (kept for the reasoning enum only).
export const OVERLAP_RELATIONSHIP_TYPES = [
  "supersedes",
  "contains",
  "aggregates",
  "duplicate",
  "unrelated",
] as const;
export type OverlapRelationshipType = (typeof OVERLAP_RELATIONSHIP_TYPES)[number];

// How a case was surfaced. `arithmetic` cases can be proven without any
// model; `semantic` cases come from embedding similarity; `both` when the
// two layers agree on the same membership.
export const OVERLAP_DETECTION_SOURCES = ["semantic", "arithmetic", "both"] as const;
export type OverlapDetectionSource = (typeof OVERLAP_DETECTION_SOURCES)[number];

// Verdict after arithmetic proof. `proven` = the euros reconcile exactly
// (safe to auto-resolve in a later task); `needs_review` = a human must
// judge.
export const OVERLAP_VERDICTS = ["proven", "needs_review"] as const;
export type OverlapVerdict = (typeof OVERLAP_VERDICTS)[number];

// Lifecycle of a case across re-runs. `active` = currently detected;
// `withdrawn` = a prior run raised it but the latest run no longer does
// (append-only audit — we never hard-delete).
export const OVERLAP_CASE_STATUSES = ["active", "withdrawn"] as const;
export type OverlapCaseStatus = (typeof OVERLAP_CASE_STATUSES)[number];

export const overlapCases = pgTable("overlap_cases", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  // Stable identity hash of (projectId, relationshipType, primaryDevisId,
  // sorted memberDevisIds). Re-runs upsert by this key instead of
  // duplicating. UNIQUE so concurrent runs collide rather than fork.
  caseKey: text("case_key").notNull(),
  relationshipType: text("relationship_type").notNull(),
  primaryDevisId: integer("primary_devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  // Sorted devis ids the primary absorbs/supersedes. jsonb (number[]).
  memberDevisIds: jsonb("member_devis_ids").$type<number[]>().notNull(),
  detectionSource: text("detection_source").notNull(),
  // 0..1 — the reasoning pass's confidence (1 for a clean arithmetic
  // proof with no model involvement).
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
  verdict: text("verdict").notNull(),
  // { primaryCents, memberCents[], sumCents, deltaCents, reconciles }.
  arithmeticProof: jsonb("arithmetic_proof").$type<{
    primaryCents: number;
    memberCents: number[];
    sumCents: number;
    deltaCents: number;
    reconciles: boolean;
  }>(),
  // [{ devisId, devisCode, lineNumber, description, totalHt }] — NEVER
  // banking/sensitive fields (see the portal whitelist convention).
  citations: jsonb("citations").$type<Array<{
    devisId: number;
    devisCode: string | null;
    lineNumber: number | null;
    description: string;
    totalHt: string | null;
  }>>().notNull(),
  reasoning: text("reasoning"),
  status: text("status").notNull().default("active"),
  lastSeenAt: timestamp("last_seen_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  withdrawnAt: timestamp("withdrawn_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("overlap_cases_key_unique").on(table.caseKey),
  index("overlap_cases_project_idx").on(table.projectId),
  index("overlap_cases_project_status_idx").on(table.projectId, table.status),
  index("overlap_cases_primary_devis_idx").on(table.primaryDevisId),
]);

export const insertOverlapCaseSchema = createInsertSchema(overlapCases).omit({
  id: true,
  lastSeenAt: true,
  withdrawnAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOverlapCase = z.infer<typeof insertOverlapCaseSchema>;
export type OverlapCase = typeof overlapCases.$inferSelect;

// Queue row for the per-project reconciliation run. One row per project
// (UNIQUE) so multiple document arrivals coalesce into a single pending
// run. Mirrors the intake_jobs / drive_uploads retry machinery.
export const RECONCILIATION_JOB_STATES = [
  "pending",
  "in_flight",
  "succeeded",
  "failed",
  "dead_letter",
] as const;
export type ReconciliationJobState = (typeof RECONCILIATION_JOB_STATES)[number];

export const reconciliationJobs = pgTable("reconciliation_jobs", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  lastAttemptAt: timestamp("last_attempt_at"),
  nextAttemptAt: timestamp("next_attempt_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("reconciliation_jobs_project_unique").on(table.projectId),
  index("reconciliation_jobs_state_next_idx").on(table.state, table.nextAttemptAt),
]);

export const insertReconciliationJobSchema = createInsertSchema(reconciliationJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertReconciliationJob = z.infer<typeof insertReconciliationJobSchema>;
export type ReconciliationJob = typeof reconciliationJobs.$inferSelect;

// Task #232 — accounting state of a devis (see devis.accountingState).
export const ACCOUNTING_STATES = ["provisional", "active", "superseded"] as const;
export type AccountingState = (typeof ACCOUNTING_STATES)[number];

// Why each accounting-state transition happened. Append-only audit — every
// row in accountingStateChanges carries exactly one of these.
//   ingest                 — created `provisional` on PDF upload / intake.
//   reconciliation_promote — a clean reconciliation pass cleared
//                            provisional → active (no unresolved overlap).
//   proven_supersede       — arithmetic proof folded this devis into another
//                            (auto-applied; safe because the euros reconcile).
//   human_confirm          — an architect confirmed an overlap → superseded.
//   human_dismiss          — an architect dismissed an overlap → kept active.
//   human_replace          — Task #593: an architect explicitly marked this
//                            devis as replaced by a revised same-reference
//                            devis (duplicate-reference resolution).
export const ACCOUNTING_STATE_CHANGE_REASONS = [
  "ingest",
  "reconciliation_promote",
  "proven_supersede",
  "human_confirm",
  "human_dismiss",
  "human_replace",
] as const;
export type AccountingStateChangeReason = (typeof ACCOUNTING_STATE_CHANGE_REASONS)[number];

// Append-only audit of every accounting-state transition. NEVER updated or
// deleted — the latest row per devis is the current rationale. Mirrors the
// document_advisories / overlap_cases append-only convention. `overlapCaseId`
// links a supersede/confirm/dismiss to the case that drove it; `actorUserId`
// is NULL for automatic (ingest / reconciliation / proof) transitions.
export const accountingStateChanges = pgTable("accounting_state_changes", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  reason: text("reason").notNull(),
  overlapCaseId: integer("overlap_case_id").references(() => overlapCases.id, { onDelete: "set null" }),
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  note: text("note"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("accounting_state_changes_devis_idx").on(table.devisId),
  index("accounting_state_changes_project_idx").on(table.projectId),
  index("accounting_state_changes_case_idx").on(table.overlapCaseId),
]);

export const insertAccountingStateChangeSchema = createInsertSchema(accountingStateChanges).omit({
  id: true,
  createdAt: true,
});
export type InsertAccountingStateChange = z.infer<typeof insertAccountingStateChangeSchema>;
export type AccountingStateChange = typeof accountingStateChanges.$inferSelect;

// Task #346 — append-only audit of every "reopen for review" action.
// Confirming an AI-extracted draft moves it draft → pending; reopening is
// the explicit reverse transition (pending → draft) so an architect can
// amend a draft more than once. Every reopen records who did it and when.
// NEVER updated or deleted — mirrors the accounting_state_changes
// append-only convention. `entityType`/`entityId` is a polymorphic
// reference (devis or invoice), so there is deliberately no FK; the
// composite index keeps per-record history lookups cheap.
export const DRAFT_REOPEN_ENTITY_TYPES = ["devis", "invoice"] as const;
export type DraftReopenEntityType = (typeof DRAFT_REOPEN_ENTITY_TYPES)[number];

export const draftReopenEvents = pgTable("draft_reopen_events", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  previousStatus: text("previous_status").notNull(),
  reopenedBy: text("reopened_by"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("draft_reopen_events_entity_idx").on(table.entityType, table.entityId),
]);

export const insertDraftReopenEventSchema = createInsertSchema(draftReopenEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertDraftReopenEvent = z.infer<typeof insertDraftReopenEventSchema>;
export type DraftReopenEvent = typeof draftReopenEvents.$inferSelect;

export const projectCommunications = pgTable("project_communications", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("general"),
  recipientType: text("recipient_type").notNull(),
  recipientEmail: text("recipient_email"),
  recipientName: text("recipient_name"),
  subject: text("subject").notNull(),
  body: text("body"),
  attachmentStorageKeys: jsonb("attachment_storage_keys"),
  status: text("status").notNull().default("draft"),
  sentAt: timestamp("sent_at"),
  emailMessageId: text("email_message_id"),
  emailThreadId: text("email_thread_id"),
  dedupeKey: text("dedupe_key"),
  // Task #466 — which architect's linked Gmail account (users.id) actually
  // sent this email. Null = legacy sends through the shared connector
  // mailbox; the payment-reply scanner probes those in every linked inbox,
  // while owned rows are scanned only by their owner's client.
  sentViaUserId: integer("sent_via_user_id").references(() => users.id, { onDelete: "set null" }),
  relatedCertificatId: integer("related_certificat_id").references(() => certificats.id),
  relatedInvoiceId: integer("related_invoice_id").references(() => invoices.id),
  // Task #529 — visibility-only archive flag. Archived rows drop out of the
  // hub's default view (and its counters) but are never deleted; the
  // Archives toggle shows them. Server-written only via the archive routes.
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("project_communications_project_id_idx").on(table.projectId),
  uniqueIndex("project_communications_dedupe_key_idx").on(table.dedupeKey),
]);

export const paymentReminders = pgTable("payment_reminders", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").references(() => invoices.id),
  certificatId: integer("certificat_id").references(() => certificats.id),
  contractorId: integer("contractor_id").references(() => contractors.id),
  recipientType: text("recipient_type").notNull(),
  recipientEmail: text("recipient_email"),
  reminderType: text("reminder_type").notNull(),
  scheduledDate: date("scheduled_date").notNull(),
  status: text("status").notNull().default("scheduled"),
  sentAt: timestamp("sent_at"),
  responseReceivedAt: timestamp("response_received_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("payment_reminders_project_id_idx").on(table.projectId),
  index("payment_reminders_status_date_idx").on(table.status, table.scheduledDate),
]);

export const clientPaymentEvidence = pgTable("client_payment_evidence", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").references(() => invoices.id),
  certificatId: integer("certificat_id").references(() => certificats.id),
  uploadedByEmail: text("uploaded_by_email"),
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name").notNull(),
  notes: text("notes"),
  uploadedAt: timestamp("uploaded_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("client_payment_evidence_project_id_idx").on(table.projectId),
]);

export const documentAdvisories = pgTable("document_advisories", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").references(() => devis.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  field: text("field"),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  source: text("source").notNull().default("extractor"),
  raisedAt: timestamp("raised_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  resolvedAt: timestamp("resolved_at"),
  acknowledgedAt: timestamp("acknowledged_at"),
  acknowledgedBy: text("acknowledged_by"),
}, (table) => [
  index("document_advisories_devis_id_idx").on(table.devisId),
  index("document_advisories_invoice_id_idx").on(table.invoiceId),
  index("document_advisories_devis_severity_idx").on(table.devisId, table.severity),
  index("document_advisories_invoice_severity_idx").on(table.invoiceId, table.severity),
  index("document_advisories_code_idx").on(table.code),
  check(
    "document_advisories_subject_check",
    sql`(${table.devisId} IS NOT NULL) <> (${table.invoiceId} IS NOT NULL)`,
  ),
]);

export const devisChecks = pgTable("devis_checks", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  origin: text("origin").notNull(),
  lineItemId: integer("line_item_id").references(() => devisLineItems.id, { onDelete: "set null" }),
  status: text("status").notNull().default("open"),
  query: text("query").notNull(),
  resolutionNote: text("resolution_note"),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  resolvedAt: timestamp("resolved_at"),
  resolvedByUserId: integer("resolved_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("devis_checks_devis_id_idx").on(table.devisId),
  index("devis_checks_status_idx").on(table.status),
  uniqueIndex("devis_checks_line_item_unique_idx")
    .on(table.devisId, table.lineItemId)
    .where(sql`${table.origin} = 'line_item' AND ${table.lineItemId} IS NOT NULL`),
  check(
    "devis_checks_origin_check",
    sql`${table.origin} IN ('line_item', 'general')`,
  ),
  check(
    "devis_checks_status_check",
    sql`${table.status} IN ('open', 'awaiting_contractor', 'awaiting_architect', 'resolved', 'dropped')`,
  ),
]);

export const devisCheckMessages = pgTable("devis_check_messages", {
  id: serial("id").primaryKey(),
  checkId: integer("check_id").notNull().references(() => devisChecks.id, { onDelete: "cascade" }),
  authorType: text("author_type").notNull(),
  authorUserId: integer("author_user_id").references(() => users.id),
  authorEmail: text("author_email"),
  authorName: text("author_name"),
  body: text("body").notNull(),
  channel: text("channel").notNull().default("portal"),
  emailMessageId: text("email_message_id"),
  emailThreadId: text("email_thread_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("devis_check_messages_check_id_idx").on(table.checkId),
  check(
    "devis_check_messages_author_type_check",
    sql`${table.authorType} IN ('architect', 'contractor', 'system')`,
  ),
  check(
    "devis_check_messages_channel_check",
    sql`${table.channel} IN ('portal', 'email', 'system')`,
  ),
]);

export const devisCheckTokens = pgTable("devis_check_tokens", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  contractorId: integer("contractor_id").notNull().references(() => contractors.id),
  contractorEmail: text("contractor_email").notNull(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  revokedAt: timestamp("revoked_at"),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  uniqueIndex("devis_check_tokens_token_hash_idx").on(table.tokenHash),
  index("devis_check_tokens_devis_id_idx").on(table.devisId),
  uniqueIndex("devis_check_tokens_one_active_idx")
    .on(table.devisId)
    .where(sql`${table.revokedAt} IS NULL`),
]);

export const webhookEvents = pgTable("webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull(),
  processedAt: timestamp("processed_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("webhook_events_event_type_idx").on(table.eventType),
  index("webhook_events_processed_at_idx").on(table.processedAt),
]);

// Token-bucket store for the Postgres-backed rate limiter
// (server/middleware/rate-limit.ts). Declared here so the deploy schema diff
// matches what the runtime middleware creates on demand.
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const templateAssets = pgTable("template_assets", {
  id: serial("id").primaryKey(),
  assetType: text("asset_type").notNull().unique(),
  fileName: text("file_name").notNull(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type"),
  uploadedAt: timestamp("uploaded_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Task #550 — small key/value store for operator-configurable settings
// (first use: email-document purge retention window in days).
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const aiModelSettings = pgTable("ai_model_settings", {
  id: serial("id").primaryKey(),
  taskType: text("task_type").notNull().unique(),
  provider: text("provider").notNull().default("gemini"),
  modelId: text("model_id").notNull().default("gemini-2.0-flash"),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const benchmarkTags = pgTable("benchmark_tags", {
  id: serial("id").primaryKey(),
  label: text("label").notNull().unique(),
  category: text("category"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const benchmarkDocuments = pgTable("benchmark_documents", {
  id: serial("id").primaryKey(),
  source: text("source").notNull().default("standalone"),
  sourceDevisId: integer("source_devis_id").references(() => devis.id, { onDelete: "set null" }),
  contractorId: integer("contractor_id").references(() => contractors.id),
  externalContractorName: text("external_contractor_name"),
  externalSiret: text("external_siret"),
  documentDate: date("document_date"),
  notes: text("notes"),
  pdfStorageKey: text("pdf_storage_key"),
  pdfFileName: text("pdf_file_name"),
  totalHt: numeric("total_ht", { precision: 12, scale: 2 }),
  aiExtractedData: jsonb("ai_extracted_data"),
  aiConfidence: integer("ai_confidence"),
  validationWarnings: jsonb("validation_warnings"),
  needsReview: boolean("needs_review").notNull().default(false),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("benchmark_documents_source_devis_unique").on(table.sourceDevisId),
  index("benchmark_documents_contractor_idx").on(table.contractorId),
  index("benchmark_documents_date_idx").on(table.documentDate),
  check(
    "benchmark_documents_contractor_identity_check",
    sql`(${table.contractorId} IS NOT NULL) OR (${table.externalContractorName} IS NOT NULL AND length(trim(${table.externalContractorName})) > 0)`,
  ),
]);

export const benchmarkItems = pgTable("benchmark_items", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => benchmarkDocuments.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  description: text("description").notNull(),
  rawQuantity: numeric("raw_quantity", { precision: 12, scale: 3 }),
  rawUnit: text("raw_unit"),
  rawUnitPriceHt: numeric("raw_unit_price_ht", { precision: 12, scale: 2 }),
  rawTotalHt: numeric("raw_total_ht", { precision: 12, scale: 2 }),
  normalizedUnit: text("normalized_unit"),
  normalizedUnitPriceHt: numeric("normalized_unit_price_ht", { precision: 12, scale: 2 }),
  aiConfidence: integer("ai_confidence"),
  needsReview: boolean("needs_review").notNull().default(false),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("benchmark_items_document_id_idx").on(table.documentId),
  index("benchmark_items_normalized_unit_idx").on(table.normalizedUnit),
  index("benchmark_items_needs_review_idx").on(table.needsReview),
]);

export const benchmarkItemTags = pgTable("benchmark_item_tags", {
  itemId: integer("item_id").notNull().references(() => benchmarkItems.id, { onDelete: "cascade" }),
  tagId: integer("tag_id").notNull().references(() => benchmarkTags.id, { onDelete: "cascade" }),
}, (table) => [
  unique("benchmark_item_tags_unique").on(table.itemId, table.tagId),
  index("benchmark_item_tags_tag_id_idx").on(table.tagId),
]);

export const insertBenchmarkTagSchema = createInsertSchema(benchmarkTags).omit({
  id: true,
  createdAt: true,
});
export const insertBenchmarkDocumentSchema = createInsertSchema(benchmarkDocuments).omit({
  id: true,
  createdAt: true,
});
export const insertBenchmarkItemSchema = createInsertSchema(benchmarkItems).omit({
  id: true,
  createdAt: true,
});

export type BenchmarkTag = typeof benchmarkTags.$inferSelect;
export type InsertBenchmarkTag = z.infer<typeof insertBenchmarkTagSchema>;
export type BenchmarkDocument = typeof benchmarkDocuments.$inferSelect;
export type InsertBenchmarkDocument = z.infer<typeof insertBenchmarkDocumentSchema>;
export type BenchmarkItem = typeof benchmarkItems.$inferSelect;
export type InsertBenchmarkItem = z.infer<typeof insertBenchmarkItemSchema>;
export type BenchmarkItemTag = typeof benchmarkItemTags.$inferSelect;

export { conversations, messages } from "./models/chat";

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
});

export const insertContractorSchema = createInsertSchema(contractors).omit({
  id: true,
  createdAt: true,
  archidocPartnerType: true,
  archidocOrphanedAt: true,
}).extend({
  siret: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value, ctx) => {
      if (value === null || value === undefined) return null;
      const trimmed = value.trim();
      if (trimmed.length === 0) return null;
      const cleaned = trimmed.replace(/[\s.\-_/]/g, "");
      if (!/^\d{14}$/.test(cleaned)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "SIRET must be exactly 14 digits",
        });
        return z.NEVER;
      }
      return cleaned;
    }),
  // Task #463 — contractor default TVA rate: strict scale-2 decimal, 0–100.
  // NULL = standard 20%. Same strictness rationale as the marché fields.
  defaultTvaRatePercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, "TVA rate must be a decimal with at most 2 decimal places")
    .refine((v) => { const n = parseFloat(v); return n >= 0 && n <= 100; }, {
      message: "TVA rate must be between 0 and 100",
    })
    .nullable()
    .optional(),
});

export const insertLotSchema = createInsertSchema(lots).omit({
  id: true,
  createdAt: true,
});

export const insertLotCatalogSchema = createInsertSchema(lotCatalog).omit({
  id: true,
  createdAt: true,
}).extend({
  code: z
    .string()
    .trim()
    .min(1, "Code is required")
    .max(16, "Code must be 16 characters or less")
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]+$/, "Code must contain only A-Z and 0-9")),
  descriptionFr: z.string().trim().min(1, "Description is required").max(200),
  descriptionUk: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional(),
});

export const insertMarcheSchema = createInsertSchema(marches, {
  // Task #462 — acompte recoupment configuration must be well-formed at the
  // boundary: an unknown rule or out-of-range percent would silently change
  // how a paid deposit is recovered on certificats.
  acompteRecoupmentRule: z.enum(["asap", "percent", "progress_threshold"]).optional(),
  // Strict scale-2 decimal strings: `parseFloat` would accept trailing junk
  // ("10oops") and >2 decimals that numeric(5,2) silently rounds (0.001 →
  // 0.00 turns the percent rule into its full-recovery fallback). Require
  // the exact DB-compatible representation, then range-check the value.
  acompteRecoupmentPercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, "Recoupment percent must be a decimal with at most 2 decimal places")
    .refine((v) => { const n = parseFloat(v); return n > 0 && n <= 100; }, {
      message: "Recoupment percent must be between 0 (exclusive) and 100",
    })
    .nullable()
    .optional(),
  acompteRecoupmentThresholdPercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, "Recoupment threshold must be a decimal with at most 2 decimal places")
    .refine((v) => { const n = parseFloat(v); return n >= 0 && n <= 100; }, {
      message: "Recoupment threshold must be between 0 and 100",
    })
    .nullable()
    .optional(),
  // Task #463 — contract TVA rate: strict scale-2 decimal, 0–100. NULL means
  // "fall back to contractor default / standard 20%".
  tvaRatePercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, "TVA rate must be a decimal with at most 2 decimal places")
    .refine((v) => { const n = parseFloat(v); return n >= 0 && n <= 100; }, {
      message: "TVA rate must be between 0 and 100",
    })
    .nullable()
    .optional(),
}).omit({
  id: true,
  createdAt: true,
});

export const insertDevisSchema = createInsertSchema(devis).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  closureState: true,
  closedAt: true,
  closedByUserId: true,
  closureMarcheId: true,
  closureProjectId: true,
  closureContractorId: true,
  closureReceptionDate: true,
});

export const insertDevisLineItemSchema = createInsertSchema(devisLineItems, {
  // Override the generic JSON shape drizzle-zod infers for jsonb columns
  // with the narrowed bbox shape declared via .$type<>() on the column.
  // Keeps InsertDevisLineItem assignable to drizzle's $inferInsert and
  // forces Zod to validate the four required numeric coordinates.
  pdfBbox: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }).nullable().optional(),
}).omit({
  id: true,
});

export const insertAvenantSchema = createInsertSchema(avenants).omit({
  id: true,
  createdAt: true,
});

export const insertInvoiceSchema = createInsertSchema(invoices).omit({
  id: true,
  createdAt: true,
});

export const insertSituationSchema = createInsertSchema(situations).omit({
  id: true,
  createdAt: true,
  // Task #449 — source-PDF provenance is server-written only (attached by
  // the intake pipeline or the reviewed attach flow, confirmed by dedicated
  // endpoints). Omitted here so the generic create/PATCH surfaces cannot
  // set or clear it (see devis-state-machine seal rationale).
  sourceStorageKey: true,
  sourceFileName: true,
  sourceUploadedAt: true,
  sourceUploadedBy: true,
  sourceConfirmedAt: true,
  sourceConfirmedBy: true,
  sourceIntakeDocumentId: true,
});

export const insertMarcheDocumentSchema = createInsertSchema(marcheDocuments).omit({
  id: true,
  createdAt: true,
  // Confirmation state is server-written only (confirm endpoint / reviewed
  // attach flow).
  status: true,
  confirmedAt: true,
  confirmedBy: true,
});
export type InsertMarcheDocument = z.infer<typeof insertMarcheDocumentSchema>;
export type MarcheDocument = typeof marcheDocuments.$inferSelect;

export const insertSituationLineSchema = createInsertSchema(situationLines).omit({
  id: true,
});

export const insertCertificatSchema = createInsertSchema(certificats).omit({
  id: true,
  createdAt: true,
  // Task #451 — seal fields are written exactly once by the seal service;
  // they must never be creatable/patchable through the generic API schemas.
  pdfStorageKey: true,
  pdfFileName: true,
  issuedAt: true,
  issuanceSnapshot: true,
  // Server-managed optimistic-concurrency counter — never client-settable.
  version: true,
  // Task #457 — reissue lineage is set exclusively by the reissue route.
  reissuedFromCertificatId: true,
  // Task #491 — acompte linkage is set exclusively by the dedicated
  // acompte-certificat route; never via the generic create/PATCH API.
  acompteDevisId: true,
});

export const insertCertificatSourceSchema = createInsertSchema(certificatSources).omit({
  id: true,
  createdAt: true,
});
export const insertFeeSchema = createInsertSchema(fees).omit({
  id: true,
  createdAt: true,
});

export const insertFeeEntrySchema = createInsertSchema(feeEntries).omit({
  id: true,
  createdAt: true,
});

export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Contractor = typeof contractors.$inferSelect;
export type InsertContractor = z.infer<typeof insertContractorSchema>;
export type Lot = typeof lots.$inferSelect;
export type InsertLot = z.infer<typeof insertLotSchema>;
export type LotCatalog = typeof lotCatalog.$inferSelect;
export type InsertLotCatalog = z.infer<typeof insertLotCatalogSchema>;
export type Marche = typeof marches.$inferSelect;
export type InsertMarche = z.infer<typeof insertMarcheSchema>;
export type Devis = typeof devis.$inferSelect;
export type InsertDevis = z.infer<typeof insertDevisSchema>;
export type DevisLineItem = typeof devisLineItems.$inferSelect;
export type InsertDevisLineItem = z.infer<typeof insertDevisLineItemSchema>;
export type Avenant = typeof avenants.$inferSelect;
export type InsertAvenant = z.infer<typeof insertAvenantSchema>;
export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Situation = typeof situations.$inferSelect;
export type InsertSituation = z.infer<typeof insertSituationSchema>;
export type SituationLine = typeof situationLines.$inferSelect;
export type InsertSituationLine = z.infer<typeof insertSituationLineSchema>;
export type Certificat = typeof certificats.$inferSelect;
export type InsertCertificat = z.infer<typeof insertCertificatSchema>;

// Task #465 — payment-ledger request schema. Strict scale-2 amount, closed
// method vocabulary; `source` and timestamps are server-set.
export const insertCertificatPaymentSchema = createInsertSchema(certificatPayments)
  .omit({
    id: true,
    certificatId: true,
    source: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    datePaid: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide (AAAA-MM-JJ)"),
    amount: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,2})?$/, "Montant invalide (2 décimales max)")
      .refine((v) => parseFloat(v) > 0, "Le montant doit être positif"),
    method: z.enum(["virement", "cheque", "autre"]),
    reference: z.string().trim().max(200).nullable().optional(),
    loggedBy: z.string().trim().max(200).nullable().optional(),
  });

export type CertificatPayment = typeof certificatPayments.$inferSelect;
export type InsertCertificatPayment = z.infer<typeof insertCertificatPaymentSchema>;
export type CertificatPaymentAudit = typeof certificatPaymentAudits.$inferSelect;

// Task #466 — payment suggestions detected from client "paid" replies.
// Rows are created ONLY by the Gmail reply-scan (server-side); the API
// mutates status via confirm/dismiss, so no client insert schema exists.
export type CertificatPaymentSuggestion = typeof certificatPaymentSuggestions.$inferSelect;
export type InsertCertificatPaymentSuggestion = typeof certificatPaymentSuggestions.$inferInsert;

// Overrides the architect may apply when confirming a suggestion. Same
// strictness as the manual ledger entry; everything optional — defaults
// come from the suggestion itself.
export const confirmPaymentSuggestionSchema = z.object({
  datePaid: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/)
    .refine((v) => parseFloat(v) > 0, "amount must be positive")
    .optional(),
  method: z.enum(["virement", "cheque", "autre"]).optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  reviewedBy: z.string().trim().max(200).optional(),
});
export type ConfirmPaymentSuggestion = z.infer<typeof confirmPaymentSuggestionSchema>;
export type Fee = typeof fees.$inferSelect;
export type InsertFee = z.infer<typeof insertFeeSchema>;
export type FeeEntry = typeof feeEntries.$inferSelect;
export type InsertFeeEntry = z.infer<typeof insertFeeEntrySchema>;

export const insertDesignContractSchema = createInsertSchema(designContracts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDesignContractMilestoneSchema = createInsertSchema(designContractMilestones).omit({
  id: true,
  createdAt: true,
});

export type DesignContract = typeof designContracts.$inferSelect;
export type InsertDesignContract = z.infer<typeof insertDesignContractSchema>;
export type DesignContractMilestone = typeof designContractMilestones.$inferSelect;
export type InsertDesignContractMilestone = z.infer<typeof insertDesignContractMilestoneSchema>;

export const insertEmailDocumentSchema = createInsertSchema(emailDocuments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  // Server-authoritative retry bookkeeping (Task #310) — must not be
  // settable through the generic PATCH body.
  processingAttempts: true,
  nextProcessAttemptAt: true,
  // Task #531 — dedupe bookkeeping is capture-time server state.
  contentFingerprint: true,
  additionalSources: true,
});

export const insertProjectDocumentSchema = createInsertSchema(projectDocuments).omit({
  id: true,
  createdAt: true,
});

export const insertProjectIntakeDocumentSchema = createInsertSchema(projectIntakeDocuments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertProjectCommunicationSchema = createInsertSchema(projectCommunications).omit({
  id: true,
  createdAt: true,
  // Task #529 — archive flag is server-written only (archive routes);
  // a create payload must never smuggle it in.
  archivedAt: true,
});

export const insertPaymentReminderSchema = createInsertSchema(paymentReminders).omit({
  id: true,
  createdAt: true,
});

export const insertClientPaymentEvidenceSchema = createInsertSchema(clientPaymentEvidence).omit({
  id: true,
  uploadedAt: true,
});

export const insertDevisCheckSchema = createInsertSchema(devisChecks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  resolvedByUserId: true,
});

export const insertDevisCheckMessageSchema = createInsertSchema(devisCheckMessages).omit({
  id: true,
  createdAt: true,
});

export const insertDevisCheckTokenSchema = createInsertSchema(devisCheckTokens).omit({
  id: true,
  createdAt: true,
  revokedAt: true,
  lastUsedAt: true,
});

export type DevisCheck = typeof devisChecks.$inferSelect;
export type InsertDevisCheck = z.infer<typeof insertDevisCheckSchema>;
export type DevisCheckMessage = typeof devisCheckMessages.$inferSelect;

export type InboxContractorResponseRow = {
  checkId: number;
  checkQuery: string;
  checkUpdatedAt: Date;
  devisId: number;
  devisCode: string | null;
  projectId: number;
  projectName: string;
  contractorName: string | null;
  latestMessageBody: string | null;
  latestMessageAt: Date | null;
  latestMessageAuthor: string | null;
};
export type InsertDevisCheckMessage = z.infer<typeof insertDevisCheckMessageSchema>;
export type DevisCheckToken = typeof devisCheckTokens.$inferSelect;
export type InsertDevisCheckToken = z.infer<typeof insertDevisCheckTokenSchema>;

export type ArchidocProject = typeof archidocProjects.$inferSelect;
export type ArchidocContractor = typeof archidocContractors.$inferSelect;
export type ArchidocTrade = typeof archidocTrades.$inferSelect;
export type ArchidocProposalFee = typeof archidocProposalFees.$inferSelect;
export type ArchidocSyncLogEntry = typeof archidocSyncLog.$inferSelect;
export type ArchidocSiretIssue = typeof archidocSiretIssues.$inferSelect;

export type EmailDocument = typeof emailDocuments.$inferSelect;
export type InsertEmailDocument = z.infer<typeof insertEmailDocumentSchema>;
export type ProjectDocument = typeof projectDocuments.$inferSelect;
export type InsertProjectDocument = z.infer<typeof insertProjectDocumentSchema>;
export type ProjectIntakeDocument = typeof projectIntakeDocuments.$inferSelect;
export type InsertProjectIntakeDocument = z.infer<typeof insertProjectIntakeDocumentSchema>;
export type ProjectCommunication = typeof projectCommunications.$inferSelect;
export type InsertProjectCommunication = z.infer<typeof insertProjectCommunicationSchema>;
export type PaymentReminder = typeof paymentReminders.$inferSelect;
export type InsertPaymentReminder = z.infer<typeof insertPaymentReminderSchema>;
export type ClientPaymentEvidence = typeof clientPaymentEvidence.$inferSelect;
export type InsertClientPaymentEvidence = z.infer<typeof insertClientPaymentEvidenceSchema>;

export const insertDocumentAdvisorySchema = createInsertSchema(documentAdvisories).omit({
  id: true,
  raisedAt: true,
});
export type DocumentAdvisory = typeof documentAdvisories.$inferSelect;
export type InsertDocumentAdvisory = z.infer<typeof insertDocumentAdvisorySchema>;

export const insertTemplateAssetSchema = createInsertSchema(templateAssets).omit({
  id: true,
  uploadedAt: true,
});
export type TemplateAsset = typeof templateAssets.$inferSelect;
export type InsertTemplateAsset = z.infer<typeof insertTemplateAssetSchema>;

export const insertAiModelSettingSchema = createInsertSchema(aiModelSettings).omit({
  id: true,
  updatedAt: true,
});
export type AiModelSetting = typeof aiModelSettings.$inferSelect;
export type InsertAiModelSetting = z.infer<typeof insertAiModelSettingSchema>;

export const devisTranslations = pgTable("devis_translations", {
  devisId: integer("devis_id")
    .primaryKey()
    .references(() => devis.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  provider: text("provider"),
  modelId: text("model_id"),
  headerTranslated: jsonb("header_translated"),
  lineTranslations: jsonb("line_translations"),
  errorMessage: text("error_message"),
  translatedPdfStorageKey: text("translated_pdf_storage_key"),
  combinedPdfStorageKey: text("combined_pdf_storage_key"),
  // Monotonic counter bumped (atomically with clearing the two cache keys
  // above) on every per-line context save. PDF cache publication is a
  // conditional UPDATE guarded by this version, so a stale key can never be
  // (re)published — see server/services/devis-line-context.ts.
  contextsVersion: integer("contexts_version").notNull().default(0),
  approvedAt: timestamp("approved_at"),
  approvedBy: integer("approved_by"),
  approvedByEmail: text("approved_by_email"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const devisTranslationLineSchema = z.object({
  lineNumber: z.number().int().nonnegative(),
  originalDescription: z.string(),
  translation: z.string(),
  explanation: z.string().nullable().optional(),
  edited: z.boolean().optional(),
});

export const DEVIS_TRANSLATION_STATUSES = [
  "pending",
  "processing",
  "draft",
  "edited",
  "finalised",
  "failed",
] as const;
export type DevisTranslationStatus = (typeof DEVIS_TRANSLATION_STATUSES)[number];

export function isTranslationReady(status: string | null | undefined): boolean {
  return status === "draft" || status === "edited" || status === "finalised";
}

export const devisTranslationHeaderSchema = z.object({
  description: z.string().nullable().optional(),
  descriptionExplanation: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
});

export type DevisTranslationLine = z.infer<typeof devisTranslationLineSchema>;
export type DevisTranslationHeader = z.infer<typeof devisTranslationHeaderSchema>;

export const insertDevisTranslationSchema = createInsertSchema(devisTranslations).omit({
  createdAt: true,
  updatedAt: true,
});
export type DevisTranslation = typeof devisTranslations.$inferSelect;
export type InsertDevisTranslation = z.infer<typeof insertDevisTranslationSchema>;

/**
 * Per-line rich-text "context" documents rendered into the translated
 * devis PDF. Keyed by the STABLE devis_line_items.id (NOT lineNumber, and
 * deliberately NOT stored inside devis_translations.lineTranslations) so a
 * force re-translation — which rebuilds the lineTranslations jsonb — can
 * never wipe an architect's context content.
 *
 * `document` holds a validated rich-text JSON document (see
 * shared/context-doc.ts for the strict schema: paragraphs, bold/italic,
 * lists, https/mailto links, and image nodes referencing owned assets).
 *
 * `revision` implements optimistic concurrency: every save must present
 * the revision it was based on; a mismatch is rejected with 409 so two
 * concurrent editors cannot silently overwrite each other.
 */
export const devisLineContexts = pgTable("devis_line_contexts", {
  id: serial("id").primaryKey(),
  devisLineItemId: integer("devis_line_item_id")
    .notNull()
    .unique()
    .references(() => devisLineItems.id, { onDelete: "cascade" }),
  devisId: integer("devis_id")
    .notNull()
    .references(() => devis.id, { onDelete: "cascade" }),
  document: jsonb("document").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("devis_line_contexts_devis_id_idx").on(table.devisId),
]);

/**
 * Ownership registry for images uploaded into a line context. The rich
 * document references assets by id only; at render time the server
 * verifies each referenced asset belongs to the same devis line before
 * inlining its bytes as a base64 data URI. Storage keys never appear in
 * user-editable JSON.
 */
export const devisLineContextAssets = pgTable("devis_line_context_assets", {
  id: serial("id").primaryKey(),
  devisLineItemId: integer("devis_line_item_id")
    .notNull()
    .references(() => devisLineItems.id, { onDelete: "cascade" }),
  devisId: integer("devis_id")
    .notNull()
    .references(() => devis.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("devis_line_context_assets_line_item_idx").on(table.devisLineItemId),
]);

export const insertDevisLineContextSchema = createInsertSchema(devisLineContexts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertDevisLineContextAssetSchema = createInsertSchema(devisLineContextAssets).omit({
  id: true,
  createdAt: true,
});
export type DevisLineContext = typeof devisLineContexts.$inferSelect;
export type InsertDevisLineContext = z.infer<typeof insertDevisLineContextSchema>;

/**
 * One AI-generated cost-analysis / value-engineering appendix per devis
 * (Task #378). `rawText` is the architect-editable markdown; `document` is
 * the server-parsed, validated AST (shared/cost-analysis-doc.ts) that the
 * PDF serializer renders. Only status='confirmed' analyses render in
 * outbound PDFs (draft → review/edit → confirm, mirroring the AI data-entry
 * convention). `revision` implements optimistic concurrency like
 * devis_line_contexts.
 */
export const devisCostAnalyses = pgTable("devis_cost_analyses", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id")
    .notNull()
    .unique()
    .references(() => devis.id, { onDelete: "cascade" }),
  rawText: text("raw_text").notNull(),
  document: jsonb("document").notNull(),
  warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
  status: text("status").notNull().default("draft"),
  revision: integer("revision").notNull().default(1),
  // Task #381 — SHA-256 fingerprint of the quotation data (line items +
  // header amounts + lot) this analysis was generated from. Compared
  // against the freshly computed fingerprint to warn when the quotation
  // changed after the analysis was confirmed. NULL = generated before
  // this column existed (staleness unknown).
  quotationFingerprint: text("quotation_fingerprint"),
  modelId: text("model_id"),
  promptVersion: integer("prompt_version"),
  generatedAt: timestamp("generated_at"),
  updatedByEmail: text("updated_by_email"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const DEVIS_COST_ANALYSIS_STATUSES = ["draft", "confirmed"] as const;
export type DevisCostAnalysisStatus = (typeof DEVIS_COST_ANALYSIS_STATUSES)[number];
export type DevisCostAnalysis = typeof devisCostAnalyses.$inferSelect;
export type DevisLineContextAsset = typeof devisLineContextAssets.$inferSelect;
export type InsertDevisLineContextAsset = z.infer<typeof insertDevisLineContextAssetSchema>;

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  googleId: text("google_id").notNull().unique(),
  email: text("email").notNull().unique(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  profileImageUrl: text("profile_image_url"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  // Gmail polling per-user OAuth tokens (Path 1 of the inbox-monitoring fix
  // 2026-05-08). The Replit-managed `google-mail` connector only grants
  // gmail.send + addon scopes — it does NOT include gmail.readonly, which is
  // required for users.messages.list. Instead, we extend the existing Google
  // Workspace login OAuth (server/auth/google-oauth.ts) with a gmail.readonly
  // scope on first login, persist the resulting refresh_token here, and let
  // server/gmail/monitor.ts poll every linked architect's inbox individually.
  // Tokens are sensitive: never log, never return from /api/auth/user.
  gmailRefreshToken: text("gmail_refresh_token"),
  gmailAccessToken: text("gmail_access_token"),
  gmailTokenExpiresAt: timestamp("gmail_token_expires_at"),
  gmailScopeGranted: text("gmail_scope_granted"),
  gmailPollingEnabled: boolean("gmail_polling_enabled").notNull().default(true),
  gmailLastPollAt: timestamp("gmail_last_poll_at"),
  gmailLastPollStatus: text("gmail_last_poll_status"),
  gmailLastPollError: text("gmail_last_poll_error"),
});

export const sessions = pgTable("session", {
  sid: varchar("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire", { precision: 6 }).notNull(),
}, (table) => [
  index("sessions_expire_idx").on(table.expire),
]);

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export const devisRefEdits = pgTable("devis_ref_edits", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  field: text("field").notNull(),
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  editedByUserId: integer("edited_by_user_id").references(() => users.id),
  editedByEmail: text("edited_by_email"),
  editedAt: timestamp("edited_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("devis_ref_edits_devis_id_idx").on(table.devisId),
]);

export const insertDevisRefEditSchema = createInsertSchema(devisRefEdits).omit({
  id: true,
  editedAt: true,
});
export type DevisRefEdit = typeof devisRefEdits.$inferSelect;
export type InsertDevisRefEdit = z.infer<typeof insertDevisRefEditSchema>;

export const invoiceRefEdits = pgTable("invoice_ref_edits", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  field: text("field").notNull(),
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  editedByUserId: integer("edited_by_user_id").references(() => users.id),
  editedByEmail: text("edited_by_email"),
  editedAt: timestamp("edited_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("invoice_ref_edits_invoice_id_idx").on(table.invoiceId),
]);

export const insertInvoiceRefEditSchema = createInsertSchema(invoiceRefEdits).omit({
  id: true,
  editedAt: true,
});
export type InvoiceRefEdit = typeof invoiceRefEdits.$inferSelect;
export type InsertInvoiceRefEdit = z.infer<typeof insertInvoiceRefEditSchema>;

// -----------------------------------------------------------------------------
// Devis sign-off contract — table definitions (AT1, contract §2.1.1–§2.1.9)
// All seven tables are created in migration 0024_devis_signoff_workflow.sql.
// The downstream tasks (AT2 storage / AT3 outbound / AT4 receiver / AT5 emit)
// build their CRUD operations on top of these models.
// -----------------------------------------------------------------------------

/**
 * client_checks — devis-scoped check items raised against a client during
 * the sign-off review window (§2.1.1). Mirrors the existing `devis_checks`
 * shape so AT2's storage layer can reuse the messaging conventions, but
 * adds the `originSource` discriminator (`architrak_internal` for checks
 * raised in-app, `archisign_query` for checks mirrored from the
 * `envelope.queried` webhook).
 */
export const clientChecks = pgTable("client_checks", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("open"),
  queryText: text("query_text").notNull(),
  originSource: text("origin_source").notNull(),
  // Task #389 — optional per-line dialogue anchor ("Ask about this" on a
  // specific quotation line). NULL for quotation-level questions and all
  // historical rows. ON DELETE SET NULL: a rescrape that replaces line
  // items must not delete the client's question thread with the line.
  devisLineItemId: integer("devis_line_item_id").references(() => devisLineItems.id, { onDelete: "set null" }),
  // Stable Archisign event id for the originating `envelope.queried` event
  // when originSource = 'archisign_query'. NULL otherwise. Used by AT4 to
  // reconcile retries against an already-mirrored check.
  archisignQueryEventId: text("archisign_query_event_id"),
  // Resolver provenance fields populated when status transitions to
  // `resolved` per §3.3 + §2.1.1.
  resolvedBySource: text("resolved_by_source"),
  resolvedByUserEmail: text("resolved_by_user_email"),
  resolvedByActor: text("resolved_by_actor"),
  resolutionNote: text("resolution_note"),
  openedAt: timestamp("opened_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("client_checks_devis_id_idx").on(table.devisId),
  index("client_checks_status_idx").on(table.status),
  index("client_checks_devis_line_item_id_idx").on(table.devisLineItemId),
  index("client_checks_archisign_query_event_id_idx").on(table.archisignQueryEventId),
  check("client_checks_status_check", sql`${table.status} IN ('open', 'resolved', 'cancelled')`),
  check("client_checks_origin_source_check", sql`${table.originSource} IN ('architrak_internal', 'archisign_query')`),
  check(
    "client_checks_resolved_by_source_check",
    sql`${table.resolvedBySource} IS NULL OR ${table.resolvedBySource} IN ('architrak_internal', 'archisign_admin_ui', 'external')`,
  ),
  check(
    "client_checks_resolved_by_actor_check",
    sql`${table.resolvedByActor} IS NULL OR ${table.resolvedByActor} IN ('architect', 'system')`,
  ),
]);

export const insertClientCheckSchema = createInsertSchema(clientChecks, {
  status: z.enum(CLIENT_CHECK_STATUSES).optional(),
  devisLineItemId: z.number().int().positive().nullable().optional(),
  originSource: z.enum(CLIENT_CHECK_ORIGIN_SOURCES),
  resolvedBySource: z.enum(CLIENT_CHECK_RESOLVER_SOURCES).nullable().optional(),
  resolvedByActor: z.enum(CLIENT_CHECK_RESOLVER_ACTORS).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ClientCheck = typeof clientChecks.$inferSelect;
export type InsertClientCheck = z.infer<typeof insertClientCheckSchema>;

/**
 * client_check_messages — chronological thread attached to a client_check
 * (§2.1.2). Mirrors `devis_check_messages` shape; the new `archisign`
 * channel value covers messages mirrored from Archisign envelope events.
 */
export const clientCheckMessages = pgTable("client_check_messages", {
  id: serial("id").primaryKey(),
  checkId: integer("check_id").notNull().references(() => clientChecks.id, { onDelete: "cascade" }),
  authorType: text("author_type").notNull(),
  authorUserId: integer("author_user_id").references(() => users.id),
  authorEmail: text("author_email"),
  authorName: text("author_name"),
  body: text("body").notNull(),
  channel: text("channel").notNull().default("portal"),
  emailMessageId: text("email_message_id"),
  emailThreadId: text("email_thread_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("client_check_messages_check_id_idx").on(table.checkId),
  check(
    "client_check_messages_author_type_check",
    sql`${table.authorType} IN ('architect', 'client', 'system')`,
  ),
  check(
    "client_check_messages_channel_check",
    sql`${table.channel} IN ('portal', 'email', 'system', 'archisign')`,
  ),
]);

export const insertClientCheckMessageSchema = createInsertSchema(clientCheckMessages, {
  authorType: z.enum(["architect", "client", "system"]),
  channel: z.enum(["portal", "email", "system", "archisign"]).optional(),
}).omit({
  id: true,
  createdAt: true,
});
export type ClientCheckMessage = typeof clientCheckMessages.$inferSelect;
export type InsertClientCheckMessage = z.infer<typeof insertClientCheckMessageSchema>;

/**
 * client_check_tokens — short-lived single-use tokens for client portal
 * access (§2.1.3). The plaintext token is never persisted; only its
 * SHA-256 hash. A partial unique index (`one active per devis`) enforces
 * the "single live invitation" invariant from §1.2.
 */
export const clientCheckTokens = pgTable("client_check_tokens", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  clientEmail: text("client_email").notNull(),
  clientName: text("client_name"),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("client_check_tokens_token_hash_idx").on(table.tokenHash),
  index("client_check_tokens_devis_id_idx").on(table.devisId),
  uniqueIndex("client_check_tokens_one_active_idx")
    .on(table.devisId)
    .where(sql`${table.revokedAt} IS NULL`),
]);

export const insertClientCheckTokenSchema = createInsertSchema(clientCheckTokens).omit({
  id: true,
  createdAt: true,
  revokedAt: true,
  lastUsedAt: true,
});
export type ClientCheckToken = typeof clientCheckTokens.$inferSelect;
export type InsertClientCheckToken = z.infer<typeof insertClientCheckTokenSchema>;

/**
 * client_project_share_tokens — project-scoped client share links (Task #388).
 * ONE link per project listing all EXPLICITLY published quotations, so a
 * client with several devis doesn't juggle several per-devis links. Mirrors
 * `client_check_tokens` conventions: plaintext never persisted (SHA-256 hash
 * only), partial unique index enforces one active link per project. The
 * per-devis `client_check_tokens` remain valid in parallel during migration.
 */
export const clientProjectShareTokens = pgTable("client_project_share_tokens", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  clientEmail: text("client_email").notNull(),
  clientName: text("client_name"),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // Task #407 — full share URL encrypted at rest (AES-256-GCM keyed from
  // SESSION_SECRET; see server/services/share-url-crypto.ts) so the
  // authenticated panel can offer "Copy link" any time. The hash above
  // remains the ONLY public lookup path. NULL on rows issued before the
  // feature (copy unavailable until next rotate). Never exposed in DTOs.
  encryptedShareUrl: text("encrypted_share_url"),
}, (table) => [
  uniqueIndex("client_project_share_tokens_token_hash_idx").on(table.tokenHash),
  index("client_project_share_tokens_project_id_idx").on(table.projectId),
  uniqueIndex("client_project_share_tokens_one_active_idx")
    .on(table.projectId)
    .where(sql`${table.revokedAt} IS NULL`),
]);

export const insertClientProjectShareTokenSchema = createInsertSchema(clientProjectShareTokens).omit({
  id: true,
  createdAt: true,
  revokedAt: true,
  lastUsedAt: true,
});
export type ClientProjectShareToken = typeof clientProjectShareTokens.$inferSelect;
export type InsertClientProjectShareToken = z.infer<typeof insertClientProjectShareTokenSchema>;

/**
 * client_project_share_devis — explicit publish membership (token ↔ devis).
 * A devis appears on the project share link ONLY when a row exists here —
 * NEVER auto-include all project devis (security decision locked with the
 * user). Rotation copies memberships to the new token so re-issuing a link
 * doesn't silently unpublish everything. FKs indexed per ARCHITECTURE.md
 * §2.2.1 (the composite unique covers token_id lookups; devis_id gets its
 * own index).
 */
export const clientProjectShareDevis = pgTable("client_project_share_devis", {
  id: serial("id").primaryKey(),
  tokenId: integer("token_id").notNull().references(() => clientProjectShareTokens.id, { onDelete: "cascade" }),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  publishedByUserId: integer("published_by_user_id").references(() => users.id),
  publishedAt: timestamp("published_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("client_project_share_devis_token_devis_idx").on(table.tokenId, table.devisId),
  index("client_project_share_devis_devis_id_idx").on(table.devisId),
]);

export const insertClientProjectShareDevisSchema = createInsertSchema(clientProjectShareDevis).omit({
  id: true,
  publishedAt: true,
});
export type ClientProjectShareDevis = typeof clientProjectShareDevis.$inferSelect;
export type InsertClientProjectShareDevis = z.infer<typeof insertClientProjectShareDevisSchema>;

/**
 * client_project_share_audit — append-only audit trail of every architect
 * action on the project share link (Task #394). Membership rows are DELETEd
 * on unpublish, so without this table there is no history of who removed a
 * quotation from the client's view or when — and publishing controls what a
 * client can see. Rows are NEVER updated or deleted by application code;
 * token/devis FKs are SET NULL (not cascade) so history survives token
 * rotation-cleanup or devis deletion. `detail` is a human-readable snapshot
 * (actor name, devis code, client email…) rendered directly in the UI so the
 * trail stays legible even after referenced rows disappear.
 */
export const CLIENT_PROJECT_SHARE_AUDIT_ACTIONS = [
  "issue",
  "rotate",
  "extend",
  "revoke",
  "publish",
  "unpublish",
  // Task #409 — ArchiDoc fetched the live link server-to-server (read-only;
  // logged at most once per token per day).
  "archidoc_lookup",
] as const;
/**
 * insurance_overrides — captured at the moment an architect manually
 * overrides a contractor-insurance non-affirmative result to proceed with
 * `approved_for_signing` (§2.1.4 + §1.3). Stores the verbatim override
 * reason, the mirror-state at override time, and the live verdict response
 * for compliance audit. NEVER mutated post-insert (each override is a new
 * row).
 */
export const insuranceOverrides = pgTable("insurance_overrides", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id),
  overrideReason: text("override_reason").notNull(),
  mirrorStatusAtOverride: text("mirror_status_at_override").notNull(),
  mirrorSyncedAtAtOverride: timestamp("mirror_synced_at_at_override", { withTimezone: true }).notNull(),
  liveVerdictHttpStatus: integer("live_verdict_http_status").notNull(),
  liveVerdictCanProceed: boolean("live_verdict_can_proceed"),
  liveVerdictResponse: jsonb("live_verdict_response"),
  // Email is recorded alongside userId so the historical audit row stays
  // resolvable even if the user is later deleted/anonymised. Per contract
  // §1.3 the override block on the outbound webhook quotes this field
  // verbatim as `overriddenByUserEmail`.
  overriddenByUserEmail: text("overridden_by_user_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("insurance_overrides_devis_id_idx").on(table.devisId),
  index("insurance_overrides_user_id_idx").on(table.userId),
]);

export const insertInsuranceOverrideSchema = createInsertSchema(insuranceOverrides).omit({
  id: true,
  createdAt: true,
});
export type InsuranceOverride = typeof insuranceOverrides.$inferSelect;
export type InsertInsuranceOverride = z.infer<typeof insertInsuranceOverrideSchema>;

/**
 * signed_pdf_retention_breaches — records `envelope.retention_breach`
 * notifications received from Archisign after the 30-day retention window
 * has expired (§2.1.5 + §3.7). Parallel to (NOT shared with) Archidoc's
 * table per contract §2 footnote: disjoint envelope sets, no shared rows.
 * The `event_source` discriminator stays for parity with Archidoc's row
 * shape even though only `archisign` is meaningful on the Architrak side.
 */
export const signedPdfRetentionBreaches = pgTable("signed_pdf_retention_breaches", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  archisignEnvelopeId: text("archisign_envelope_id").notNull(),
  eventSource: text("event_source").notNull().default("archisign"),
  originalSignedAt: timestamp("original_signed_at", { withTimezone: true }).notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  incidentRef: text("incident_ref").notNull(),
  remediationContact: text("remediation_contact").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedByUserId: integer("acknowledged_by_user_id").references(() => users.id),
}, (table) => [
  index("signed_pdf_retention_breaches_devis_id_idx").on(table.devisId),
  index("signed_pdf_retention_breaches_envelope_idx").on(table.archisignEnvelopeId),
  // Race-safety: even if AT4's webhook_events_in dedup ever fails open, we
  // still cannot get duplicate breach rows for the same (envelope, incident).
  uniqueIndex("signed_pdf_retention_breaches_envelope_incident_unique")
    .on(table.archisignEnvelopeId, table.incidentRef),
  check(
    "signed_pdf_retention_breaches_event_source_check",
    sql`${table.eventSource} IN ('archisign')`,
  ),
]);

export const insertSignedPdfRetentionBreachSchema = createInsertSchema(signedPdfRetentionBreaches).omit({
  id: true,
  receivedAt: true,
  acknowledgedAt: true,
  acknowledgedByUserId: true,
});
export type SignedPdfRetentionBreach = typeof signedPdfRetentionBreaches.$inferSelect;
export type InsertSignedPdfRetentionBreach = z.infer<typeof insertSignedPdfRetentionBreachSchema>;

/**
 * webhook_deliveries_out — outbound webhook-attempt log (§2.1.6). One row
 * per logical event (UNIQUE on `eventId`) with an at-least-once semantic
 * driven by the AT5 retry sweeper. The unique index supports the
 * INSERT-ON-CONFLICT-DO-NOTHING claim pattern: callers re-emitting the
 * same event MUST observe the existing row and not enqueue a duplicate.
 *
 * State machine (`webhook_deliveries_out_state_check`):
 *   pending  -> succeeded | dead_lettered
 *   pending  -> pending     (counter bump on retry)
 */
export const webhookDeliveriesOut = pgTable("webhook_deliveries_out", {
  id: serial("id").primaryKey(),
  // Stable UUIDv7 — survives all retries; the receiver dedups on this.
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  targetUrl: text("target_url").notNull(),
  payload: jsonb("payload").notNull(),
  state: text("state").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastErrorBody: text("last_error_body"),
  // nextAttemptAt drives the retry sweeper's WHERE clause. NULL means
  // "ready immediately" (initial enqueue) or "no future attempt" (terminal).
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  succeededAt: timestamp("succeeded_at", { withTimezone: true }),
  deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("webhook_deliveries_out_event_id_unique").on(table.eventId),
  index("webhook_deliveries_out_state_idx").on(table.state),
  index("webhook_deliveries_out_state_next_attempt_idx").on(table.state, table.nextAttemptAt),
  index("webhook_deliveries_out_event_type_idx").on(table.eventType),
  check(
    "webhook_deliveries_out_state_check",
    sql`${table.state} IN ('pending', 'succeeded', 'dead_lettered')`,
  ),
  check(
    "webhook_deliveries_out_event_type_check",
    sql`${table.eventType} IN ('work_authorised', 'signed_pdf_retention_breach')`,
  ),
]);

export const insertWebhookDeliveryOutSchema = createInsertSchema(webhookDeliveriesOut, {
  state: z.enum(WEBHOOK_DELIVERY_STATES).optional(),
  eventType: z.enum(WORK_AUTHORISATION_EVENT_TYPES),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  attemptCount: true,
  lastAttemptAt: true,
  lastErrorBody: true,
  succeededAt: true,
  deadLetteredAt: true,
});
export type WebhookDeliveryOut = typeof webhookDeliveriesOut.$inferSelect;
export type InsertWebhookDeliveryOut = z.infer<typeof insertWebhookDeliveryOutSchema>;

/**
 * webhook_events_in — inbound webhook-dedup log (§2.1.9). UNIQUE on
 * `(source, event_id)` so AT4's receivers can use the dedup-via-violation
 * pattern: insert-first, on unique-violation short-circuit to
 * `200 {deduplicated:true}` per §1.5.
 *
 * Distinct from the pre-existing generic `webhook_events` table: that one
 * was never namespaced by source, and the contract reserves the
 * canonical `webhook_events_in` name for the v1.0 receiver path. Cleanup /
 * retention of this table (G14) is deferred to v1.1.
 */
export const webhookEventsIn = pgTable("webhook_events_in", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("webhook_events_in_source_event_id_unique").on(table.source, table.eventId),
  index("webhook_events_in_received_at_idx").on(table.receivedAt),
  check("webhook_events_in_source_check", sql`${table.source} IN ('archisign')`),
]);

export const insertWebhookEventInSchema = createInsertSchema(webhookEventsIn, {
  source: z.enum(INBOUND_WEBHOOK_SOURCES),
}).omit({
  id: true,
  receivedAt: true,
});
export type WebhookEventIn = typeof webhookEventsIn.$inferSelect;
export type InsertWebhookEventIn = z.infer<typeof insertWebhookEventInSchema>;

export const WISH_LIST_TYPES = ["feature", "bug"] as const;
export const WISH_LIST_STATUSES = ["open", "in_progress", "done", "wontfix"] as const;
export type WishListType = (typeof WISH_LIST_TYPES)[number];
export type WishListStatus = (typeof WISH_LIST_STATUSES)[number];

export const wishListItems = pgTable("wish_list_items", {
  id: serial("id").primaryKey(),
  type: text("type").notNull().default("feature"),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("open"),
  imageStorageKeys: text("image_storage_keys").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("wish_list_items_status_idx").on(table.status),
  check("wish_list_items_type_chk", sql`${table.type} IN ('feature','bug')`),
  check("wish_list_items_status_chk", sql`${table.status} IN ('open','in_progress','done','wontfix')`),
]);

export const insertWishListItemSchema = createInsertSchema(wishListItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  type: z.enum(WISH_LIST_TYPES),
  title: z.string().trim().min(1, "Title is required").max(200, "Title must be 200 characters or less"),
  description: z
    .string()
    .trim()
    .max(2000, "Description must be 2000 characters or less")
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional(),
  status: z.enum(WISH_LIST_STATUSES).optional(),
  imageStorageKeys: z.array(z.string().min(1)).max(20, "Up to 20 images per item").optional(),
});

export const updateWishListItemSchema = insertWishListItemSchema.partial();

export type WishListItem = typeof wishListItems.$inferSelect;
export type InsertWishListItem = z.infer<typeof insertWishListItemSchema>;
export type UpdateWishListItem = z.infer<typeof updateWishListItemSchema>;

// Task #130 — counter table backing the escalation logic in
// `scripts/post-merge-transient-alert.ts`. Each row tracks one
// `source_tag` (e.g. "backfill-page-hints") that the post-merge
// classifier (Task #126) tagged as a transient failure. Successful runs
// reset the counter to zero; once `consecutive_failures` reaches
// POST_MERGE_ESCALATE_AFTER (default 3) the next failure is reported
// with subject prefix `[escalated]` instead of `[transient]` so the
// on-call stops dismissing it as ignorable noise. Schema-error aborts
// (exit 2 from run-or-classify) NEVER touch this table — they already
// have their own loud-fail path.
export const postMergeTransientFailures = pgTable("post_merge_transient_failures", {
  sourceTag: text("source_tag").primaryKey(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastExitCode: integer("last_exit_code"),
  lastFailureAt: timestamp("last_failure_at"),
  lastClearedAt: timestamp("last_cleared_at"),
  recentFailures: jsonb("recent_failures").notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type PostMergeTransientFailure =
  typeof postMergeTransientFailures.$inferSelect;

// ---------------------------------------------------------------------
// Task #198 — Drive auto-upload queue (AT5-style retry + DLQ).
//
// One row per (docKind, docId) — re-enqueueing an already-succeeded
// row is a no-op handled in the service (UNIQUE constraint enforced
// at the SQL level). The worker sweeps `pending` rows whose
// `nextAttemptAt` has passed; on success it writes back the Drive
// file id + viewer link to the originating row (devis / invoice /
// certificat) AND to this queue row (for the admin DLQ surface).
// ---------------------------------------------------------------------
export const DRIVE_UPLOAD_DOC_KINDS = ["devis", "invoice", "certificat", "scrape", "devis_signed"] as const;
export type DriveUploadDocKind = (typeof DRIVE_UPLOAD_DOC_KINDS)[number];

export const DRIVE_UPLOAD_STATES = [
  "pending",
  "in_flight",
  "succeeded",
  "failed",
  "dead_letter",
] as const;
export type DriveUploadState = (typeof DRIVE_UPLOAD_STATES)[number];

export const driveUploads = pgTable("drive_uploads", {
  id: serial("id").primaryKey(),
  docKind: text("doc_kind").notNull(),
  docId: integer("doc_id").notNull(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  lotId: integer("lot_id").references(() => lots.id, { onDelete: "set null" }),
  sourceStorageKey: text("source_storage_key").notNull(),
  displayName: text("display_name").notNull(),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  lastAttemptAt: timestamp("last_attempt_at"),
  nextAttemptAt: timestamp("next_attempt_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  driveFileId: text("drive_file_id"),
  driveWebViewLink: text("drive_web_view_link"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("drive_uploads_doc_unique").on(table.docKind, table.docId),
  index("drive_uploads_state_next_idx").on(table.state, table.nextAttemptAt),
  index("drive_uploads_project_idx").on(table.projectId),
]);

export const insertDriveUploadSchema = createInsertSchema(driveUploads).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDriveUpload = z.infer<typeof insertDriveUploadSchema>;
export type DriveUpload = typeof driveUploads.$inferSelect;

// -----------------------------------------------------------------------------
// Pennylane push queue (Task #214). One row per logical push action
// keyed by (kind, doc_id) — re-enqueue of an already-succeeded row
// is a no-op via the unique constraint, exactly like drive_uploads.
//
// Three kinds:
//   - customer:         doc_id = projects.id;     creates a Pennylane
//                       customer for the project's client.
//   - customer_invoice: doc_id = fee_entries.id;  creates a Pennylane
//                       customer_invoice for the architect commission.
//                       Worker lazily resolves the parent `customer`
//                       row as a precondition.
//   - email_send:       doc_id = fee_entries.id;  chains after a
//                       successful customer_invoice — loads the
//                       mirrored PDF and emails it to the client via
//                       the architect's own Gmail OAuth token.
// -----------------------------------------------------------------------------

export const PENNYLANE_PUSH_STATES = [
  "pending",
  "in_flight",
  "succeeded",
  "failed",
  "dead_letter",
] as const;
export type PennylanePushState = (typeof PENNYLANE_PUSH_STATES)[number];

export const PENNYLANE_PUSH_KINDS = [
  "customer",
  "customer_invoice",
  "email_send",
] as const;
export type PennylanePushKind = (typeof PENNYLANE_PUSH_KINDS)[number];

export const pennylanePushes = pgTable("pennylane_pushes", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  docId: integer("doc_id").notNull(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  lastAttemptAt: timestamp("last_attempt_at"),
  nextAttemptAt: timestamp("next_attempt_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  // The Pennylane-assigned id on success. For `customer` kind: the
  // customer id; for `customer_invoice` kind: the invoice id; for
  // `email_send` kind: the Gmail message id. Stored as text — the
  // API returns ints for some and strings for others.
  pennylaneId: text("pennylane_id"),
  // True when this row was created under PENNYLANE_DRY_RUN and the
  // worker only logged the intended payload (no API call fired). Kept
  // so the admin DLQ can label dry-run rows distinctly.
  dryRun: boolean("dry_run").notNull().default(false),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("pennylane_pushes_doc_unique").on(table.kind, table.docId),
  index("pennylane_pushes_state_next_idx").on(table.state, table.nextAttemptAt),
  index("pennylane_pushes_project_idx").on(table.projectId),
]);

export const insertPennylanePushSchema = createInsertSchema(pennylanePushes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPennylanePush = z.infer<typeof insertPennylanePushSchema>;
export type PennylanePush = typeof pennylanePushes.$inferSelect;

// ---------------------------------------------------------------------
// Task #225 — Banking-detail anti-fraud overrides.
//
// Architect-only audit row. The certificat generator refuses to issue
// payment for a contractor whose latest devis/invoice prints an IBAN
// that disagrees with ArchiDoc's record — unless an override row here
// pairs that exact `(doc_kind, doc_id, doc_iban, archidoc_iban)` tuple
// with the architect who accepted the discrepancy and their reason.
//
// doc_kind/doc_id are polymorphic (no FK) — see migration 0039.
// ---------------------------------------------------------------------
export const bankingMismatchOverrides = pgTable("banking_mismatch_overrides", {
  id: serial("id").primaryKey(),
  docKind: text("doc_kind").notNull(),
  docId: integer("doc_id").notNull(),
  contractorId: integer("contractor_id")
    .notNull()
    .references(() => contractors.id, { onDelete: "cascade" }),
  docIban: text("doc_iban").notNull(),
  archidocIban: text("archidoc_iban").notNull(),
  overrideByUserId: integer("override_by_user_id").references(() => users.id, { onDelete: "set null" }),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  check("banking_mismatch_overrides_doc_kind_check", sql`${table.docKind} IN ('devis', 'invoice')`),
  unique("banking_mismatch_overrides_doc_unique").on(table.docKind, table.docId, table.docIban, table.archidocIban),
  index("banking_mismatch_overrides_contractor_idx").on(table.contractorId),
  index("banking_mismatch_overrides_doc_idx").on(table.docKind, table.docId),
]);

export const insertBankingMismatchOverrideSchema = createInsertSchema(bankingMismatchOverrides).omit({
  id: true,
  createdAt: true,
});
export type InsertBankingMismatchOverride = z.infer<typeof insertBankingMismatchOverrideSchema>;
export type BankingMismatchOverride = typeof bankingMismatchOverrides.$inferSelect;

export type ClientProjectShareAuditAction = (typeof CLIENT_PROJECT_SHARE_AUDIT_ACTIONS)[number];

export const clientProjectShareAudit = pgTable("client_project_share_audit", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  tokenId: integer("token_id").references(() => clientProjectShareTokens.id, { onDelete: "set null" }),
  devisId: integer("devis_id").references(() => devis.id, { onDelete: "set null" }),
  // One of CLIENT_PROJECT_SHARE_AUDIT_ACTIONS; plain text (no DB CHECK) by
  // convention with the rest of this schema.
  action: text("action").notNull(),
  actorUserId: integer("actor_user_id").references(() => users.id),
  detail: text("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("client_project_share_audit_project_id_idx").on(table.projectId),
  index("client_project_share_audit_token_id_idx").on(table.tokenId),
  index("client_project_share_audit_devis_id_idx").on(table.devisId),
]);

export const insertClientProjectShareAuditSchema = createInsertSchema(clientProjectShareAudit).omit({
  id: true,
  createdAt: true,
});
export type ClientProjectShareAuditEntry = typeof clientProjectShareAudit.$inferSelect;
export type InsertClientProjectShareAuditEntry = z.infer<typeof insertClientProjectShareAuditSchema>;

/**
 * archidoc_link_lookup_misses — Task #410. One row per project recording the
 * MOST RECENT failed ArchiDoc client-link lookup (reason "expired" or
 * "rotate_required" only — unknown_project probes are normal and never
 * recorded, and no_active_link means the architect deliberately has no
 * link). A successful lookup deletes the row, so presence + recency drives
 * the warning in the Project client link panel.
 */
export const ARCHIDOC_LOOKUP_MISS_REASONS = ["expired", "rotate_required"] as const;
export type ArchidocLookupMissReason = (typeof ARCHIDOC_LOOKUP_MISS_REASONS)[number];

export const archidocLinkLookupMisses = pgTable("archidoc_link_lookup_misses", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  // One of ARCHIDOC_LOOKUP_MISS_REASONS; plain text (no DB CHECK) by
  // convention with the rest of this schema.
  reason: text("reason").notNull(),
  lastMissAt: timestamp("last_miss_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("archidoc_link_lookup_misses_project_id_idx").on(table.projectId),
]);

export type ArchidocLinkLookupMiss = typeof archidocLinkLookupMisses.$inferSelect;

/**
 * architect_fee_invoices — Task #425. Evidence record for the firm's OWN
 * outbound honoraires invoices caught by Gmail polling (or later,
 * Pennylane). One row per caught invoice, parked `pending_review` until an
 * operator confirms it against a project + design-contract milestone
 * (confirmation transaction is Task #426; nothing here moves money).
 *
 * Guardrails:
 *  - unique source pointers (emailDocumentId / intakeDocumentId) — the same
 *    caught document can never spawn two evidence rows;
 *  - unique normalized invoice ref among non-manual, non-dismissed rows —
 *    business-ref dedup across re-catches while manual milestone payments
 *    may intentionally share one grouped invoice number;
 *  - projectId/milestoneId/feeEntryId stay NULL until human confirmation;
 *    `candidates` only carries ranked SUGGESTIONS;
 *  - `extractionSnapshot` is the immutable parsed payload for audit.
 */
export const ARCHITECT_FEE_INVOICE_STATUSES = ["pending_review", "confirmed", "dismissed"] as const;
export type ArchitectFeeInvoiceStatus = (typeof ARCHITECT_FEE_INVOICE_STATUSES)[number];

export const architectFeeInvoices = pgTable("architect_fee_invoices", {
  id: serial("id").primaryKey(),
  emailDocumentId: integer("email_document_id").references(() => emailDocuments.id, { onDelete: "set null" }),
  intakeDocumentId: integer("intake_document_id").references(() => projectIntakeDocuments.id, { onDelete: "set null" }),
  // NULL until confirmed by an operator (Task #426).
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  milestoneId: integer("milestone_id").references(() => designContractMilestones.id, { onDelete: "set null" }),
  feeEntryId: integer("fee_entry_id").references(() => feeEntries.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number"),
  invoiceNumberNormalized: text("invoice_number_normalized"),
  issueDate: date("issue_date"),
  amountHt: numeric("amount_ht", { precision: 12, scale: 2 }),
  tvaAmount: numeric("tva_amount", { precision: 12, scale: 2 }),
  amountTtc: numeric("amount_ttc", { precision: 12, scale: 2 }),
  clientName: text("client_name"),
  // Task #430 — works-commission correlation. The firm's commission invoice
  // on contractor works carries the originating DEVIS reference; promoted
  // out of extractionSnapshot so ranking/reconciliation and the UI can use
  // it without spelunking JSONB. Backfilled by migration 0070.
  devisNumber: text("devis_number"),
  devisNumberNormalized: text("devis_number_normalized"),
  fileName: text("file_name"),
  storageKey: text("storage_key"),
  source: text("source").notNull().default("gmail"),
  status: text("status").notNull().default("pending_review"),
  /** How the firm-identity gate confirmed the issuer (audit). */
  identityReason: text("identity_reason"),
  /** Ranked project + milestone suggestions ({projects:[],milestones:{}}). */
  candidates: jsonb("candidates"),
  /** Immutable copy of the parsed extraction at capture time. */
  extractionSnapshot: jsonb("extraction_snapshot"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("architect_fee_invoices_email_doc_unique").on(table.emailDocumentId).where(sql`${table.emailDocumentId} IS NOT NULL`),
  uniqueIndex("architect_fee_invoices_intake_doc_unique").on(table.intakeDocumentId).where(sql`${table.intakeDocumentId} IS NOT NULL`),
  uniqueIndex("architect_fee_invoices_captured_ref_unique")
    .on(table.invoiceNumberNormalized)
    .where(sql`${table.invoiceNumberNormalized} IS NOT NULL AND ${table.status} <> 'dismissed' AND ${table.source} <> 'manual'`),
  index("architect_fee_invoices_ref_idx")
    .on(table.invoiceNumberNormalized)
    .where(sql`${table.invoiceNumberNormalized} IS NOT NULL AND ${table.status} <> 'dismissed'`),
  index("architect_fee_invoices_status_idx").on(table.status),
  check(
    "architect_fee_invoices_status_chk",
    sql`${table.status} IN ('pending_review','confirmed','dismissed')`,
  ),
]);

export const insertArchitectFeeInvoiceSchema = createInsertSchema(architectFeeInvoices).omit({
  id: true,
  createdAt: true,
  // Server-authoritative: review outcome + money linkage are only ever
  // written by dedicated services (Task #426), never a generic body.
  status: true,
  projectId: true,
  milestoneId: true,
  feeEntryId: true,
  reviewedBy: true,
  reviewedAt: true,
});
export type ArchitectFeeInvoice = typeof architectFeeInvoices.$inferSelect;
export type InsertArchitectFeeInvoice = z.infer<typeof insertArchitectFeeInvoiceSchema>;

/**
 * Task #426 — APPEND-ONLY audit of review decisions on caught fee invoices.
 * One row per operator decision (confirm / dismiss / conflict parked /
 * idempotent replay). Rows are NEVER updated or deleted — same invariant as
 * accountingStateChanges.
 */
export const ARCHITECT_FEE_INVOICE_EVENT_ACTIONS = [
  "confirmed",
  "dismissed",
  "conflict_parked",
  "replayed",
] as const;
export type ArchitectFeeInvoiceEventAction = (typeof ARCHITECT_FEE_INVOICE_EVENT_ACTIONS)[number];

export const architectFeeInvoiceEvents = pgTable("architect_fee_invoice_events", {
  id: serial("id").primaryKey(),
  architectFeeInvoiceId: integer("architect_fee_invoice_id")
    .notNull()
    .references(() => architectFeeInvoices.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  actor: text("actor"),
  note: text("note"),
  /** Structured decision context (bound ids, reconciliation path, refusal reason). */
  details: jsonb("details"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("architect_fee_invoice_events_invoice_idx").on(table.architectFeeInvoiceId),
  check(
    "architect_fee_invoice_events_action_chk",
    sql`${table.action} IN ('confirmed','dismissed','conflict_parked','replayed','milestone_paid')`,
  ),
]);

export const insertArchitectFeeInvoiceEventSchema = createInsertSchema(architectFeeInvoiceEvents).omit({
  id: true,
  createdAt: true,
});
export type ArchitectFeeInvoiceEvent = typeof architectFeeInvoiceEvents.$inferSelect;
export type InsertArchitectFeeInvoiceEvent = z.infer<typeof insertArchitectFeeInvoiceEventSchema>;

export type InsertCertificatSource = z.infer<typeof insertCertificatSourceSchema>;

export type CertificatSource = typeof certificatSources.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Task #650 — Planning Envelope MVP
// Five tables: planning_envelopes, planning_revisions, planning_revision_lines,
// planning_revision_sources, planning_revision_events.
// The circular FKs (supersedes_revision_id → planning_revisions,
// promoted_devis_id → devis, devis.source_planning_revision_id → planning_revisions)
// are declared SQL-only in the migration to avoid Drizzle inference collapse.
// ─────────────────────────────────────────────────────────────────────────────

export const planningEnvelopes = pgTable("planning_envelopes", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("EUR"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("planning_envelopes_project_id_unique").on(table.projectId),
  index("planning_envelopes_project_id_idx").on(table.projectId),
]);

export const planningRevisions = pgTable("planning_revisions", {
  id: serial("id").primaryKey(),
  envelopeId: integer("envelope_id").notNull().references(() => planningEnvelopes.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("draft"),
  // nullable provenance
  contractorId: integer("contractor_id").references(() => contractors.id, { onDelete: "set null" }),
  lotId: integer("lot_id").references(() => lots.id, { onDelete: "set null" }),
  // header fields
  reference: text("reference"),
  descriptionFr: text("description_fr"),
  documentDate: date("document_date"),
  amountHt: numeric("amount_ht", { precision: 12, scale: 2 }),
  amountTtc: numeric("amount_ttc", { precision: 12, scale: 2 }),
  tvaRatePercent: numeric("tva_rate_percent", { precision: 5, scale: 2 }),
  tvaAutoliquidation: boolean("tva_autoliquidation").notNull().default(false),
  // lifecycle link — FK declared SQL-only (circular self-reference would collapse Drizzle TS inference)
  supersedesRevisionId: integer("supersedes_revision_id"),
  // review
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  // approval
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  approvedSnapshot: jsonb("approved_snapshot"),
  approvedSnapshotSha256: text("approved_snapshot_sha256"),
  // supersede actor
  supersededBy: text("superseded_by"),
  supersededAt: timestamp("superseded_at"),
  // promotion — FK to devis declared SQL-only (avoids Drizzle circular inference)
  promotedDevisId: integer("promoted_devis_id"),
  promotedBy: text("promoted_by"),
  promotedAt: timestamp("promoted_at"),
  // creator
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("planning_revisions_envelope_id_idx").on(table.envelopeId),
  index("planning_revisions_status_idx").on(table.status),
  uniqueIndex("planning_revisions_promoted_devis_id_unique")
    .on(table.promotedDevisId)
    .where(sql`${table.promotedDevisId} IS NOT NULL`),
  check("planning_revisions_status_chk", sql`${table.status} IN ('draft', 'reviewed', 'approved', 'superseded')`),
  check("planning_revisions_version_positive_chk", sql`${table.version} > 0`),
  check(
    "planning_revisions_amounts_positive_chk",
    sql`${table.amountHt} IS NULL OR ${table.amountHt} >= 0`,
  ),
  check(
    "planning_revisions_amounts_ttc_ht_chk",
    sql`${table.amountTtc} IS NULL OR ${table.amountHt} IS NULL OR ${table.amountTtc} >= ${table.amountHt}`,
  ),
  check(
    "planning_revisions_reviewed_audit_chk",
    sql`${table.status} != 'reviewed' OR (${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL)`,
  ),
  check(
    "planning_revisions_approved_audit_chk",
    sql`${table.status} NOT IN ('approved', 'superseded') OR (${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL AND ${table.approvedSnapshot} IS NOT NULL AND ${table.approvedSnapshotSha256} IS NOT NULL)`,
  ),
  check(
    "planning_revisions_superseded_audit_chk",
    sql`${table.status} != 'superseded' OR (${table.supersededBy} IS NOT NULL AND ${table.supersededAt} IS NOT NULL)`,
  ),
]);

export const planningRevisionLines = pgTable("planning_revision_lines", {
  id: serial("id").primaryKey(),
  revisionId: integer("revision_id").notNull().references(() => planningRevisions.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 3 }),
  unit: text("unit"),
  unitPriceHt: numeric("unit_price_ht", { precision: 12, scale: 2 }),
  totalHt: numeric("total_ht", { precision: 12, scale: 2 }).notNull(),
  pdfPageHint: integer("pdf_page_hint"),
  pdfBbox: jsonb("pdf_bbox").$type<{ x: number; y: number; w: number; h: number } | null>(),
}, (table) => [
  unique("planning_revision_lines_revision_line_unique").on(table.revisionId, table.lineNumber),
  index("planning_revision_lines_revision_id_idx").on(table.revisionId),
  check("planning_revision_lines_line_number_positive_chk", sql`${table.lineNumber} > 0`),
  check("planning_revision_lines_total_ht_nonneg_chk", sql`${table.totalHt} >= 0`),
  check("planning_revision_lines_unit_price_nonneg_chk", sql`${table.unitPriceHt} IS NULL OR ${table.unitPriceHt} >= 0`),
  check("planning_revision_lines_quantity_nonneg_chk", sql`${table.quantity} IS NULL OR ${table.quantity} >= 0`),
]);

export const planningRevisionSources = pgTable("planning_revision_sources", {
  id: serial("id").primaryKey(),
  revisionId: integer("revision_id").notNull().references(() => planningRevisions.id, { onDelete: "cascade" }),
  sourceKind: text("source_kind").notNull().default("manual"),
  // object storage provenance (null for manual sources)
  storageKey: text("storage_key"),
  fileName: text("file_name"),
  fileSha256: text("file_sha256"),
  mimeType: text("mime_type"),
  fileSizeBytes: integer("file_size_bytes"),
  // extraction provenance
  parserVersion: text("parser_version"),
  provider: text("provider"),
  modelId: text("model_id"),
  rawExtraction: jsonb("raw_extraction"),
  confidence: integer("confidence"),
  warnings: jsonb("warnings"),
  // verification gate
  requiresVerification: boolean("requires_verification").notNull().default(false),
  verifiedAt: timestamp("verified_at"),
  verifiedBy: text("verified_by"),
  verificationNote: text("verification_note"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("planning_revision_sources_revision_id_unique").on(table.revisionId),
  index("planning_revision_sources_revision_id_idx").on(table.revisionId),
  check("planning_revision_sources_source_kind_chk", sql`${table.sourceKind} IN ('manual', 'pdf_upload')`),
  check("planning_revision_sources_confidence_range_chk", sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 100)`),
  check(
    "planning_revision_sources_pdf_provenance_chk",
    sql`${table.sourceKind} != 'pdf_upload' OR (${table.storageKey} IS NOT NULL AND ${table.fileName} IS NOT NULL AND ${table.fileSha256} IS NOT NULL AND ${table.mimeType} IS NOT NULL AND ${table.fileSizeBytes} IS NOT NULL)`,
  ),
]);

export const PLANNING_IMPORT_STATUSES = ["processing", "succeeded", "failed", "stale"] as const;
export type PlanningImportStatus = (typeof PLANNING_IMPORT_STATUSES)[number];

export const PLANNING_IMPORT_STAGES = [
  "accepted",
  "extracting",
  "validating",
  "storing",
  "saving",
  "complete",
] as const;
export type PlanningImportStage = (typeof PLANNING_IMPORT_STAGES)[number];

export const planningImportJobs = pgTable("planning_import_jobs", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  fileSha256: text("file_sha256").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  status: text("status").notNull().default("processing"),
  stage: text("stage").notNull().default("accepted"),
  revisionId: integer("revision_id").references(() => planningRevisions.id, { onDelete: "set null" }),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdBy: text("created_by").notNull(),
  startedAt: timestamp("started_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("planning_import_jobs_project_started_idx").on(table.projectId, table.startedAt),
  index("planning_import_jobs_active_idx").on(table.projectId, table.updatedAt)
    .where(sql`${table.status} = 'processing'`),
  uniqueIndex("planning_import_jobs_revision_unique")
    .on(table.revisionId)
    .where(sql`${table.revisionId} IS NOT NULL`),
  check("planning_import_jobs_sha256_chk", sql`${table.fileSha256} ~ '^[0-9a-f]{64}$'`),
  check("planning_import_jobs_file_size_chk", sql`${table.fileSizeBytes} > 0 AND ${table.fileSizeBytes} <= 26214400`),
  check("planning_import_jobs_status_chk", sql`${table.status} IN ('processing', 'succeeded', 'failed', 'stale')`),
  check("planning_import_jobs_stage_chk", sql`${table.stage} IN ('accepted', 'extracting', 'validating', 'storing', 'saving', 'complete')`),
]);

export const planningRevisionEvents = pgTable("planning_revision_events", {
  id: serial("id").primaryKey(),
  revisionId: integer("revision_id").notNull().references(() => planningRevisions.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  actor: text("actor"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("planning_revision_events_revision_id_idx").on(table.revisionId),
]);

// Types
export type PlanningEnvelope = typeof planningEnvelopes.$inferSelect;
export type PlanningRevision = typeof planningRevisions.$inferSelect;
export type PlanningRevisionLine = typeof planningRevisionLines.$inferSelect;
export type PlanningRevisionSource = typeof planningRevisionSources.$inferSelect;
export type PlanningImportJob = typeof planningImportJobs.$inferSelect;
export type PlanningRevisionEvent = typeof planningRevisionEvents.$inferSelect;
