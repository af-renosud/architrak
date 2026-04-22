import { db } from "./db";
import { eq, desc, asc, and, or, inArray, isNotNull, isNull, lte, gte, like, ilike, sql, type SQL } from "drizzle-orm";
import {
  projects, contractors, lots, lotCatalog, marches, devis, devisLineItems,
  avenants, invoices, situations, situationLines, certificats, fees, feeEntries,
  archidocProjects, archidocContractors, archidocTrades, archidocProposalFees, archidocSyncLog, archidocSiretIssues,
  emailDocuments, projectDocuments, projectCommunications, paymentReminders, clientPaymentEvidence,
  aiModelSettings, templateAssets, users, devisTranslations, wishListItems,
  benchmarkDocuments, benchmarkItems, benchmarkTags, benchmarkItemTags,
  devisChecks, devisCheckMessages, devisCheckTokens,
  type DevisCheck, type InsertDevisCheck,
  type DevisCheckMessage, type InsertDevisCheckMessage,
  type DevisCheckToken, type InsertDevisCheckToken,
  type Project, type InsertProject,
  type User, type InsertUser,
  type Contractor, type InsertContractor,
  type Lot, type InsertLot,
  type LotCatalog, type InsertLotCatalog,
  type WishListItem, type InsertWishListItem, type UpdateWishListItem,
  type Marche, type InsertMarche,
  type Devis, type InsertDevis,
  type DevisLineItem, type InsertDevisLineItem,
  type Avenant, type InsertAvenant,
  type Invoice, type InsertInvoice,
  type Situation, type InsertSituation,
  type SituationLine, type InsertSituationLine,
  type Certificat, type InsertCertificat,
  type Fee, type InsertFee,
  type FeeEntry, type InsertFeeEntry,
  type ArchidocProject, type ArchidocContractor, type ArchidocTrade, type ArchidocProposalFee, type ArchidocSyncLogEntry, type ArchidocSiretIssue,
  type EmailDocument, type InsertEmailDocument,
  type ProjectDocument, type InsertProjectDocument,
  type ProjectCommunication, type InsertProjectCommunication,
  type PaymentReminder, type InsertPaymentReminder,
  type ClientPaymentEvidence, type InsertClientPaymentEvidence,
  type AiModelSetting,
  type TemplateAsset, type InsertTemplateAsset,
  type DevisTranslation, type InsertDevisTranslation,
  type BenchmarkTag, type InsertBenchmarkTag,
  type BenchmarkDocument, type InsertBenchmarkDocument,
  type BenchmarkItem, type InsertBenchmarkItem,
  devisRefEdits,
  type DevisRefEdit, type InsertDevisRefEdit,
  invoiceRefEdits,
  type InvoiceRefEdit, type InsertInvoiceRefEdit,
} from "@shared/schema";

export interface BenchmarkSearchFilters {
  q?: string;
  tagIds?: number[];
  contractorId?: number;
  dateFrom?: string;
  dateTo?: string;
  normalizedUnit?: string;
  minPrice?: number;
  maxPrice?: number;
  needsReview?: boolean;
  limit?: number;
}

export interface BenchmarkSearchRow {
  item: BenchmarkItem;
  document: BenchmarkDocument;
  contractorName: string | null;
  tags: BenchmarkTag[];
}

export interface BenchmarkAggregateRow {
  tagId: number;
  tagLabel: string;
  normalizedUnit: string | null;
  count: number;
  minPrice: number;
  medianPrice: number;
  maxPrice: number;
}

export interface IStorage {
  getProjects(options?: { includeArchived?: boolean; archivedOnly?: boolean }): Promise<Project[]>;
  getProject(id: number): Promise<Project | undefined>;
  createProject(data: InsertProject): Promise<Project>;
  updateProject(id: number, data: Partial<InsertProject>): Promise<Project | undefined>;
  archiveProject(id: number): Promise<Project | undefined>;
  unarchiveProject(id: number): Promise<Project | undefined>;
  deleteProject(id: number): Promise<void>;

  getAllInvoices(): Promise<Invoice[]>;
  getAllCertificats(): Promise<Certificat[]>;
  getRecentInvoices(limit: number): Promise<Invoice[]>;
  getRecentCertificats(limit: number): Promise<Certificat[]>;

  getContractors(): Promise<Contractor[]>;
  getContractor(id: number): Promise<Contractor | undefined>;
  createContractor(data: InsertContractor): Promise<Contractor>;
  updateContractor(id: number, data: Partial<InsertContractor>): Promise<Contractor | undefined>;
  getDevisByContractor(contractorId: number): Promise<Devis[]>;
  getInvoicesByContractor(contractorId: number): Promise<Invoice[]>;

  getLotsByProject(projectId: number): Promise<Lot[]>;
  createLot(data: InsertLot): Promise<Lot>;
  updateLot(id: number, data: Partial<InsertLot>): Promise<Lot | undefined>;
  deleteLot(id: number): Promise<void>;

  getLotCatalog(): Promise<LotCatalog[]>;
  getLotCatalogByCode(code: string): Promise<LotCatalog | undefined>;
  getLotCatalogEntry(id: number): Promise<LotCatalog | undefined>;
  createLotCatalogEntry(data: InsertLotCatalog): Promise<LotCatalog>;
  updateLotCatalogEntry(id: number, data: Partial<InsertLotCatalog>): Promise<LotCatalog | undefined>;
  deleteLotCatalogEntry(id: number): Promise<void>;

  getWishListItems(): Promise<WishListItem[]>;
  getWishListItem(id: number): Promise<WishListItem | undefined>;
  createWishListItem(data: InsertWishListItem): Promise<WishListItem>;
  updateWishListItem(id: number, data: UpdateWishListItem): Promise<WishListItem | undefined>;
  deleteWishListItem(id: number): Promise<void>;
  countProjectLotsByCode(code: string): Promise<number>;
  ensureProjectLotFromCatalog(projectId: number, catalogCode: string): Promise<Lot | undefined>;

  getMarchesByProject(projectId: number): Promise<Marche[]>;
  getMarche(id: number): Promise<Marche | undefined>;
  createMarche(data: InsertMarche): Promise<Marche>;
  updateMarche(id: number, data: Partial<InsertMarche>): Promise<Marche | undefined>;

  getDevisByProject(projectId: number): Promise<Devis[]>;
  getDevis(id: number): Promise<Devis | undefined>;
  createDevis(data: InsertDevis): Promise<Devis>;
  updateDevis(id: number, data: Partial<InsertDevis>): Promise<Devis | undefined>;
  getDevisRefEdits(devisId: number): Promise<DevisRefEdit[]>;
  createDevisRefEdit(data: InsertDevisRefEdit): Promise<DevisRefEdit>;

  getDevisLineItems(devisId: number): Promise<DevisLineItem[]>;
  createDevisLineItem(data: InsertDevisLineItem): Promise<DevisLineItem>;
  updateDevisLineItem(id: number, data: Partial<InsertDevisLineItem>): Promise<DevisLineItem | undefined>;
  deleteDevisLineItem(id: number): Promise<void>;

  getAvenantsByDevis(devisId: number): Promise<Avenant[]>;
  createAvenant(data: InsertAvenant): Promise<Avenant>;
  updateAvenant(id: number, data: Partial<InsertAvenant>): Promise<Avenant | undefined>;

  getInvoice(id: number): Promise<Invoice | undefined>;
  getInvoicesByDevis(devisId: number): Promise<Invoice[]>;
  getInvoicesByProject(projectId: number): Promise<Invoice[]>;
  createInvoice(data: InsertInvoice): Promise<Invoice>;
  updateInvoice(id: number, data: Partial<InsertInvoice>): Promise<Invoice | undefined>;
  deleteInvoice(id: number): Promise<boolean>;
  getInvoiceRefEdits(invoiceId: number): Promise<InvoiceRefEdit[]>;
  createInvoiceRefEdit(data: InsertInvoiceRefEdit): Promise<InvoiceRefEdit>;

  getSituationsByDevis(devisId: number): Promise<Situation[]>;
  getSituation(id: number): Promise<Situation | undefined>;
  createSituation(data: InsertSituation): Promise<Situation>;
  updateSituation(id: number, data: Partial<InsertSituation>): Promise<Situation | undefined>;

