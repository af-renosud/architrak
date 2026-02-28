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
});

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
});

export const lots = pgTable("lots", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  lotNumber: integer("lot_number").notNull(),
  descriptionFr: text("description_fr").notNull(),
  descriptionUk: text("description_uk"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

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
});

export const devis = pgTable("devis", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  contractorId: integer("contractor_id").notNull().references(() => contractors.id),
  lotId: integer("lot_id").references(() => lots.id),
  marcheId: integer("marche_id").references(() => marches.id),
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
  dateSent: date("date_sent"),
  dateSigned: date("date_signed"),
  pvmvRef: text("pvmv_ref"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

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
});

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
});

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  contractorId: integer("contractor_id").notNull().references(() => contractors.id),
  projectId: integer("project_id").notNull().references(() => projects.id),
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
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const situations = pgTable("situations", {
  id: serial("id").primaryKey(),
  devisId: integer("devis_id").notNull().references(() => devis.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").references(() => invoices.id),
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
});

export const situationLines = pgTable("situation_lines", {
  id: serial("id").primaryKey(),
  situationId: integer("situation_id").notNull().references(() => situations.id, { onDelete: "cascade" }),
  devisLineItemId: integer("devis_line_item_id").notNull().references(() => devisLineItems.id),
  percentComplete: numeric("percent_complete", { precision: 5, scale: 2 }).notNull(),
  cumulativeAmount: numeric("cumulative_amount", { precision: 12, scale: 2 }).notNull(),
  previousAmount: numeric("previous_amount", { precision: 12, scale: 2 }).notNull().default("0.00"),
  netAmount: numeric("net_amount", { precision: 12, scale: 2 }).notNull(),
});

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
});

export const fees = pgTable("fees", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  feeType: text("fee_type").notNull(),
  baseAmountHt: numeric("base_amount_ht", { precision: 12, scale: 2 }).notNull().default("0.00"),
  feeRate: numeric("fee_rate", { precision: 5, scale: 2 }),
  feeAmountHt: numeric("fee_amount_ht", { precision: 12, scale: 2 }).notNull(),
  feeAmountTtc: numeric("fee_amount_ttc", { precision: 12, scale: 2 }).notNull(),
  invoicedAmount: numeric("invoiced_amount", { precision: 12, scale: 2 }).default("0.00"),
  remainingAmount: numeric("remaining_amount", { precision: 12, scale: 2 }).notNull(),
  pennylaneRef: text("pennylane_ref"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

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
});

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
});

export const archidocSyncLog = pgTable("archidoc_sync_log", {
  id: serial("id").primaryKey(),
  syncType: text("sync_type").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  completedAt: timestamp("completed_at"),
  recordsUpdated: integer("records_updated").default(0),
  errorMessage: text("error_message"),
});

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

export type ArchidocProject = typeof archidocProjects.$inferSelect;
export type ArchidocContractor = typeof archidocContractors.$inferSelect;
export type ArchidocTrade = typeof archidocTrades.$inferSelect;
export type ArchidocProposalFee = typeof archidocProposalFees.$inferSelect;
export type ArchidocSyncLogEntry = typeof archidocSyncLog.$inferSelect;
