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
  index,
  check,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  clientName: text("client_name").notNull(),
  clientAddress: text("client_address"),
  siteAddress: text("site_address"),
  status: text("status").notNull().default("active"),
  tvaRate: numeric("tva_rate", { precision: 5, scale: 2 }).notNull().default("20.00"),
  feePercentage: numeric("fee_percentage", { precision: 5, scale: 2 }),
  feeType: text("fee_type").notNull().default("percentage"),
  conceptionFee: numeric("conception_fee", { precision: 12, scale: 2 }),
  planningFee: numeric("planning_fee", { precision: 12, scale: 2 }),
  hasMarche: boolean("has_marche").notNull().default(false),
  archidocId: varchar("archidoc_id", { length: 255 }),
  archidocClients: jsonb("archidoc_clients"),
  lastSyncedAt: timestamp("last_synced_at"),
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
  defaultTvaRate: numeric("default_tva_rate", { precision: 5, scale: 2 }).default("20.00"),
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
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("contractors_archidoc_id_unique").on(table.archidocId),
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
  tvaRate: numeric("tva_rate", { precision: 5, scale: 2 }).notNull().default("20.00"),
  amountTtc: numeric("amount_ttc", { precision: 12, scale: 2 }).notNull(),
  invoicingMode: text("invoicing_mode").notNull().default("mode_a"),
  status: text("status").notNull().default("pending"),
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
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("devis_project_id_idx").on(table.projectId),
  index("devis_contractor_id_idx").on(table.contractorId),
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
  invoiceNumber: integer("invoice_number").notNull(),
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
  feeAmountTtc: numeric("fee_amount_ttc", { precision: 12, scale: 2 }).notNull(),
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
  archidocUpdatedAt: timestamp("archidoc_updated_at"),
  syncedAt: timestamp("synced_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

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
  archidocUpdatedAt: timestamp("archidoc_updated_at"),
  syncedAt: timestamp("synced_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

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
  errorMessage: text("error_message"),
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
  relatedCertificatId: integer("related_certificat_id").references(() => certificats.id),
  relatedInvoiceId: integer("related_invoice_id").references(() => invoices.id),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("project_communications_project_id_idx").on(table.projectId),
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
  source: text("source").notNull().default("ai_extraction"),
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
});

export const insertContractorSchema = createInsertSchema(contractors).omit({
  id: true,
  createdAt: true,
});

export const insertLotSchema = createInsertSchema(lots).omit({
  id: true,
  createdAt: true,
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

export const insertDevisLineItemSchema = createInsertSchema(devisLineItems).omit({
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

export type ArchidocProject = typeof archidocProjects.$inferSelect;
export type ArchidocContractor = typeof archidocContractors.$inferSelect;
export type ArchidocTrade = typeof archidocTrades.$inferSelect;
export type ArchidocProposalFee = typeof archidocProposalFees.$inferSelect;
export type ArchidocSyncLogEntry = typeof archidocSyncLog.$inferSelect;

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