  getSituationLines(situationId: number): Promise<SituationLine[]>;
  createSituationLine(data: InsertSituationLine): Promise<SituationLine>;

  getCertificatsByProject(projectId: number): Promise<Certificat[]>;
  getCertificatsByProjectAndContractor(projectId: number, contractorId: number): Promise<Certificat[]>;
  getCertificat(id: number): Promise<Certificat | undefined>;
  createCertificat(data: InsertCertificat): Promise<Certificat>;
  updateCertificat(id: number, data: Partial<InsertCertificat>): Promise<Certificat | undefined>;

  getFeesByProject(projectId: number): Promise<Fee[]>;
  createFee(data: InsertFee): Promise<Fee>;
  updateFee(id: number, data: Partial<InsertFee>): Promise<Fee | undefined>;

  getFeeEntries(feeId: number): Promise<FeeEntry[]>;
  getFeeEntriesByProject(projectId: number): Promise<FeeEntry[]>;
  createFeeEntry(data: InsertFeeEntry): Promise<FeeEntry>;
  updateFeeEntry(id: number, data: Partial<InsertFeeEntry>): Promise<FeeEntry | undefined>;

  getProjectByArchidocId(archidocId: string): Promise<Project | undefined>;
  getProjectByName(name: string): Promise<Project | undefined>;
  getContractorByArchidocId(archidocId: string): Promise<Contractor | undefined>;
  getTrackedArchidocProjectIds(): Promise<string[]>;

  getArchidocProjects(): Promise<ArchidocProject[]>;
  getArchidocProject(archidocId: string): Promise<ArchidocProject | undefined>;
  upsertArchidocProject(data: Omit<ArchidocProject, "syncedAt">): Promise<ArchidocProject>;

  getArchidocContractors(): Promise<ArchidocContractor[]>;
  getArchidocContractor(archidocId: string): Promise<ArchidocContractor | undefined>;
  upsertArchidocContractor(data: Omit<ArchidocContractor, "syncedAt">): Promise<ArchidocContractor>;

  getArchidocTrades(): Promise<ArchidocTrade[]>;
  upsertArchidocTrade(data: Omit<ArchidocTrade, "syncedAt">): Promise<ArchidocTrade>;

  getArchidocProposalFees(archidocProjectId: string): Promise<ArchidocProposalFee[]>;
  upsertArchidocProposalFee(data: Omit<ArchidocProposalFee, "id" | "syncedAt">): Promise<ArchidocProposalFee>;

  createSyncLogEntry(data: { syncType: string; status: string; errorMessage?: string }): Promise<ArchidocSyncLogEntry>;
  updateSyncLogEntry(id: number, data: Partial<{ status: string; completedAt: Date; recordsUpdated: number; errorMessage: string }>): Promise<ArchidocSyncLogEntry | undefined>;
  getRecentSyncLogs(limit: number): Promise<ArchidocSyncLogEntry[]>;
  getArchidocSiretIssues(): Promise<ArchidocSiretIssue[]>;

  getEmailDocuments(filters?: { projectId?: number; status?: string; documentType?: string }): Promise<EmailDocument[]>;
  getEmailDocument(id: number): Promise<EmailDocument | undefined>;
  getEmailDocumentByMessageId(messageId: string): Promise<EmailDocument | undefined>;
  createEmailDocument(data: InsertEmailDocument): Promise<EmailDocument>;
  updateEmailDocument(id: number, data: Partial<InsertEmailDocument>): Promise<EmailDocument | undefined>;
  updateEmailDocumentLabelStatus(messageId: string): Promise<void>;
  getPendingEmailDocuments(): Promise<EmailDocument[]>;

  getProjectDocuments(projectId: number): Promise<ProjectDocument[]>;
  getProjectDocument(id: number): Promise<ProjectDocument | undefined>;
  createProjectDocument(data: InsertProjectDocument): Promise<ProjectDocument>;

  getProjectCommunications(projectId: number): Promise<ProjectCommunication[]>;
  getAllCommunications(): Promise<ProjectCommunication[]>;
  getProjectCommunication(id: number): Promise<ProjectCommunication | undefined>;
  createProjectCommunication(data: InsertProjectCommunication): Promise<ProjectCommunication>;
  updateProjectCommunication(id: number, data: Partial<InsertProjectCommunication>): Promise<ProjectCommunication | undefined>;

  getPaymentReminders(projectId: number): Promise<PaymentReminder[]>;
  getPaymentReminder(id: number): Promise<PaymentReminder | undefined>;
  createPaymentReminder(data: InsertPaymentReminder): Promise<PaymentReminder>;
  updatePaymentReminder(id: number, data: Partial<InsertPaymentReminder>): Promise<PaymentReminder | undefined>;
  getDuePaymentReminders(dateStr: string): Promise<PaymentReminder[]>;

  getClientPaymentEvidence(projectId: number): Promise<ClientPaymentEvidence[]>;
  createClientPaymentEvidence(data: InsertClientPaymentEvidence): Promise<ClientPaymentEvidence>;

  getDevisTranslation(devisId: number): Promise<DevisTranslation | undefined>;
  upsertDevisTranslation(data: InsertDevisTranslation): Promise<DevisTranslation>;
  updateDevisTranslation(devisId: number, data: Partial<InsertDevisTranslation>): Promise<DevisTranslation | undefined>;

  getAiModelSettings(): Promise<AiModelSetting[]>;
  getAiModelSetting(taskType: string): Promise<AiModelSetting | undefined>;
  upsertAiModelSetting(taskType: string, provider: string, modelId: string): Promise<AiModelSetting>;

  getTemplateAssets(): Promise<TemplateAsset[]>;
  getTemplateAssetByType(assetType: string): Promise<TemplateAsset | undefined>;
  upsertTemplateAsset(data: InsertTemplateAsset): Promise<TemplateAsset>;
  deleteTemplateAsset(id: number): Promise<void>;

  getNextCertificateRef(projectId: number): Promise<string>;
  getDevisByProjectAndContractor(projectId: number, contractorId: number): Promise<Devis[]>;
  getLot(id: number): Promise<import("@shared/schema").Lot | undefined>;

  getUser(id: number): Promise<User | undefined>;
  getUserByGoogleId(googleId: string): Promise<User | undefined>;
  upsertUser(data: InsertUser): Promise<User>;

  getBenchmarkTags(): Promise<BenchmarkTag[]>;
  upsertBenchmarkTag(data: InsertBenchmarkTag): Promise<BenchmarkTag>;

  getBenchmarkDocuments(): Promise<BenchmarkDocument[]>;
  getBenchmarkDocument(id: number): Promise<BenchmarkDocument | undefined>;
  getBenchmarkDocumentBySourceDevis(devisId: number): Promise<BenchmarkDocument | undefined>;
  createBenchmarkDocument(data: InsertBenchmarkDocument): Promise<BenchmarkDocument>;
  updateBenchmarkDocument(id: number, data: Partial<InsertBenchmarkDocument>): Promise<BenchmarkDocument | undefined>;
  deleteBenchmarkDocument(id: number): Promise<void>;

  createBenchmarkItem(data: InsertBenchmarkItem): Promise<BenchmarkItem>;
  deleteBenchmarkItem(id: number): Promise<void>;
  deleteBenchmarkItemsByDocument(documentId: number): Promise<void>;
  setBenchmarkItemTags(itemId: number, tagIds: number[]): Promise<void>;
  getBenchmarkItemTags(itemId: number): Promise<BenchmarkTag[]>;

  searchBenchmarkItems(filters: BenchmarkSearchFilters): Promise<BenchmarkSearchRow[]>;
  aggregateBenchmarkPrices(filters: BenchmarkSearchFilters): Promise<BenchmarkAggregateRow[]>;

