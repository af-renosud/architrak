import { db } from "./db";
import { eq, desc, and, inArray, isNotNull, lte, like } from "drizzle-orm";
import {
  projects, contractors, lots, marches, devis, devisLineItems,
  avenants, invoices, situations, situationLines, certificats, fees, feeEntries,
  archidocProjects, archidocContractors, archidocTrades, archidocProposalFees, archidocSyncLog,
  emailDocuments, projectDocuments, projectCommunications, paymentReminders, clientPaymentEvidence,
  type Project, type InsertProject,
  type Contractor, type InsertContractor,
  type Lot, type InsertLot,
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
  type ArchidocProject, type ArchidocContractor, type ArchidocTrade, type ArchidocProposalFee, type ArchidocSyncLogEntry,
  type EmailDocument, type InsertEmailDocument,
  type ProjectDocument, type InsertProjectDocument,
  type ProjectCommunication, type InsertProjectCommunication,
  type PaymentReminder, type InsertPaymentReminder,
  type ClientPaymentEvidence, type InsertClientPaymentEvidence,
} from "@shared/schema";

export interface IStorage {
  getProjects(): Promise<Project[]>;
  getProject(id: number): Promise<Project | undefined>;
  createProject(data: InsertProject): Promise<Project>;
  updateProject(id: number, data: Partial<InsertProject>): Promise<Project | undefined>;
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

  getMarchesByProject(projectId: number): Promise<Marche[]>;
  getMarche(id: number): Promise<Marche | undefined>;
  createMarche(data: InsertMarche): Promise<Marche>;
  updateMarche(id: number, data: Partial<InsertMarche>): Promise<Marche | undefined>;

  getDevisByProject(projectId: number): Promise<Devis[]>;
  getDevis(id: number): Promise<Devis | undefined>;
  createDevis(data: InsertDevis): Promise<Devis>;
  updateDevis(id: number, data: Partial<InsertDevis>): Promise<Devis | undefined>;

  getDevisLineItems(devisId: number): Promise<DevisLineItem[]>;
  createDevisLineItem(data: InsertDevisLineItem): Promise<DevisLineItem>;
  updateDevisLineItem(id: number, data: Partial<InsertDevisLineItem>): Promise<DevisLineItem | undefined>;
  deleteDevisLineItem(id: number): Promise<void>;

  getAvenantsByDevis(devisId: number): Promise<Avenant[]>;
  createAvenant(data: InsertAvenant): Promise<Avenant>;
  updateAvenant(id: number, data: Partial<InsertAvenant>): Promise<Avenant | undefined>;

  getInvoicesByDevis(devisId: number): Promise<Invoice[]>;
  getInvoicesByProject(projectId: number): Promise<Invoice[]>;
  createInvoice(data: InsertInvoice): Promise<Invoice>;
  updateInvoice(id: number, data: Partial<InsertInvoice>): Promise<Invoice | undefined>;

  getSituationsByDevis(devisId: number): Promise<Situation[]>;
  getSituation(id: number): Promise<Situation | undefined>;
  createSituation(data: InsertSituation): Promise<Situation>;
  updateSituation(id: number, data: Partial<InsertSituation>): Promise<Situation | undefined>;

  getSituationLines(situationId: number): Promise<SituationLine[]>;
  createSituationLine(data: InsertSituationLine): Promise<SituationLine>;

  getCertificatsByProject(projectId: number): Promise<Certificat[]>;
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
}

export class DatabaseStorage implements IStorage {
  async getProjects(): Promise<Project[]> {
    return db.select().from(projects).orderBy(desc(projects.createdAt));
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
}

export const storage = new DatabaseStorage();
