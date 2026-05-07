import { sql } from "drizzle-orm";
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
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// =============================================================================
// Devis sign-off contract — shared enums and embedded-jsonb shapes (AT1)
// Sourced from `docs/INTER_APP_CONTRACT_v1.0.md` (frozen 2026-04-25).
// Tables that consume these constants are defined further down in this file.
// =============================================================================

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
  archidocOrphanedAt: timestamp("archidoc_orphaned_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("contractors_archidoc_id_unique").on(table.archidocId),
  check("contractors_siret_format", sql`${table.siret} IS NULL OR ${table.siret} ~ '^[0-9]{14}$'`),
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
  invoicingMode: text("invoicing_mode").notNull().default("mode_a"),
  status: text("status").notNull().default("pending"),
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
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("devis_project_id_idx").on(table.projectId),
  index("devis_contractor_id_idx").on(table.contractorId),
  index("devis_archisign_envelope_id_idx").on(table.archisignEnvelopeId),
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
  certificateNumber: text("certificate_number"),
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
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("situations_devis_id_idx").on(table.devisId),
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
}, (table) => [
  index("situation_lines_situation_id_idx").on(table.situationId),
  index("situation_lines_devis_line_item_id_idx").on(table.devisLineItemId),
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
  netToPayHt: numeric("net_to_pay_ht", { precision: 12, scale: 2 }).notNull(),
  tvaAmount: numeric("tva_amount", { precision: 12, scale: 2 }).notNull(),
  netToPayTtc: numeric("net_to_pay_ttc", { precision: 12, scale: 2 }).notNull(),
  status: text("status").notNull().default("draft"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("certificats_project_ref_unique").on(table.projectId, table.certificateRef),
  index("certificats_project_contractor_idx").on(table.projectId, table.contractorId),
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
  pennylaneInvoiceRef: text("pennylane_invoice_ref"),
  dateInvoiced: date("date_invoiced"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("fee_entries_fee_id_idx").on(table.feeId),
  uniqueIndex("fee_entries_invoice_unique").on(table.invoiceId).where(sql`${table.invoiceId} IS NOT NULL`),
  check("fee_entries_fee_amount_nonneg", sql`${table.feeAmount} >= 0`),
  check("fee_entries_fee_rate_pct", sql`${table.feeRate} >= 0 AND ${table.feeRate} <= 100`),
]);

// =============================================================================
// Design contracts (Task #175) — uploaded PDF design contract per project,
// extracted by Gemini into totals + payment milestones. Replaces the manual
// conception/planning numeric inputs in the New Project dialog. One contract
// per project (UNIQUE projectId); re-upload archives the previous PDF and
// replaces both rows.
// =============================================================================
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
  isDeleted: boolean("is_deleted").default(false).notNull(),
  deletedAt: timestamp("deleted_at"),
  sourceBaseUrl: text("source_base_url"),
  archidocUpdatedAt: timestamp("archidoc_updated_at"),
  syncedAt: timestamp("synced_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  check("archidoc_contractors_siret_format", sql`${table.siret} IS NULL OR ${table.siret} ~ '^[0-9]{14}$'`),
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
  index("project_documents_source_email_doc_idx").on(table.sourceEmailDocumentId),
]);

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
  relatedCertificatId: integer("related_certificat_id").references(() => certificats.id),
  relatedInvoiceId: integer("related_invoice_id").references(() => invoices.id),
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

export const insertMarcheSchema = createInsertSchema(marches).omit({
  id: true,
  createdAt: true,
});

export const insertDevisSchema = createInsertSchema(devis).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
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
});

export const insertSituationLineSchema = createInsertSchema(situationLines).omit({
  id: true,
});

export const insertCertificatSchema = createInsertSchema(certificats).omit({
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
});

export const insertProjectDocumentSchema = createInsertSchema(projectDocuments).omit({
  id: true,
  createdAt: true,
});

export const insertProjectCommunicationSchema = createInsertSchema(projectCommunications).omit({
  id: true,
  createdAt: true,
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

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  googleId: text("google_id").notNull().unique(),
  email: text("email").notNull().unique(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  profileImageUrl: text("profile_image_url"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
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

// =============================================================================
// Devis sign-off contract — table definitions (AT1, contract §2.1.1–§2.1.9)
// All seven tables are created in migration 0024_devis_signoff_workflow.sql.
// The downstream tasks (AT2 storage / AT3 outbound / AT4 receiver / AT5 emit)
// build their CRUD operations on top of these models.
// =============================================================================

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