  listDevisChecks(devisId: number): Promise<DevisCheck[]>;
  getDevisCheck(id: number): Promise<DevisCheck | undefined>;
  createDevisCheck(data: InsertDevisCheck): Promise<DevisCheck>;
  updateDevisCheck(id: number, data: Partial<InsertDevisCheck> & { resolvedAt?: Date | null; resolvedByUserId?: number | null }): Promise<DevisCheck | undefined>;
  upsertLineItemCheck(devisId: number, lineItemId: number, query: string, userId: number | null): Promise<DevisCheck>;
  countOpenDevisChecks(devisId: number): Promise<number>;
  isDevisChecking(devisId: number): Promise<boolean>;
  listDevisCheckMessages(checkId: number): Promise<DevisCheckMessage[]>;
  createDevisCheckMessage(data: InsertDevisCheckMessage): Promise<DevisCheckMessage>;
  getActiveDevisCheckToken(devisId: number): Promise<DevisCheckToken | undefined>;
  createDevisCheckToken(data: InsertDevisCheckToken): Promise<DevisCheckToken>;
  revokeDevisCheckTokensForDevis(devisId: number): Promise<void>;
  getDevisCheckTokenByHash(hash: string): Promise<DevisCheckToken | undefined>;
  touchDevisCheckTokenUsed(id: number, expiresAt: Date | null): Promise<void>;
  revokeExpiredDevisCheckTokens(now?: Date): Promise<number>;
  getProjectCommunicationByDedupeKey(key: string): Promise<ProjectCommunication | undefined>;
  getLatestSentDevisCheckBundle(devisId: number): Promise<ProjectCommunication | undefined>;
  countSentDevisCheckBundles(devisId: number): Promise<number>;
  getMaxMessageIdForChecks(checkIds: number[]): Promise<number>;
  countOpenDevisChecksForProject(projectId: number): Promise<Record<number, number>>;
}

export class DatabaseStorage implements IStorage {
  async getProjects(options?: { includeArchived?: boolean; archivedOnly?: boolean }): Promise<Project[]> {
    const where = options?.archivedOnly
      ? isNotNull(projects.archivedAt)
      : options?.includeArchived
        ? undefined
        : isNull(projects.archivedAt);
    const query = db.select().from(projects);
    const rows = where ? await query.where(where).orderBy(desc(projects.createdAt)) : await query.orderBy(desc(projects.createdAt));
    return rows;
  }

  async archiveProject(id: number): Promise<Project | undefined> {
    const now = new Date();
    const [project] = await db
      .update(projects)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(eq(projects.id, id), isNull(projects.archivedAt)))
      .returning();
    if (project) return project;
    const [existing] = await db.select().from(projects).where(eq(projects.id, id));
    return existing;
  }

  async unarchiveProject(id: number): Promise<Project | undefined> {
    const [project] = await db
      .update(projects)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    return project;
  }

  async getProject(id: number): Promise<Project | undefined> {
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    return project;
  }

  async createProject(data: InsertProject): Promise<Project> {
    const [project] = await db.insert(projects).values(data).returning();
    return project;
  }

  async updateProject(id: number, data: Partial<InsertProject>): Promise<Project | undefined> {
    const [project] = await db.update(projects).set({ ...data, updatedAt: new Date() }).where(eq(projects.id, id)).returning();
    return project;
  }

  async deleteProject(id: number): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }

  async getAllInvoices(): Promise<Invoice[]> {
    return db.select().from(invoices).orderBy(desc(invoices.createdAt));
  }

  async getAllCertificats(): Promise<Certificat[]> {
    return db.select().from(certificats).orderBy(desc(certificats.createdAt));
  }

  async getRecentInvoices(limit: number): Promise<Invoice[]> {
    return db.select().from(invoices).orderBy(desc(invoices.createdAt)).limit(limit);
  }

  async getRecentCertificats(limit: number): Promise<Certificat[]> {
    return db.select().from(certificats).orderBy(desc(certificats.createdAt)).limit(limit);
  }

  async getContractors(): Promise<Contractor[]> {
    return db.select().from(contractors).orderBy(contractors.name);
  }

  async getContractor(id: number): Promise<Contractor | undefined> {
    const [contractor] = await db.select().from(contractors).where(eq(contractors.id, id));
    return contractor;
  }

  async createContractor(data: InsertContractor): Promise<Contractor> {
    const [contractor] = await db.insert(contractors).values(data).returning();
    return contractor;
  }

  async updateContractor(id: number, data: Partial<InsertContractor>): Promise<Contractor | undefined> {
    const [contractor] = await db.update(contractors).set(data).where(eq(contractors.id, id)).returning();
    return contractor;
  }

  async getDevisByContractor(contractorId: number): Promise<Devis[]> {
    return db.select().from(devis).where(eq(devis.contractorId, contractorId)).orderBy(devis.devisCode);
  }

  async getInvoicesByContractor(contractorId: number): Promise<Invoice[]> {
    return db.select().from(invoices).where(eq(invoices.contractorId, contractorId)).orderBy(desc(invoices.createdAt));
  }

  async getLotsByProject(projectId: number): Promise<Lot[]> {
    return db.select().from(lots).where(eq(lots.projectId, projectId)).orderBy(lots.lotNumber);
  }

  async createLot(data: InsertLot): Promise<Lot> {
    const [lot] = await db.insert(lots).values(data).returning();
    return lot;
  }

  async updateLot(id: number, data: Partial<InsertLot>): Promise<Lot | undefined> {
    const [lot] = await db.update(lots).set(data).where(eq(lots.id, id)).returning();
    return lot;
  }

  async deleteLot(id: number): Promise<void> {
    await db.delete(lots).where(eq(lots.id, id));
  }

  async getLotCatalog(): Promise<LotCatalog[]> {
    return db.select().from(lotCatalog).orderBy(asc(lotCatalog.code));
  }

  async getLotCatalogByCode(code: string): Promise<LotCatalog | undefined> {
    const [row] = await db.select().from(lotCatalog).where(eq(lotCatalog.code, code)).limit(1);
    return row;
  }

  async getLotCatalogEntry(id: number): Promise<LotCatalog | undefined> {
    const [row] = await db.select().from(lotCatalog).where(eq(lotCatalog.id, id)).limit(1);
    return row;
  }

  async createLotCatalogEntry(data: InsertLotCatalog): Promise<LotCatalog> {
    const [row] = await db.insert(lotCatalog).values(data).returning();
    return row;
  }

  async updateLotCatalogEntry(id: number, data: Partial<InsertLotCatalog>): Promise<LotCatalog | undefined> {
    const existing = await this.getLotCatalogEntry(id);
    if (!existing) return undefined;
    return db.transaction(async (tx) => {
      const [updated] = await tx.update(lotCatalog).set(data).where(eq(lotCatalog.id, id)).returning();
      if (!updated) return undefined;
      const codeChanged = data.code !== undefined && data.code !== existing.code;
      const descChanged = data.descriptionFr !== undefined && data.descriptionFr !== existing.descriptionFr;
      const ukChanged = data.descriptionUk !== undefined && data.descriptionUk !== existing.descriptionUk;
      if (codeChanged || descChanged) {
        const setClause: { lotNumber?: string; descriptionFr?: string } = {};
        if (codeChanged) setClause.lotNumber = updated.code;
        if (descChanged) setClause.descriptionFr = updated.descriptionFr;
        await tx.update(lots).set(setClause).where(eq(lots.lotNumber, existing.code));
      }
      if (ukChanged && updated.descriptionUk !== null) {
        await tx
          .update(lots)
          .set({ descriptionUk: updated.descriptionUk })
          .where(and(eq(lots.lotNumber, updated.code), isNull(lots.descriptionUk)));
      }
      return updated;
    });
  }

  async deleteLotCatalogEntry(id: number): Promise<void> {
    await db.delete(lotCatalog).where(eq(lotCatalog.id, id));
  }

  async getWishListItems(): Promise<WishListItem[]> {
    return db.select().from(wishListItems).orderBy(desc(wishListItems.createdAt));
  }

  async getWishListItem(id: number): Promise<WishListItem | undefined> {
    const [row] = await db.select().from(wishListItems).where(eq(wishListItems.id, id)).limit(1);
    return row;
  }

  async createWishListItem(data: InsertWishListItem): Promise<WishListItem> {
    const [row] = await db.insert(wishListItems).values(data).returning();
    return row;
  }

  async updateWishListItem(id: number, data: UpdateWishListItem): Promise<WishListItem | undefined> {
    const [row] = await db
      .update(wishListItems)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(wishListItems.id, id))
      .returning();
    return row;
  }

  async deleteWishListItem(id: number): Promise<void> {
    await db.delete(wishListItems).where(eq(wishListItems.id, id));
  }

  async countProjectLotsByCode(code: string): Promise<number> {
    const rows = await db.select({ id: lots.id }).from(lots).where(eq(lots.lotNumber, code));
    return rows.length;
  }

  async ensureProjectLotFromCatalog(projectId: number, catalogCode: string): Promise<Lot | undefined> {
    const normalizedCode = catalogCode.trim().toUpperCase();
    const entry = await this.getLotCatalogByCode(normalizedCode);
    if (!entry) {
      return undefined;
    }
    const [row] = await db
      .insert(lots)
      .values({
        projectId,
        lotNumber: entry.code,
        descriptionFr: entry.descriptionFr,
        descriptionUk: entry.descriptionUk,
      })
      .onConflictDoUpdate({
        target: [lots.projectId, lots.lotNumber],
        set: {
          descriptionFr: entry.descriptionFr,
          ...(entry.descriptionUk !== null
            ? { descriptionUk: sql`COALESCE(${lots.descriptionUk}, ${entry.descriptionUk})` }
            : {}),
        },
      })
      .returning();
    return row;
  }

  async getMarchesByProject(projectId: number): Promise<Marche[]> {
    return db.select().from(marches).where(eq(marches.projectId, projectId)).orderBy(desc(marches.createdAt));
  }

  async getMarche(id: number): Promise<Marche | undefined> {
    const [marche] = await db.select().from(marches).where(eq(marches.id, id));
    return marche;
  }

  async createMarche(data: InsertMarche): Promise<Marche> {
    const [marche] = await db.insert(marches).values(data).returning();
    return marche;
  }

  async updateMarche(id: number, data: Partial<InsertMarche>): Promise<Marche | undefined> {
    const [marche] = await db.update(marches).set(data).where(eq(marches.id, id)).returning();
    return marche;
  }

  async getDevisByProject(projectId: number): Promise<Devis[]> {
    return db.select().from(devis).where(eq(devis.projectId, projectId)).orderBy(devis.devisCode);
  }

  async getDevis(id: number): Promise<Devis | undefined> {
    const [d] = await db.select().from(devis).where(eq(devis.id, id));
    return d;
  }

  async createDevis(data: InsertDevis): Promise<Devis> {
    const [d] = await db.insert(devis).values(data).returning();
    return d;
  }

  async updateDevis(id: number, data: Partial<InsertDevis>): Promise<Devis | undefined> {
    const [d] = await db.update(devis).set({ ...data, updatedAt: new Date() }).where(eq(devis.id, id)).returning();
    return d;
  }

  async getDevisRefEdits(devisId: number): Promise<DevisRefEdit[]> {
    return db.select().from(devisRefEdits).where(eq(devisRefEdits.devisId, devisId)).orderBy(desc(devisRefEdits.editedAt));
  }

  async createDevisRefEdit(data: InsertDevisRefEdit): Promise<DevisRefEdit> {
    const [row] = await db.insert(devisRefEdits).values(data).returning();
    return row;
  }

  async getDevisLineItems(devisId: number): Promise<DevisLineItem[]> {
    return db.select().from(devisLineItems).where(eq(devisLineItems.devisId, devisId)).orderBy(devisLineItems.lineNumber);
  }

  async createDevisLineItem(data: InsertDevisLineItem): Promise<DevisLineItem> {
    const [item] = await db.insert(devisLineItems).values(data).returning();
    return item;
  }

  async updateDevisLineItem(id: number, data: Partial<InsertDevisLineItem>): Promise<DevisLineItem | undefined> {
    const [item] = await db.update(devisLineItems).set(data).where(eq(devisLineItems.id, id)).returning();
    return item;
  }

  async deleteDevisLineItem(id: number): Promise<void> {
    await db.delete(devisLineItems).where(eq(devisLineItems.id, id));
  }

  async getAvenantsByDevis(devisId: number): Promise<Avenant[]> {
    return db.select().from(avenants).where(eq(avenants.devisId, devisId)).orderBy(avenants.createdAt);
  }

  async createAvenant(data: InsertAvenant): Promise<Avenant> {
    const [avenant] = await db.insert(avenants).values(data).returning();
    return avenant;
  }

  async updateAvenant(id: number, data: Partial<InsertAvenant>): Promise<Avenant | undefined> {
    const [avenant] = await db.update(avenants).set(data).where(eq(avenants.id, id)).returning();
    return avenant;
  }

  async getInvoice(id: number): Promise<Invoice | undefined> {
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    return inv;
  }

  async getInvoicesByDevis(devisId: number): Promise<Invoice[]> {
    return db.select().from(invoices).where(eq(invoices.devisId, devisId)).orderBy(invoices.invoiceNumber);
  }

  async getInvoicesByProject(projectId: number): Promise<Invoice[]> {
    return db.select().from(invoices).where(eq(invoices.projectId, projectId)).orderBy(desc(invoices.createdAt));
  }

  async createInvoice(data: InsertInvoice): Promise<Invoice> {
    const [invoice] = await db.insert(invoices).values(data).returning();
    return invoice;
  }

  async updateInvoice(id: number, data: Partial<InsertInvoice>): Promise<Invoice | undefined> {
    const [invoice] = await db.update(invoices).set(data).where(eq(invoices.id, id)).returning();
    return invoice;
  }

  async deleteInvoice(id: number): Promise<boolean> {
    const result = await db.delete(invoices).where(eq(invoices.id, id)).returning();
    return result.length > 0;
  }

  async getInvoiceRefEdits(invoiceId: number): Promise<InvoiceRefEdit[]> {
    return db.select().from(invoiceRefEdits).where(eq(invoiceRefEdits.invoiceId, invoiceId)).orderBy(desc(invoiceRefEdits.editedAt));
  }

  async createInvoiceRefEdit(data: InsertInvoiceRefEdit): Promise<InvoiceRefEdit> {
    const [row] = await db.insert(invoiceRefEdits).values(data).returning();
    return row;
  }

  async getSituationsByDevis(devisId: number): Promise<Situation[]> {
    return db.select().from(situations).where(eq(situations.devisId, devisId)).orderBy(situations.situationNumber);
  }

  async getSituation(id: number): Promise<Situation | undefined> {
    const [situation] = await db.select().from(situations).where(eq(situations.id, id));
    return situation;
  }

  async createSituation(data: InsertSituation): Promise<Situation> {
    const [situation] = await db.insert(situations).values(data).returning();
    return situation;
  }

  async updateSituation(id: number, data: Partial<InsertSituation>): Promise<Situation | undefined> {
    const [situation] = await db.update(situations).set(data).where(eq(situations.id, id)).returning();
    return situation;
  }

  async getSituationLines(situationId: number): Promise<SituationLine[]> {
    return db.select().from(situationLines).where(eq(situationLines.situationId, situationId));
  }

  async createSituationLine(data: InsertSituationLine): Promise<SituationLine> {
    const [line] = await db.insert(situationLines).values(data).returning();
    return line;
  }

  async getCertificatsByProject(projectId: number): Promise<Certificat[]> {
    return db.select().from(certificats).where(eq(certificats.projectId, projectId)).orderBy(desc(certificats.createdAt));
  }

  async getCertificatsByProjectAndContractor(projectId: number, contractorId: number): Promise<Certificat[]> {
    return db.select().from(certificats).where(and(eq(certificats.projectId, projectId), eq(certificats.contractorId, contractorId))).orderBy(certificats.dateIssued);
  }

  async getCertificat(id: number): Promise<Certificat | undefined> {
    const [cert] = await db.select().from(certificats).where(eq(certificats.id, id));
    return cert;
  }

  async createCertificat(data: InsertCertificat): Promise<Certificat> {
    const [cert] = await db.insert(certificats).values(data).returning();
    return cert;
  }

  async updateCertificat(id: number, data: Partial<InsertCertificat>): Promise<Certificat | undefined> {
    const [cert] = await db.update(certificats).set(data).where(eq(certificats.id, id)).returning();
    return cert;
  }

  async getFeesByProject(projectId: number): Promise<Fee[]> {
    return db.select().from(fees).where(eq(fees.projectId, projectId));
  }

  async createFee(data: InsertFee): Promise<Fee> {
    const [fee] = await db.insert(fees).values(data).returning();
    return fee;
  }

  async updateFee(id: number, data: Partial<InsertFee>): Promise<Fee | undefined> {
    const [fee] = await db.update(fees).set(data).where(eq(fees.id, id)).returning();
    return fee;
  }

  async getFeeEntries(feeId: number): Promise<FeeEntry[]> {
    return db.select().from(feeEntries).where(eq(feeEntries.feeId, feeId)).orderBy(feeEntries.createdAt);
  }

  async getFeeEntriesByProject(projectId: number): Promise<FeeEntry[]> {
    const projectFees = await this.getFeesByProject(projectId);
    const feeIds = projectFees.map(f => f.id);
    if (feeIds.length === 0) return [];
    const allEntries: FeeEntry[] = [];
    for (const feeId of feeIds) {
      const entries = await this.getFeeEntries(feeId);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  async createFeeEntry(data: InsertFeeEntry): Promise<FeeEntry> {
    const [entry] = await db.insert(feeEntries).values(data).returning();
    return entry;
  }

  async updateFeeEntry(id: number, data: Partial<InsertFeeEntry>): Promise<FeeEntry | undefined> {
    const [entry] = await db.update(feeEntries).set(data).where(eq(feeEntries.id, id)).returning();
    return entry;
  }

  async getProjectByArchidocId(archidocId: string): Promise<Project | undefined> {
    const [project] = await db.select().from(projects).where(eq(projects.archidocId, archidocId));
    return project;
  }

  async getProjectByName(name: string): Promise<Project | undefined> {
    const [project] = await db.select().from(projects).where(eq(projects.name, name));
    return project;
  }

  async getContractorByArchidocId(archidocId: string): Promise<Contractor | undefined> {
    const [contractor] = await db.select().from(contractors).where(eq(contractors.archidocId, archidocId));
    return contractor;
  }

  async getTrackedArchidocProjectIds(): Promise<string[]> {
    const tracked = await db
      .select({ archidocId: projects.archidocId })
      .from(projects)
      .where(isNotNull(projects.archidocId));
    return tracked
      .map(p => p.archidocId)
      .filter((id): id is string => id !== null && id !== undefined);
  }

  async getArchidocProjects(): Promise<ArchidocProject[]> {
    return db.select().from(archidocProjects).orderBy(archidocProjects.projectName);
  }

  async getArchidocProject(archidocId: string): Promise<ArchidocProject | undefined> {
    const [project] = await db.select().from(archidocProjects).where(eq(archidocProjects.archidocId, archidocId));
    return project;
  }

  async upsertArchidocProject(data: Omit<ArchidocProject, "syncedAt">): Promise<ArchidocProject> {
    const [result] = await db
      .insert(archidocProjects)
      .values({ ...data, syncedAt: new Date() })
      .onConflictDoUpdate({
        target: archidocProjects.archidocId,
        set: { ...data, syncedAt: new Date() },
      })
      .returning();
    return result;
  }

  async getArchidocContractors(): Promise<ArchidocContractor[]> {
    return db.select().from(archidocContractors).orderBy(archidocContractors.name);
  }

  async getArchidocContractor(archidocId: string): Promise<ArchidocContractor | undefined> {
    const [contractor] = await db.select().from(archidocContractors).where(eq(archidocContractors.archidocId, archidocId));
    return contractor;
  }

  async upsertArchidocContractor(data: Omit<ArchidocContractor, "syncedAt">): Promise<ArchidocContractor> {
    const [result] = await db
      .insert(archidocContractors)
      .values({ ...data, syncedAt: new Date() })
      .onConflictDoUpdate({
        target: archidocContractors.archidocId,
        set: { ...data, syncedAt: new Date() },
      })
      .returning();
    return result;
  }

  async getArchidocTrades(): Promise<ArchidocTrade[]> {
    return db.select().from(archidocTrades).orderBy(archidocTrades.sortOrder);
  }

  async upsertArchidocTrade(data: Omit<ArchidocTrade, "syncedAt">): Promise<ArchidocTrade> {
    const [result] = await db
      .insert(archidocTrades)
      .values({ ...data, syncedAt: new Date() })
      .onConflictDoUpdate({
        target: archidocTrades.archidocId,
        set: { ...data, syncedAt: new Date() },
      })
      .returning();
    return result;
  }

  async getArchidocProposalFees(archidocProjectId: string): Promise<ArchidocProposalFee[]> {
    return db.select().from(archidocProposalFees).where(eq(archidocProposalFees.archidocProjectId, archidocProjectId));
  }

  async upsertArchidocProposalFee(data: Omit<ArchidocProposalFee, "id" | "syncedAt">): Promise<ArchidocProposalFee> {
    const existing = await db.select().from(archidocProposalFees).where(eq(archidocProposalFees.archidocProjectId, data.archidocProjectId));
    if (existing.length > 0) {
      const [result] = await db
        .update(archidocProposalFees)
        .set({ ...data, syncedAt: new Date() })
        .where(eq(archidocProposalFees.archidocProjectId, data.archidocProjectId))
        .returning();
      return result;
    }
    const [result] = await db
      .insert(archidocProposalFees)
      .values({ ...data, syncedAt: new Date() })
      .returning();
    return result;
  }

  async createSyncLogEntry(data: { syncType: string; status: string; errorMessage?: string }): Promise<ArchidocSyncLogEntry> {
    const [entry] = await db
      .insert(archidocSyncLog)
      .values({
        syncType: data.syncType,
        status: data.status,
        errorMessage: data.errorMessage,
      })
      .returning();
    return entry;
  }

  async updateSyncLogEntry(id: number, data: Partial<{ status: string; completedAt: Date; recordsUpdated: number; errorMessage: string }>): Promise<ArchidocSyncLogEntry | undefined> {
    const [entry] = await db
      .update(archidocSyncLog)
      .set(data)
      .where(eq(archidocSyncLog.id, id))
      .returning();
    return entry;
  }

  async getRecentSyncLogs(limit: number): Promise<ArchidocSyncLogEntry[]> {
    return db.select().from(archidocSyncLog).orderBy(desc(archidocSyncLog.startedAt)).limit(limit);
  }

  async getArchidocSiretIssues(): Promise<ArchidocSiretIssue[]> {
    return db.select().from(archidocSiretIssues).orderBy(desc(archidocSiretIssues.lastSeenAt));
  }

  async getEmailDocuments(filters?: { projectId?: number; status?: string; documentType?: string }): Promise<EmailDocument[]> {
    let query = db.select().from(emailDocuments).orderBy(desc(emailDocuments.createdAt));
    if (filters?.projectId) {
      return db.select().from(emailDocuments).where(eq(emailDocuments.projectId, filters.projectId)).orderBy(desc(emailDocuments.createdAt));
    }
    if (filters?.status) {
      return db.select().from(emailDocuments).where(eq(emailDocuments.extractionStatus, filters.status)).orderBy(desc(emailDocuments.createdAt));
    }
    if (filters?.documentType) {
      return db.select().from(emailDocuments).where(eq(emailDocuments.documentType, filters.documentType)).orderBy(desc(emailDocuments.createdAt));
    }
    return db.select().from(emailDocuments).orderBy(desc(emailDocuments.createdAt));
  }

  async getEmailDocument(id: number): Promise<EmailDocument | undefined> {
    const [doc] = await db.select().from(emailDocuments).where(eq(emailDocuments.id, id));
    return doc;
  }

  async getEmailDocumentByMessageId(messageId: string): Promise<EmailDocument | undefined> {
    const [doc] = await db.select().from(emailDocuments).where(eq(emailDocuments.emailMessageId, messageId));
    return doc;
  }

  async createEmailDocument(data: InsertEmailDocument): Promise<EmailDocument> {
    const [doc] = await db.insert(emailDocuments).values(data).returning();
    return doc;
  }

  async updateEmailDocument(id: number, data: Partial<InsertEmailDocument>): Promise<EmailDocument | undefined> {
    const [doc] = await db.update(emailDocuments).set({ ...data, updatedAt: new Date() }).where(eq(emailDocuments.id, id)).returning();
    return doc;
  }

  async updateEmailDocumentLabelStatus(messageId: string): Promise<void> {
    await db.update(emailDocuments)
      .set({ gmailLabelApplied: true })
      .where(like(emailDocuments.emailMessageId, `${messageId}%`));
  }

  async getPendingEmailDocuments(): Promise<EmailDocument[]> {
    return db.select().from(emailDocuments).where(eq(emailDocuments.extractionStatus, "pending")).orderBy(emailDocuments.createdAt);
  }

  async getProjectDocuments(projectId: number): Promise<ProjectDocument[]> {
    return db.select().from(projectDocuments).where(eq(projectDocuments.projectId, projectId)).orderBy(desc(projectDocuments.createdAt));
  }

  async getProjectDocument(id: number): Promise<ProjectDocument | undefined> {
    const [doc] = await db.select().from(projectDocuments).where(eq(projectDocuments.id, id));
    return doc;
  }

  async createProjectDocument(data: InsertProjectDocument): Promise<ProjectDocument> {
    const [doc] = await db.insert(projectDocuments).values(data).returning();
    return doc;
  }

  async getProjectCommunications(projectId: number): Promise<ProjectCommunication[]> {
    return db.select().from(projectCommunications).where(eq(projectCommunications.projectId, projectId)).orderBy(desc(projectCommunications.createdAt));
  }

  async getAllCommunications(): Promise<ProjectCommunication[]> {
    return db.select().from(projectCommunications).orderBy(desc(projectCommunications.createdAt));
  }

  async getProjectCommunication(id: number): Promise<ProjectCommunication | undefined> {
    const [comm] = await db.select().from(projectCommunications).where(eq(projectCommunications.id, id));
    return comm;
  }

  async createProjectCommunication(data: InsertProjectCommunication): Promise<ProjectCommunication> {
    const [comm] = await db.insert(projectCommunications).values(data).returning();
    return comm;
  }

  async updateProjectCommunication(id: number, data: Partial<InsertProjectCommunication>): Promise<ProjectCommunication | undefined> {
    const [comm] = await db.update(projectCommunications).set(data).where(eq(projectCommunications.id, id)).returning();
    return comm;
  }

  async getPaymentReminders(projectId: number): Promise<PaymentReminder[]> {
    return db.select().from(paymentReminders).where(eq(paymentReminders.projectId, projectId)).orderBy(paymentReminders.scheduledDate);
  }

  async getPaymentReminder(id: number): Promise<PaymentReminder | undefined> {
    const [reminder] = await db.select().from(paymentReminders).where(eq(paymentReminders.id, id));
    return reminder;
  }

  async createPaymentReminder(data: InsertPaymentReminder): Promise<PaymentReminder> {
    const [reminder] = await db.insert(paymentReminders).values(data).returning();
    return reminder;
  }

  async updatePaymentReminder(id: number, data: Partial<InsertPaymentReminder>): Promise<PaymentReminder | undefined> {
    const [reminder] = await db.update(paymentReminders).set(data).where(eq(paymentReminders.id, id)).returning();
    return reminder;
  }

  async getDuePaymentReminders(dateStr: string): Promise<PaymentReminder[]> {
    return db.select().from(paymentReminders)
      .where(and(
        eq(paymentReminders.status, "scheduled"),
        lte(paymentReminders.scheduledDate, dateStr)
      ))
      .orderBy(paymentReminders.scheduledDate);
  }

  async getClientPaymentEvidence(projectId: number): Promise<ClientPaymentEvidence[]> {
    return db.select().from(clientPaymentEvidence).where(eq(clientPaymentEvidence.projectId, projectId)).orderBy(desc(clientPaymentEvidence.uploadedAt));
  }

  async createClientPaymentEvidence(data: InsertClientPaymentEvidence): Promise<ClientPaymentEvidence> {
    const [evidence] = await db.insert(clientPaymentEvidence).values(data).returning();
    return evidence;
  }

  async getDevisTranslation(devisId: number): Promise<DevisTranslation | undefined> {
    const [row] = await db.select().from(devisTranslations).where(eq(devisTranslations.devisId, devisId));
    return row;
  }

  async upsertDevisTranslation(data: InsertDevisTranslation): Promise<DevisTranslation> {
    const [row] = await db
      .insert(devisTranslations)
      .values(data)
      .onConflictDoUpdate({
        target: devisTranslations.devisId,
        set: { ...data, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async updateDevisTranslation(devisId: number, data: Partial<InsertDevisTranslation>): Promise<DevisTranslation | undefined> {
    const [row] = await db
      .update(devisTranslations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(devisTranslations.devisId, devisId))
      .returning();
    return row;
  }

  async getAiModelSettings(): Promise<AiModelSetting[]> {
    return db.select().from(aiModelSettings).orderBy(aiModelSettings.taskType);
  }

  async getAiModelSetting(taskType: string): Promise<AiModelSetting | undefined> {
    const [setting] = await db.select().from(aiModelSettings).where(eq(aiModelSettings.taskType, taskType));
    return setting;
  }

  async upsertAiModelSetting(taskType: string, provider: string, modelId: string): Promise<AiModelSetting> {
    const existing = await this.getAiModelSetting(taskType);
    if (existing) {
      const [updated] = await db.update(aiModelSettings)
        .set({ provider, modelId, updatedAt: new Date() })
        .where(eq(aiModelSettings.taskType, taskType))
        .returning();
      return updated;
    }
    const [created] = await db.insert(aiModelSettings)
      .values({ taskType, provider, modelId })
      .returning();
    return created;
  }

  async getTemplateAssets(): Promise<TemplateAsset[]> {
    return db.select().from(templateAssets).orderBy(templateAssets.assetType);
  }

  async getTemplateAssetByType(assetType: string): Promise<TemplateAsset | undefined> {
    const [asset] = await db.select().from(templateAssets).where(eq(templateAssets.assetType, assetType));
    return asset;
  }

  async upsertTemplateAsset(data: InsertTemplateAsset): Promise<TemplateAsset> {
    const existing = await this.getTemplateAssetByType(data.assetType);
    if (existing) {
      const [updated] = await db.update(templateAssets)
        .set({ fileName: data.fileName, storageKey: data.storageKey, mimeType: data.mimeType, uploadedAt: new Date() })
        .where(eq(templateAssets.assetType, data.assetType))
        .returning();
      return updated;
    }
    const [created] = await db.insert(templateAssets).values(data).returning();
    return created;
  }

  async deleteTemplateAsset(id: number): Promise<void> {
    await db.delete(templateAssets).where(eq(templateAssets.id, id));
  }

  async getNextCertificateRef(projectId: number): Promise<string> {
    const existing = await db.select().from(certificats).where(eq(certificats.projectId, projectId));
    let maxNum = 0;
    for (const cert of existing) {
      const match = cert.certificateRef.match(/^C(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
    return `C${maxNum + 1}`;
  }

  async getDevisByProjectAndContractor(projectId: number, contractorId: number): Promise<Devis[]> {
    return db.select().from(devis).where(
      and(eq(devis.projectId, projectId), eq(devis.contractorId, contractorId))
    ).orderBy(devis.devisCode);
  }

  async getLot(id: number): Promise<import("@shared/schema").Lot | undefined> {
    const [lot] = await db.select().from(lots).where(eq(lots.id, id));
    return lot;
  }

  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.googleId, googleId));
    return user;
  }

  async getBenchmarkTags(): Promise<BenchmarkTag[]> {
    return db.select().from(benchmarkTags).orderBy(benchmarkTags.label);
  }

  async upsertBenchmarkTag(data: InsertBenchmarkTag): Promise<BenchmarkTag> {
    const [result] = await db
      .insert(benchmarkTags)
      .values(data)
      .onConflictDoUpdate({
        target: benchmarkTags.label,
        set: { category: data.category ?? null },
      })
      .returning();
    return result;
  }

  async getBenchmarkDocuments(): Promise<BenchmarkDocument[]> {
    return db.select().from(benchmarkDocuments).orderBy(desc(benchmarkDocuments.createdAt));
  }

  async getBenchmarkDocument(id: number): Promise<BenchmarkDocument | undefined> {
    const [doc] = await db.select().from(benchmarkDocuments).where(eq(benchmarkDocuments.id, id));
    return doc;
  }

  async getBenchmarkDocumentBySourceDevis(devisId: number): Promise<BenchmarkDocument | undefined> {
    const [doc] = await db.select().from(benchmarkDocuments).where(eq(benchmarkDocuments.sourceDevisId, devisId));
    return doc;
  }

  async createBenchmarkDocument(data: InsertBenchmarkDocument): Promise<BenchmarkDocument> {
    const [doc] = await db.insert(benchmarkDocuments).values(data).returning();
    return doc;
  }

  async updateBenchmarkDocument(id: number, data: Partial<InsertBenchmarkDocument>): Promise<BenchmarkDocument | undefined> {
    const [doc] = await db.update(benchmarkDocuments).set(data).where(eq(benchmarkDocuments.id, id)).returning();
    return doc;
  }

  async deleteBenchmarkDocument(id: number): Promise<void> {
    await db.delete(benchmarkDocuments).where(eq(benchmarkDocuments.id, id));
  }

  async createBenchmarkItem(data: InsertBenchmarkItem): Promise<BenchmarkItem> {
    const [item] = await db.insert(benchmarkItems).values(data).returning();
    return item;
  }

  async deleteBenchmarkItem(id: number): Promise<void> {
    await db.delete(benchmarkItems).where(eq(benchmarkItems.id, id));
  }

  async deleteBenchmarkItemsByDocument(documentId: number): Promise<void> {
    await db.delete(benchmarkItems).where(eq(benchmarkItems.documentId, documentId));
  }

  async setBenchmarkItemTags(itemId: number, tagIds: number[]): Promise<void> {
    await db.delete(benchmarkItemTags).where(eq(benchmarkItemTags.itemId, itemId));
    if (tagIds.length === 0) return;
    const rows = tagIds.map(tagId => ({ itemId, tagId }));
    await db.insert(benchmarkItemTags).values(rows).onConflictDoNothing();
  }

  async getBenchmarkItemTags(itemId: number): Promise<BenchmarkTag[]> {
    const rows = await db
      .select({ tag: benchmarkTags })
      .from(benchmarkItemTags)
      .innerJoin(benchmarkTags, eq(benchmarkItemTags.tagId, benchmarkTags.id))
      .where(eq(benchmarkItemTags.itemId, itemId));
    return rows.map(r => r.tag);
  }

  async searchBenchmarkItems(filters: BenchmarkSearchFilters): Promise<BenchmarkSearchRow[]> {
    const conditions: SQL[] = [];
    if (filters.contractorId != null) conditions.push(eq(benchmarkDocuments.contractorId, filters.contractorId));
    if (filters.dateFrom) conditions.push(gte(benchmarkDocuments.documentDate, filters.dateFrom));
    if (filters.dateTo) conditions.push(lte(benchmarkDocuments.documentDate, filters.dateTo));
    if (filters.normalizedUnit) conditions.push(eq(benchmarkItems.normalizedUnit, filters.normalizedUnit));
    if (filters.minPrice != null) conditions.push(gte(benchmarkItems.normalizedUnitPriceHt, String(filters.minPrice)));
    if (filters.maxPrice != null) conditions.push(lte(benchmarkItems.normalizedUnitPriceHt, String(filters.maxPrice)));
    if (filters.needsReview != null) conditions.push(eq(benchmarkItems.needsReview, filters.needsReview));

    const trimmedQ = filters.q?.trim();
    if (trimmedQ && trimmedQ.length > 0) {
      // Postgres full-text search with French dictionary, OR'd with ILIKE
      // for partial/typo-tolerant fallback. websearch_to_tsquery handles
      // bare terms, quoted phrases, and "or"/"-" operators safely.
      conditions.push(
        sql`(to_tsvector('french', ${benchmarkItems.description}) @@ websearch_to_tsquery('french', ${trimmedQ}) OR ${benchmarkItems.description} ILIKE ${"%" + trimmedQ + "%"})`,
      );
    }

    if (filters.tagIds && filters.tagIds.length > 0) {
      const taggedItems = await db
        .selectDistinct({ itemId: benchmarkItemTags.itemId })
        .from(benchmarkItemTags)
        .where(inArray(benchmarkItemTags.tagId, filters.tagIds));
      const ids = taggedItems.map(t => t.itemId);
      if (ids.length === 0) return [];
      conditions.push(inArray(benchmarkItems.id, ids));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = filters.limit ?? 200;

    // Relevance ranking. Lower rank wins; we order by rank then date.
    // 0 = description starts with the query (best), 1 = FTS match,
    // 2 = ILIKE substring match only, 3 = no text query.
    const relevance: SQL<number> = trimmedQ && trimmedQ.length > 0
      ? sql<number>`CASE
          WHEN ${benchmarkItems.description} ILIKE ${trimmedQ + "%"} THEN 0
          WHEN to_tsvector('french', ${benchmarkItems.description}) @@ websearch_to_tsquery('french', ${trimmedQ}) THEN 1
          ELSE 2
        END`
      : sql<number>`3`;

    const rows = await db
      .select({
        item: benchmarkItems,
        document: benchmarkDocuments,
        contractor: contractors,
      })
      .from(benchmarkItems)
      .innerJoin(benchmarkDocuments, eq(benchmarkItems.documentId, benchmarkDocuments.id))
      .leftJoin(contractors, eq(benchmarkDocuments.contractorId, contractors.id))
      .where(whereClause)
      .orderBy(asc(relevance), desc(benchmarkDocuments.documentDate), desc(benchmarkItems.id))
      .limit(limit);

    if (rows.length === 0) return [];
    const itemIds = rows.map(r => r.item.id);
    const tagJoinRows = await db
      .select({ itemId: benchmarkItemTags.itemId, tag: benchmarkTags })
      .from(benchmarkItemTags)
      .innerJoin(benchmarkTags, eq(benchmarkItemTags.tagId, benchmarkTags.id))
      .where(inArray(benchmarkItemTags.itemId, itemIds));

    const tagsByItem = new Map<number, BenchmarkTag[]>();
    for (const tj of tagJoinRows) {
      const arr = tagsByItem.get(tj.itemId) ?? [];
      arr.push(tj.tag);
      tagsByItem.set(tj.itemId, arr);
    }

    return rows.map(r => ({
      item: r.item,
      document: r.document,
      contractorName: r.contractor?.name ?? r.document.externalContractorName ?? null,
      tags: tagsByItem.get(r.item.id) ?? [],
    }));
  }

  async aggregateBenchmarkPrices(filters: BenchmarkSearchFilters): Promise<BenchmarkAggregateRow[]> {
    const rows = await this.searchBenchmarkItems({ ...filters, limit: 5000 });
    const groups = new Map<string, { tagId: number; tagLabel: string; normalizedUnit: string | null; prices: number[] }>();
    for (const row of rows) {
      const price = row.item.normalizedUnitPriceHt != null ? Number(row.item.normalizedUnitPriceHt) : null;
      if (price == null || !Number.isFinite(price)) continue;
      const tagsToUse = row.tags.length > 0 ? row.tags : [{ id: 0, label: "(untagged)" } as BenchmarkTag];
      for (const tag of tagsToUse) {
        const key = `${tag.id}::${row.item.normalizedUnit ?? "?"}`;
        let g = groups.get(key);
        if (!g) {
          g = { tagId: tag.id, tagLabel: tag.label, normalizedUnit: row.item.normalizedUnit, prices: [] };
          groups.set(key, g);
        }
        g.prices.push(price);
      }
    }
    const result: BenchmarkAggregateRow[] = [];
    for (const g of Array.from(groups.values())) {
      const sorted = [...g.prices].sort((a, b) => a - b);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      result.push({
        tagId: g.tagId,
        tagLabel: g.tagLabel,
        normalizedUnit: g.normalizedUnit,
        count: g.prices.length,
        minPrice: Math.round(min * 100) / 100,
        medianPrice: Math.round(median * 100) / 100,
        maxPrice: Math.round(max * 100) / 100,
      });
    }
    result.sort((a, b) => b.count - a.count);
    return result;
  }

  async listDevisChecks(devisId: number): Promise<DevisCheck[]> {
    return db.select().from(devisChecks).where(eq(devisChecks.devisId, devisId)).orderBy(asc(devisChecks.createdAt));
  }

  async getDevisCheck(id: number): Promise<DevisCheck | undefined> {
    const [c] = await db.select().from(devisChecks).where(eq(devisChecks.id, id));
    return c;
  }

  async createDevisCheck(data: InsertDevisCheck): Promise<DevisCheck> {
    const [created] = await db.insert(devisChecks).values(data).returning();
    return created;
  }

  async updateDevisCheck(
    id: number,
    data: Partial<InsertDevisCheck> & { resolvedAt?: Date | null; resolvedByUserId?: number | null },
  ): Promise<DevisCheck | undefined> {
    const [updated] = await db
      .update(devisChecks)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(devisChecks.id, id))
      .returning();
    return updated;
  }

  async upsertLineItemCheck(
    devisId: number,
    lineItemId: number,
    query: string,
    userId: number | null,
  ): Promise<DevisCheck> {
    // Atomic upsert keyed on the partial unique index
    // `devis_checks_line_item_unique_idx` over (devisId, lineItemId)
    // WHERE origin = 'line_item' AND lineItemId IS NOT NULL.
    // Using ON CONFLICT DO UPDATE prevents the SELECT-then-INSERT race
    // when an architect rapidly toggles a line item's flag (two concurrent
    // PATCH requests would previously hit the unique-index violation and
    // surface as a 500).
    const [row] = await db
      .insert(devisChecks)
      .values({
        devisId,
        origin: "line_item",
        lineItemId,
        status: "open",
        query,
        createdByUserId: userId ?? undefined,
      })
      .onConflictDoUpdate({
        target: [devisChecks.devisId, devisChecks.lineItemId],
        targetWhere: sql`${devisChecks.origin} = 'line_item' AND ${devisChecks.lineItemId} IS NOT NULL`,
        set: { query, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async countOpenDevisChecks(devisId: number): Promise<number> {
    const rows = await db
      .select({ id: devisChecks.id })
      .from(devisChecks)
      .where(
        and(
          eq(devisChecks.devisId, devisId),
          inArray(devisChecks.status, ["open", "awaiting_contractor", "awaiting_architect"]),
        ),
      );
    return rows.length;
  }

  async isDevisChecking(devisId: number): Promise<boolean> {
    const rows = await db
      .select({ id: devisChecks.id })
      .from(devisChecks)
      .where(
        and(
          eq(devisChecks.devisId, devisId),
          inArray(devisChecks.status, ["awaiting_contractor", "awaiting_architect"]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async listDevisCheckMessages(checkId: number): Promise<DevisCheckMessage[]> {
    return db
      .select()
      .from(devisCheckMessages)
      .where(eq(devisCheckMessages.checkId, checkId))
      .orderBy(asc(devisCheckMessages.createdAt));
  }

  async createDevisCheckMessage(data: InsertDevisCheckMessage): Promise<DevisCheckMessage> {
    const [created] = await db.insert(devisCheckMessages).values(data).returning();
    return created;
  }

  async getActiveDevisCheckToken(devisId: number): Promise<DevisCheckToken | undefined> {
    const [t] = await db
      .select()
      .from(devisCheckTokens)
      .where(and(eq(devisCheckTokens.devisId, devisId), isNull(devisCheckTokens.revokedAt)))
      .limit(1);
    return t;
  }

  async createDevisCheckToken(data: InsertDevisCheckToken): Promise<DevisCheckToken> {
    // Revoke any existing active token first to satisfy the partial unique index.
    await this.revokeDevisCheckTokensForDevis(data.devisId);
    const [created] = await db.insert(devisCheckTokens).values(data).returning();
    return created;
  }

  async revokeDevisCheckTokensForDevis(devisId: number): Promise<void> {
    await db
      .update(devisCheckTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(devisCheckTokens.devisId, devisId), isNull(devisCheckTokens.revokedAt)));
  }

  async getDevisCheckTokenByHash(hash: string): Promise<DevisCheckToken | undefined> {
    const [t] = await db.select().from(devisCheckTokens).where(eq(devisCheckTokens.tokenHash, hash));
    return t;
  }

  async touchDevisCheckTokenUsed(id: number, expiresAt: Date | null): Promise<void> {
    await db
      .update(devisCheckTokens)
      .set({ lastUsedAt: new Date(), expiresAt })
      .where(eq(devisCheckTokens.id, id));
  }

  async revokeExpiredDevisCheckTokens(now: Date = new Date()): Promise<number> {
    const rows = await db
      .update(devisCheckTokens)
      .set({ revokedAt: now })
      .where(
        and(
          isNull(devisCheckTokens.revokedAt),
          isNotNull(devisCheckTokens.expiresAt),
          lte(devisCheckTokens.expiresAt, now),
        ),
      )
      .returning({ id: devisCheckTokens.id });
    return rows.length;
  }

  async getLatestSentDevisCheckBundle(devisId: number): Promise<ProjectCommunication | undefined> {
    // We use the dedupeKey prefix to scope to this devis without joining.
    const prefix = `devis-check-bundle:${devisId}:`;
    const rows = await db
      .select()
      .from(projectCommunications)
      .where(
        and(
          eq(projectCommunications.status, "sent"),
          like(projectCommunications.dedupeKey, `${prefix}%`),
        ),
      )
      .orderBy(desc(projectCommunications.sentAt))
      .limit(1);
    return rows[0];
  }

  async getMaxMessageIdForChecks(checkIds: number[]): Promise<number> {
    // Used by the bundled-send dedupe key as a "conversation revision"
    // fingerprint. Same set of checks + same max message id ⇒ nothing has
    // changed since the last dispatch ⇒ retry must be idempotent. A new
    // architect (or contractor) message bumps the max id ⇒ legitimate
    // follow-up dispatch ⇒ fresh send under a new dedupe key.
    if (checkIds.length === 0) return 0;
    const rows = await db
      .select({ id: devisCheckMessages.id })
      .from(devisCheckMessages)
      .where(inArray(devisCheckMessages.checkId, checkIds))
      .orderBy(desc(devisCheckMessages.id))
      .limit(1);
    return rows[0]?.id ?? 0;
  }

  async countSentDevisCheckBundles(devisId: number): Promise<number> {
    // Drives the per-dispatch "round" marker in the bundled-send dedupe key
    // so legitimate follow-up sends are NOT short-circuited by a prior
    // success on the same set of check ids.
    const prefix = `devis-check-bundle:${devisId}:`;
    const rows = await db
      .select({ id: projectCommunications.id })
      .from(projectCommunications)
      .where(
        and(
          eq(projectCommunications.status, "sent"),
          like(projectCommunications.dedupeKey, `${prefix}%`),
        ),
      );
    return rows.length;
  }

  async countOpenDevisChecksForProject(projectId: number): Promise<Record<number, number>> {
    const projectDevisRows = await db
      .select({ id: devis.id })
      .from(devis)
      .where(eq(devis.projectId, projectId));
    const ids = projectDevisRows.map((d) => d.id);
    if (ids.length === 0) return {};
    const rows = await db
      .select({ devisId: devisChecks.devisId, id: devisChecks.id })
      .from(devisChecks)
      .where(
        and(
          inArray(devisChecks.devisId, ids),
          inArray(devisChecks.status, ["open", "awaiting_contractor", "awaiting_architect"]),
        ),
      );
    const out: Record<number, number> = {};
    for (const r of rows) out[r.devisId] = (out[r.devisId] ?? 0) + 1;
    return out;
  }

  async getProjectCommunicationByDedupeKey(key: string): Promise<ProjectCommunication | undefined> {
    const [c] = await db
      .select()
      .from(projectCommunications)
      .where(eq(projectCommunications.dedupeKey, key));
    return c;
  }

  async upsertUser(data: InsertUser): Promise<User> {
    const existing = await this.getUserByGoogleId(data.googleId);
    if (existing) {
      const [updated] = await db.update(users).set({
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        profileImageUrl: data.profileImageUrl,
        lastLoginAt: new Date(),
      }).where(eq(users.id, existing.id)).returning();
      return updated;
    }
    const [created] = await db.insert(users).values(data).returning();
    return created;
  }
}

export const storage = new DatabaseStorage();
