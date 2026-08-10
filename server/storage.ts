import { db } from "./db";
import { eq, ne, desc, asc, and, or, inArray, isNotNull, isNull, lt, lte, gte, like, ilike, sql, type SQL } from "drizzle-orm";
import {
  devisLineContexts, devisLineContextAssets, devisCostAnalyses,
  type DevisLineContext, type InsertDevisLineContext,
  type DevisLineContextAsset, type InsertDevisLineContextAsset,
  type DevisCostAnalysis,
  projects, contractors, lots, lotCatalog, marches, devis, devisLineItems,
  avenants, invoices, situations, situationLines, certificats, fees, feeEntries,
  driveUploads,
  type DriveUpload, type InsertDriveUpload,
  pennylanePushes,
  type PennylanePush, type InsertPennylanePush,
  type PennylanePushKind, type PennylanePushState,
  bankingMismatchOverrides,
  type BankingMismatchOverride, type InsertBankingMismatchOverride,
  archidocProjects, archidocContractors, archidocTrades, archidocProposalFees, archidocSyncLog, archidocSiretIssues,
  emailDocuments, projectDocuments, projectIntakeDocuments, projectCommunications, paymentReminders, clientPaymentEvidence,
  aiModelSettings, templateAssets, users, devisTranslations, wishListItems,
  benchmarkDocuments, benchmarkItems, benchmarkTags, benchmarkItemTags,
  devisChecks, devisCheckMessages, devisCheckTokens,
  clientChecks, clientCheckMessages, clientCheckTokens,
  clientProjectShareTokens, clientProjectShareDevis, clientProjectShareAudit,
  archidocLinkLookupMisses, type ArchidocLinkLookupMiss, type ArchidocLookupMissReason,
  type ClientProjectShareToken, type InsertClientProjectShareToken,
  type ClientProjectShareDevis, type InsertClientProjectShareDevis,
  type ClientProjectShareAuditEntry, type InsertClientProjectShareAuditEntry,
  type DevisCheck, type InsertDevisCheck,
  type DevisCheckMessage, type InsertDevisCheckMessage, type InboxContractorResponseRow,
  type DevisCheckToken, type InsertDevisCheckToken,
  type ClientCheck, type InsertClientCheck,
  type ClientCheckMessage, type InsertClientCheckMessage,
  type ClientCheckToken, type InsertClientCheckToken,
  insuranceOverrides,
  type InsuranceOverride, type InsertInsuranceOverride,
  webhookEventsIn, signedPdfRetentionBreaches, webhookDeliveriesOut,
  type WebhookEventIn, type InsertWebhookEventIn,
  type SignedPdfRetentionBreach, type InsertSignedPdfRetentionBreach,
  type WebhookDeliveryOut, type InsertWebhookDeliveryOut,
  WEBHOOK_DELIVERY_STATES, type WebhookDeliveryState,
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
  designContracts, designContractMilestones,
  type DesignContract, type InsertDesignContract,
  type DesignContractMilestone, type InsertDesignContractMilestone,
  type ArchidocProject, type ArchidocContractor, type ArchidocTrade, type ArchidocProposalFee, type ArchidocSyncLogEntry, type ArchidocSiretIssue,
  type EmailDocument, type InsertEmailDocument,
  type ProjectDocument, type InsertProjectDocument,
  type ProjectIntakeDocument, type InsertProjectIntakeDocument,
  intakeJobs, type IntakeJob, type InsertIntakeJob,
  documentEmbeddings, type DocumentEmbedding, type InsertDocumentEmbedding,
  overlapCases, type OverlapCase, type OverlapCaseStatus,
  reconciliationJobs, type ReconciliationJob,
  accountingStateChanges, type AccountingStateChange,
  type AccountingState, type AccountingStateChangeReason,
  DEVIS_EMBEDDING_DIMENSIONS,
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

// Task #232 — a single accounting-state move (devis state change + its
// append-only audit row). `fromState` is the expected current state; writes
// are compare-and-set against it.
export interface AccountingStateTransition {
  devisId: number;
  projectId: number;
  fromState: string;
  toState: AccountingState;
  reason: AccountingStateChangeReason;
  overlapCaseId?: number | null;
  actorUserId?: number | null;
  note?: string | null;
}

// Thrown when a compare-and-set accounting-state write finds the devis is no
// longer in its expected `fromState` (a concurrent change raced us). The whole
// batch is rolled back; callers translate this to HTTP 409.
export class AccountingStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountingStateConflictError";
  }
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
  // Batched variant for the projects-list accounting-status rollup: one query
  // for many projects instead of N per-project queries.

  getDevisByProjects(projectIds: number[]): Promise<Devis[]>;

  getDevis(id: number): Promise<Devis | undefined>;

  createDevis(data: InsertDevis): Promise<Devis>;

  updateDevis(id: number, data: Partial<InsertDevis>): Promise<Devis | undefined>;

  getDevisRefEdits(devisId: number): Promise<DevisRefEdit[]>;

  createDevisRefEdit(data: InsertDevisRefEdit): Promise<DevisRefEdit>;

  getDevisLineItems(devisId: number): Promise<DevisLineItem[]>;

  createDevisLineItem(data: InsertDevisLineItem): Promise<DevisLineItem>;

  updateDevisLineItem(id: number, data: Partial<InsertDevisLineItem>): Promise<DevisLineItem | undefined>;

  /** Deletes the line item and returns its devisId (null when not found). */
  deleteDevisLineItem(id: number): Promise<number | null>;

  getAvenantsByDevis(devisId: number): Promise<Avenant[]>;
  // Batched variant for the projects-list accounting-status rollup.

  getAvenantsByDevisIds(devisIds: number[]): Promise<Avenant[]>;

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

  getFee(id: number): Promise<Fee | undefined>;

  getFeeEntry(id: number): Promise<FeeEntry | undefined>;

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

  getArchidocProjects(options?: { includeDeleted?: boolean }): Promise<ArchidocProject[]>;

  getSoftDeletedArchidocProjects(): Promise<ArchidocProject[]>;

  getArchidocProject(archidocId: string): Promise<ArchidocProject | undefined>;

  upsertArchidocProject(data: Omit<ArchidocProject, "syncedAt">): Promise<ArchidocProject>;

  restoreArchidocProject(archidocId: string): Promise<ArchidocProject | undefined>;

  getArchidocContractors(options?: { includeDeleted?: boolean }): Promise<ArchidocContractor[]>;

  getSoftDeletedArchidocContractors(): Promise<ArchidocContractor[]>;

  getArchidocContractor(archidocId: string): Promise<ArchidocContractor | undefined>;

  upsertArchidocContractor(data: Omit<ArchidocContractor, "syncedAt">): Promise<ArchidocContractor>;

  restoreArchidocContractor(archidocId: string): Promise<ArchidocContractor | undefined>;

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

  listDueEmailDocuments(limit: number, cutoff: Date): Promise<EmailDocument[]>;

  claimEmailDocumentForProcessing(id: number, minReceivedAt: Date): Promise<EmailDocument | undefined>;

  reclaimStaleProcessingEmailDocuments(staleMs: number): Promise<number>;

  getProjectDocumentBySourceEmailDocumentId(sourceEmailDocumentId: number): Promise<ProjectDocument | undefined>;

  setEmailDocumentRetryState(id: number, data: { extractionStatus: string; processingAttempts: number; nextProcessAttemptAt: Date | null; notes?: string }): Promise<void>;

  getProjectDocuments(projectId: number): Promise<ProjectDocument[]>;

  getProjectDocument(id: number): Promise<ProjectDocument | undefined>;

  createProjectDocument(data: InsertProjectDocument): Promise<ProjectDocument>;

  getProjectIntakeDocuments(projectId: number, opts?: { includeVoid?: boolean }): Promise<(ProjectIntakeDocument & { isVoid: boolean })[]>;

  getProjectIntakeDocument(id: number): Promise<ProjectIntakeDocument | undefined>;

  createProjectIntakeDocument(data: InsertProjectIntakeDocument): Promise<ProjectIntakeDocument>;

  getProjectIntakeDocumentByEmailDocumentId(emailDocumentId: number): Promise<ProjectIntakeDocument | undefined>;

  deleteProjectIntakeDocument(id: number): Promise<void>;

  tombstoneEmailDocumentIntake(emailDocumentId: number): Promise<void>;

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
  /** Atomically bump contexts_version and clear both cached PDF keys (one UPDATE). */

  bumpContextsVersionAndClearPdfCache(devisId: number): Promise<void>;
  /** Version-guarded cache publish — returns false (no-op) when contexts_version moved. */

  updateDevisTranslationIfContextsVersion(
    devisId: number,
    data: Partial<InsertDevisTranslation>,
    expectedContextsVersion: number,

  ): Promise<boolean>;

  getDevisLineContexts(devisId: number): Promise<DevisLineContext[]>;

  getDevisLineContext(devisLineItemId: number): Promise<DevisLineContext | undefined>;
  /** Race-safe first insert — returns undefined when another writer won the unique slot. */

  createDevisLineContext(data: InsertDevisLineContext): Promise<DevisLineContext | undefined>;
  /**
   * Optimistic-concurrency update: only applies when the stored revision
   * equals `expectedRevision`; bumps revision by 1. Returns undefined on
   * a stale revision (caller maps this to HTTP 409).
   */

  updateDevisLineContextIfRevision(
    devisLineItemId: number,
    expectedRevision: number,
    document: unknown,

  ): Promise<DevisLineContext | undefined>;
  /**
   * Whole context save in ONE transaction, serialized against finalisation
   * via FOR UPDATE on the translation row: rejects when finalised, applies
   * the create-or-optimistic-update, and bumps contexts_version + clears the
   * PDF cache keys atomically with the write.
   */

  saveDevisLineContextGuarded(
    devisId: number,
    devisLineItemId: number,
    document: unknown,
    baseRevision: number,

  ): Promise<
    | { outcome: "finalised" }
    | { outcome: "stale_create" }
    | { outcome: "stale_update" }
    | { outcome: "saved"; row: DevisLineContext }

  >;
  getDevisCostAnalysis(devisId: number): Promise<DevisCostAnalysis | undefined>;
  /**
   * Optimistic-concurrency upsert of the cost analysis (Task #378), guarded
   * like context saves: refused while the translation is finalised; when the
   * analysis was or becomes 'confirmed', contexts_version is bumped and both
   * cached PDF keys cleared in the SAME transaction (a confirmed analysis
   * renders into the PDFs).
   */
  upsertDevisCostAnalysisIfRevision(args: {
    devisId: number;
    rawText: string;
    document: unknown;
    warnings: string[];
    status: "draft" | "confirmed";
    /** null = expect no existing row (create). */
    expectedRevision: number | null;
    modelId?: string | null;
    promptVersion?: number | null;
    generatedAt?: Date | null;
    updatedByEmail?: string | null;
  }): Promise<
    | { outcome: "finalised" }
    | { outcome: "stale" }
    | { outcome: "saved"; analysis: DevisCostAnalysis }
  >;

  deleteDevisCostAnalysisIfRevision(
    devisId: number,
    expectedRevision: number,
  ): Promise<{ outcome: "deleted" | "stale" | "finalised" | "not_found" }>;

  /** Returns undefined when the translation is finalised (asset insert refused). */

  createDevisLineContextAsset(data: InsertDevisLineContextAsset): Promise<DevisLineContextAsset | undefined>;

  getDevisLineContextAsset(id: number): Promise<DevisLineContextAsset | undefined>;

  getDevisLineContextAssets(devisLineItemId: number): Promise<DevisLineContextAsset[]>;

  getDevisLineContextAssetsByDevis(devisId: number): Promise<DevisLineContextAsset[]>;
  /**
   * Orphan-sweep candidates: assets uploaded before `cutoff`, paired with
   * their line's CURRENT context document (null when the line has no
   * context row at all). The caller decides referenced-ness by walking the
   * document — the raw jsonb is returned untouched.
   */

  listStaleDevisLineContextAssets(
    cutoff: Date,
    limit: number,

  ): Promise<Array<{ asset: DevisLineContextAsset; document: unknown | null }>>;
  /** Deletes one asset row; returns the deleted row, or undefined when already gone. */

  deleteDevisLineContextAsset(id: number): Promise<DevisLineContextAsset | undefined>;

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
  // Gmail polling (per-user OAuth path — see migration 0030).

  listGmailPollingUsers(): Promise<User[]>;

  updateUserGmailTokens(userId: number, tokens: {
    gmailRefreshToken?: string | null;
    gmailAccessToken?: string | null;
    gmailTokenExpiresAt?: Date | null;
    gmailScopeGranted?: string | null;
  }): Promise<void>;

  updateUserGmailPollStatus(userId: number, status: {
    gmailLastPollAt: Date;
    gmailLastPollStatus: string;
    gmailLastPollError: string | null;
  }): Promise<void>;

  setUserGmailPollingEnabled(userId: number, enabled: boolean): Promise<void>;

  unlinkUserGmail(userId: number): Promise<void>;

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

  listAwaitingArchitectInbox(limit: number): Promise<InboxContractorResponseRow[]>;

  countAwaitingArchitectInbox(): Promise<number>;

  createDevisCheckMessage(data: InsertDevisCheckMessage): Promise<DevisCheckMessage>;

  getActiveDevisCheckToken(devisId: number): Promise<DevisCheckToken | undefined>;

  getLatestDevisCheckToken(devisId: number): Promise<DevisCheckToken | undefined>;

  createDevisCheckToken(data: InsertDevisCheckToken): Promise<DevisCheckToken>;

  revokeDevisCheckTokensForDevis(devisId: number): Promise<void>;

  getDevisCheckTokenByHash(hash: string): Promise<DevisCheckToken | undefined>;

  touchDevisCheckTokenUsed(id: number, expiresAt: Date | null): Promise<void>;

  extendDevisCheckTokenExpiry(id: number, expiresAt: Date | null): Promise<DevisCheckToken | undefined>;

  revokeDevisCheckTokenById(id: number): Promise<DevisCheckToken | undefined>;

  revokeExpiredDevisCheckTokens(now?: Date): Promise<number>;
  /**
   * Lifecycle-bound auto-revoke. Revokes the active portal token for any
   * devis whose total invoiced HT has reached or exceeded its
   * avenant-adjusted contracted HT (i.e. resteARealiser <= 0). Bulk pass
   * — used by the periodic cleanup job as a safety net so the system
   * self-heals if any invoice mutation path forgets to call the
   * per-devis variant. Returns the count of tokens revoked.
   */

  revokeDevisCheckTokensForFullyInvoicedDevis(now?: Date): Promise<number>;
  /**
   * Per-devis variant of the above. Cheap to call after every invoice
   * create/update/delete and after any devis amount edit. No-op if the
   * devis has no active token, or if it isn't fully invoiced yet.
   * Returns 1 if a token was revoked, 0 otherwise.
   */

  revokeDevisCheckTokenIfFullyInvoiced(devisId: number, now?: Date): Promise<number>;

  // --- AT2 client review portal (mirror of devis-check methods, scoped to ---
  // --- the client_check_* tables). Lifecycle helpers like the           ---
  // --- "fully invoiced" auto-revoke are intentionally NOT mirrored — the ---
  // --- client portal lifecycle is governed by Archisign envelope state, ---
  // --- not invoicing progress.                                           ---

  listClientChecks(devisId: number): Promise<ClientCheck[]>;

  getClientCheck(id: number): Promise<ClientCheck | undefined>;

  createClientCheck(data: InsertClientCheck): Promise<ClientCheck>;

  updateClientCheck(id: number, data: Partial<InsertClientCheck> & { resolvedAt?: Date | null }): Promise<ClientCheck | undefined>;

  listClientCheckMessages(checkId: number): Promise<ClientCheckMessage[]>;

  createClientCheckMessage(data: InsertClientCheckMessage): Promise<ClientCheckMessage>;

  getActiveClientCheckToken(devisId: number): Promise<ClientCheckToken | undefined>;

  getLatestClientCheckToken(devisId: number): Promise<ClientCheckToken | undefined>;

  createClientCheckToken(data: InsertClientCheckToken): Promise<ClientCheckToken>;

  revokeClientCheckTokensForDevis(devisId: number): Promise<void>;

  getClientCheckTokenByHash(hash: string): Promise<ClientCheckToken | undefined>;

  touchClientCheckTokenUsed(id: number, expiresAt: Date | null): Promise<void>;

  extendClientCheckTokenExpiry(id: number, expiresAt: Date | null): Promise<ClientCheckToken | undefined>;

  revokeClientCheckTokenById(id: number): Promise<ClientCheckToken | undefined>;

  revokeExpiredClientCheckTokens(now?: Date): Promise<number>;

  revokeExpiredClientProjectShareTokens(now?: Date): Promise<number>;

  // --- Project-scoped client share link (Task #388) ---------------------

  getActiveProjectShareToken(projectId: number): Promise<ClientProjectShareToken | undefined>;

  getLatestProjectShareToken(projectId: number): Promise<ClientProjectShareToken | undefined>;

  /** Rotates: revokes any active token, inserts the new one, and COPIES the
   *  publish memberships from the previous active token so re-issuing the
   *  link doesn't silently unpublish everything. */
  createProjectShareToken(data: InsertClientProjectShareToken): Promise<ClientProjectShareToken>;

  getProjectShareTokenByHash(hash: string): Promise<ClientProjectShareToken | undefined>;

  touchProjectShareTokenUsed(id: number, expiresAt: Date | null): Promise<void>;

  extendProjectShareTokenExpiry(id: number, expiresAt: Date | null): Promise<ClientProjectShareToken | undefined>;

  revokeProjectShareTokenById(id: number): Promise<ClientProjectShareToken | undefined>;

  listProjectShareDevisIds(tokenId: number): Promise<number[]>;

  publishDevisToProjectShare(data: InsertClientProjectShareDevis): Promise<ClientProjectShareDevis>;

  unpublishDevisFromProjectShare(tokenId: number, devisId: number): Promise<boolean>;

  /** Task #394 — append-only audit trail of project share link actions. */
  createProjectShareAuditEntry(data: InsertClientProjectShareAuditEntry): Promise<ClientProjectShareAuditEntry>;
  createProjectShareAuditEntryIfAbsentSince(data: InsertClientProjectShareAuditEntry & { tokenId: number }, since: Date): Promise<boolean>;

  listProjectShareAuditEntries(projectId: number, limit?: number): Promise<ClientProjectShareAuditEntry[]>;

  /** Task #410 — record / clear / read the most recent failed ArchiDoc link lookup per project. */
  upsertArchidocLinkLookupMiss(projectId: number, reason: ArchidocLookupMissReason): Promise<void>;
  clearArchidocLinkLookupMiss(projectId: number): Promise<void>;
  getArchidocLinkLookupMiss(projectId: number): Promise<ArchidocLinkLookupMiss | undefined>;

  getProjectCommunicationByDedupeKey(key: string): Promise<ProjectCommunication | undefined>;

  getLatestSentDevisCheckBundle(devisId: number): Promise<ProjectCommunication | undefined>;

  countSentDevisCheckBundles(devisId: number): Promise<number>;

  getMaxMessageIdForChecks(checkIds: number[]): Promise<number>;

  countOpenDevisChecksForProject(projectId: number): Promise<Record<number, number>>;
  // Insurance gate (AT3, contract §1.3 / §2.1.4)

  createInsuranceOverride(data: InsertInsuranceOverride): Promise<InsuranceOverride>;

  listInsuranceOverridesForDevis(devisId: number): Promise<InsuranceOverride[]>;

  getLatestInsuranceOverrideForDevis(devisId: number): Promise<InsuranceOverride | undefined>;

  // -- Batch readiness queries (Task #374 devis readiness strip) -----------
  getDevisTranslationStatusesByProject(projectId: number): Promise<Record<number, string>>;

  countOpenClientChecksForProject(projectId: number): Promise<Record<number, number>>;

  listDevisIdsWithInsuranceOverride(devisIds: number[]): Promise<Set<number>>;

  getContractorsByIds(ids: number[]): Promise<Contractor[]>;

  // -- Archisign envelope tracking + inbound webhook (AT4) -----------------
  // claimWebhookEventIn returns true if the row was newly inserted, false
  // if a duplicate `(source, event_id)` already existed. Receivers MUST
  // check this BEFORE running any side-effecting handler, so duplicate
  // deliveries from Archisign collapse to 200 {deduplicated:true} per §1.5.

  claimWebhookEventIn(data: InsertWebhookEventIn): Promise<boolean>;
  // Lookup by Archisign envelope id — used by every webhook handler to
  // resolve the affected devis. Returns undefined if no devis owns this
  // envelope (handler responds 410 per §1.5: "non-retryable from sender").

  getDevisByArchisignEnvelopeId(envelopeId: string): Promise<Devis | undefined>;
  // Persist a `signed_pdf_retention_breach` row. Idempotent on
  // `(archisign_envelope_id, incident_ref)` per the unique index — caller
  // can replay the handler safely; downstream re-notify (AT5) is gated on
  // a fresh insert returning a row.

  recordSignedPdfRetentionBreach(
    data: InsertSignedPdfRetentionBreach,

  ): Promise<SignedPdfRetentionBreach | undefined>;

  // -- Outbound webhook deliveries (AT5, §2.1.6) ---------------------------
  // Race-safe enqueue: INSERT ... ON CONFLICT (event_id) DO NOTHING. When
  // the unique violation hits, returns the existing row so the caller can
  // distinguish "I won the claim" (act + dispatch) from "another worker /
  // a redelivery already enqueued it" (no-op).

  claimWebhookDeliveryOut(
    data: InsertWebhookDeliveryOut,

  ): Promise<{ row: WebhookDeliveryOut; created: boolean }>;

  getWebhookDeliveryOutById(id: number): Promise<WebhookDeliveryOut | undefined>;
  // Lookup by the wire-level eventId (UUIDv7). Used by the AT5 smoke
  // CLI (scripts/at5-smoke.ts) to read row state after a fire and to
  // resolve the persisted payload for the dedup re-POST scenario.
  // Backed by the unique index on event_id.

  getWebhookDeliveryOutByEventId(eventId: string): Promise<WebhookDeliveryOut | undefined>;

  listWebhookDeliveriesOut(filter?: {
    state?: WebhookDeliveryState;
    limit?: number;
    offset?: number;

  }): Promise<WebhookDeliveryOut[]>;
  // List rows whose state=pending and (next_attempt_at IS NULL OR
  // next_attempt_at <= now()). Drives the retry sweeper.

  listDueWebhookDeliveries(limit: number): Promise<WebhookDeliveryOut[]>;
  // Record one attempt outcome. Caller is responsible for computing
  // nextAttemptAt and the destination state.

  updateWebhookDeliveryAttempt(
    id: number,
    patch: {
      state: WebhookDeliveryState;
      attemptCount: number;
      lastAttemptAt: Date;
      lastErrorBody?: string | null;
      nextAttemptAt?: Date | null;
      succeededAt?: Date | null;
      deadLetteredAt?: Date | null;
    },

  ): Promise<WebhookDeliveryOut | undefined>;
  // Admin manual retry: clear terminal flags + arm for immediate attempt.
  // Preserves event_id (G6: receivers dedup on it).

  resetWebhookDeliveryForRetry(id: number): Promise<WebhookDeliveryOut | undefined>;

  // Design contracts (one per project; re-upload archives prior).

  getDesignContractByProject(projectId: number): Promise<DesignContract | undefined>;

  getDesignContract(id: number): Promise<DesignContract | undefined>;

  createDesignContract(data: InsertDesignContract): Promise<DesignContract>;

  deleteDesignContract(id: number): Promise<void>;

  getDesignContractMilestone(id: number): Promise<DesignContractMilestone | undefined>;

  getDesignContractMilestones(contractId: number): Promise<DesignContractMilestone[]>;

  createDesignContractMilestones(rows: InsertDesignContractMilestone[]): Promise<DesignContractMilestone[]>;

  updateDesignContractMilestone(id: number, data: Partial<InsertDesignContractMilestone>): Promise<DesignContractMilestone | undefined>;
  /**
   * Replace the contract+milestones for a project atomically. If a prior
   * contract exists its row (and milestones via cascade) is removed and the
   * new rows inserted; the caller is responsible for archiving the prior PDF
   * blob in object storage before invoking this.
   */

  replaceDesignContractForProject(
    projectId: number,
    contract: InsertDesignContract,
    milestones: Omit<InsertDesignContractMilestone, "contractId">[],
    sideEffects?: {
      projectFeeMirror?: { conceptionFee: string | null; planningFee: string | null };
      feeMirrors?: Array<{ feeType: "conception" | "planning"; amountHt: string }>;
    },

  ): Promise<{ contract: DesignContract; milestones: DesignContractMilestone[]; previousStorageKey: string | null }>;
  /**
   * For the daily reminder digest + dashboard strip: milestones whose status
   * is `reached` and were reached at least `staleAfterMs` ago and have not
   * been reminded since `reminderQuietMs` ago. Returned shape includes
   * project + contract context so the digest mailer can compose without
   * extra round-trips.
   */

  getReachedUninvoicedMilestones(opts: {
    staleAfterMs?: number;
    reminderQuietMs?: number;
    architectUserId?: number;

  }): Promise<Array<{
    milestone: DesignContractMilestone;
    contract: DesignContract;
    project: Project;

  }>>;

  markDesignContractMilestoneReminderSent(id: number): Promise<void>;

  // --- Task #198: Drive auto-upload ----------------------------------

  setProjectDriveFolderId(projectId: number, folderId: string): Promise<void>;

  setLotDriveFolderId(lotId: number, folderId: string): Promise<void>;

  setDevisDriveLink(devisId: number, fileId: string, webViewLink: string): Promise<void>;

  setDevisSignedPdfStorageKey(devisId: number, storageKey: string): Promise<void>;

  recordSignedPdfPersistFailure(devisId: number, errorMessage: string, nextAttemptAt: Date | null): Promise<void>;

  armSignedPdfPersistRetry(devisId: number, nextAttemptAt: Date): Promise<void>;

  clearSignedPdfRetry(devisId: number): Promise<void>;

  listDueSignedPdfRetries(limit: number): Promise<Array<{ id: number }>>;

  listSignedPdfRecoveryCandidates(): Promise<Array<{
    id: number;
    devisCode: string | null;
    projectId: number;
    lotId: number | null;
    archisignEnvelopeId: string | null;
    signedPdfRetryAttempts: number;
    signedPdfNextAttemptAt: Date | null;
    signedPdfLastError: string | null;
    dateSigned: string | null;
    retentionBreachedAt: Date | null;
    retentionIncidentRef: string | null;
  }>>;

  listArchisignRenderingDriftDevis(): Promise<Array<{
    id: number;
    devisCode: string | null;
    devisNumber: string | null;
    projectId: number;
    projectName: string | null;
    archisignEnvelopeId: string | null;
    archisignEnvelopeStatus: string | null;
    signOffStage: string | null;
    archisignSubjectDriftAt: Date | null;
    archisignBodyDriftAt: Date | null;
  }>>;

  setInvoiceDriveLink(invoiceId: number, fileId: string, webViewLink: string): Promise<void>;

  setCertificatDriveLink(certificatId: number, fileId: string, webViewLink: string): Promise<void>;

  upsertDriveUpload(data: InsertDriveUpload): Promise<DriveUpload>;

  claimDriveUploadForAttempt(uploadId: number): Promise<DriveUpload | null>;

  markDriveUploadSucceeded(args: { uploadId: number; attempts: number; driveFileId: string; driveWebViewLink: string }): Promise<void>;

  markDriveUploadDeadLettered(args: { uploadId: number; attempts: number; lastError: string }): Promise<void>;

  markDriveUploadPendingRetry(args: { uploadId: number; attempts: number; lastError: string; nextAttemptAt: Date }): Promise<void>;

  listDueDriveUploads(limit: number): Promise<DriveUpload[]>;

  reclaimStaleDriveUploads(maxAgeMs: number): Promise<number>;

  listDriveUploads(filter?: { state?: string; limit?: number; offset?: number }): Promise<DriveUpload[]>;

  getDriveUpload(uploadId: number): Promise<DriveUpload | undefined>;

  resetDriveUploadForRetry(uploadId: number): Promise<DriveUpload | undefined>;

  // --- Intake ingest queue + routing (Task #230) ------------------------

  updateProjectIntakeDocument(id: number, data: Partial<InsertProjectIntakeDocument>): Promise<ProjectIntakeDocument | undefined>;

  findProcessedIntakeDuplicateByFingerprint(projectId: number, fingerprint: string, excludeId: number): Promise<ProjectIntakeDocument | undefined>;

  findProcessedIntakeDuplicateByTextHash(projectId: number, textHash: string, excludeId: number): Promise<ProjectIntakeDocument | undefined>;

  upsertIntakeJob(intakeDocumentId: number): Promise<IntakeJob>;

  claimIntakeJobForAttempt(jobId: number): Promise<IntakeJob | null>;

  markIntakeJobSucceeded(args: { jobId: number; attempts: number }): Promise<void>;

  markIntakeJobDeadLettered(args: { jobId: number; attempts: number; lastError: string }): Promise<void>;

  markIntakeJobPendingRetry(args: { jobId: number; attempts: number; lastError: string; nextAttemptAt: Date }): Promise<void>;

  reclaimStaleIntakeJobs(maxAgeMs: number): Promise<number>;

  failOrphanedAnalyzingIntakeDocuments(): Promise<number>;

  listDueIntakeJobs(limit: number): Promise<IntakeJob[]>;

  listIntakeJobs(filter?: { state?: string; limit?: number; offset?: number }): Promise<Array<IntakeJob & { projectId: number; fileName: string; source: string; analysisState: string; routingState: string; promotedKind: string | null; promotedId: number | null }>>;

  // --- Overlap & supersession detection engine (Task #231) --------------

  getDocumentEmbedding(devisId: number): Promise<DocumentEmbedding | undefined>;

  upsertDocumentEmbedding(args: { projectId: number; devisId: number; contentHash: string; model: string; embedding: number[] }): Promise<void>;

  findSimilarProjectDevis(args: { projectId: number; devisId: number; limit: number; maxDistance: number }): Promise<Array<{ devisId: number; distance: number }>>;

  getOverlapCasesByProject(projectId: number, status?: OverlapCaseStatus): Promise<OverlapCase[]>;
  // Batched variant for the projects-list accounting-status rollup.

  getOverlapCasesByProjects(projectIds: number[], status?: OverlapCaseStatus): Promise<OverlapCase[]>;

  getOverlapCase(id: number): Promise<OverlapCase | undefined>;
  // Task #232 — accounting state machine. transitionDevisAccountingState
  // writes the new devis state AND its append-only audit row in one tx.

  transitionDevisAccountingState(args: AccountingStateTransition): Promise<void>;
  // Apply several accounting-state transitions atomically. Used when ONE
  // human decision must move several devis together (all-or-nothing): every
  // update is compare-and-set on `fromState`, so a stale read aborts the
  // whole batch with AccountingStateConflictError rather than partially
  // moving money.

  applyAccountingStateTransitions(transitions: AccountingStateTransition[]): Promise<void>;
  // Overlap case ids the architect has explicitly dismissed (so the
  // reconciliation pass never auto-supersedes their members).

  getDismissedOverlapCaseIds(projectId: number): Promise<number[]>;

  getResolvedOverlapCaseIds(projectId: number): Promise<number[]>;
  // Batched variant for the projects-list accounting-status rollup: returns the
  // (projectId, overlapCaseId) pairs the architect has humanly resolved.

  getResolvedOverlapCaseRowsByProjects(projectIds: number[]): Promise<Array<{ projectId: number; overlapCaseId: number }>>;

  getAccountingStateChangesByDevis(devisId: number): Promise<AccountingStateChange[]>;

  getHumanResolvedOverlapDecisions(projectId: number): Promise<AccountingStateChange[]>;

  upsertReconciliationJob(projectId: number): Promise<ReconciliationJob>;

  claimReconciliationJobForAttempt(jobId: number): Promise<ReconciliationJob | null>;

  markReconciliationJobSucceeded(args: { jobId: number; attempts: number }): Promise<void>;

  markReconciliationJobDeadLettered(args: { jobId: number; attempts: number; lastError: string }): Promise<void>;

  markReconciliationJobPendingRetry(args: { jobId: number; attempts: number; lastError: string; nextAttemptAt: Date }): Promise<void>;

  reclaimStaleReconciliationJobs(maxAgeMs: number): Promise<number>;

  listDueReconciliationJobs(limit: number): Promise<ReconciliationJob[]>;

  getIntakeJob(jobId: number): Promise<IntakeJob | undefined>;

  getIntakeJobByDocumentId(intakeDocumentId: number): Promise<IntakeJob | undefined>;

  resetIntakeJobForRetry(jobId: number): Promise<IntakeJob | undefined>;

  // --- Pennylane push queue (Task #214) ---------------------------------

  upsertPennylanePush(data: InsertPennylanePush): Promise<PennylanePush>;

  claimPennylanePushForAttempt(pushId: number): Promise<PennylanePush | null>;

  markPennylanePushSucceeded(args: { pushId: number; attempts: number; pennylaneId: string | null; dryRun?: boolean }): Promise<void>;

  markPennylanePushDeadLettered(args: { pushId: number; attempts: number; lastError: string }): Promise<void>;

  markPennylanePushPendingRetry(args: { pushId: number; attempts: number; lastError: string; nextAttemptAt: Date }): Promise<void>;

  listDuePennylanePushes(limit: number): Promise<PennylanePush[]>;

  reclaimStalePennylanePushes(maxAgeMs: number): Promise<number>;

  listPennylanePushes(filter?: { state?: PennylanePushState; kind?: PennylanePushKind; limit?: number; offset?: number }): Promise<PennylanePush[]>;

  getPennylanePush(pushId: number): Promise<PennylanePush | undefined>;

  resetPennylanePushForRetry(pushId: number): Promise<PennylanePush | undefined>;

  // --- Banking mismatch overrides (Task #225) ----------------------------
  // Architect-recorded acceptances of an extracted_iban ≠ contractor.iban
  // discrepancy. Keyed by the polymorphic tuple (doc_kind, doc_id,
  // doc_iban, archidoc_iban) so re-uploading the same doc with the same
  // IBAN does NOT need a fresh override, but switching to a different
  // suspicious IBAN does.

  createBankingMismatchOverride(data: InsertBankingMismatchOverride): Promise<BankingMismatchOverride>;

  findBankingMismatchOverride(args: {
    docKind: "devis" | "invoice";
    docId: number;
    docIban: string;
    archidocIban: string;

  }): Promise<BankingMismatchOverride | undefined>;

  listBankingMismatchOverridesByContractor(contractorId: number): Promise<BankingMismatchOverride[]>;

  // --- Pennylane mirror columns (Task #214) -----------------------------

  setProjectPennylaneCustomerId(projectId: number, customerId: string): Promise<void>;

  setFeeEntryPennylaneInvoice(args: {
    feeEntryId: number;
    pennylaneInvoiceId: string;
    pennylanePdfStorageKey: string | null;
    pennylaneStatus: string | null;
  }): Promise<void>;

  setFeeEntryPennylanePaid(args: {
    feeEntryId: number;
    paidAt: Date | null;
    paidAmount: number | null;
    pennylaneStatus: string;
  }): Promise<void>;

  getFeeEntryByPennylaneInvoiceId(invoiceId: string): Promise<FeeEntry | undefined>;

  listFeeEntriesWithPennylaneInvoice(args?: { onlyUnpaid?: boolean; limit?: number }): Promise<FeeEntry[]>;

  getEmailQueueStats(): Promise<{ pending: number; processing: number; needsReview: number; oldestPendingAt: Date | null; processedLast5Min: number }>;
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

  async getDevisByProjects(projectIds: number[]): Promise<Devis[]> {
    if (projectIds.length === 0) return [];
    return db.select().from(devis).where(inArray(devis.projectId, projectIds)).orderBy(devis.devisCode);
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

  async deleteDevisLineItem(id: number): Promise<number | null> {
    const rows = await db
      .delete(devisLineItems)
      .where(eq(devisLineItems.id, id))
      .returning({ devisId: devisLineItems.devisId });
    return rows[0]?.devisId ?? null;
  }

  async getAvenantsByDevis(devisId: number): Promise<Avenant[]> {
    return db.select().from(avenants).where(eq(avenants.devisId, devisId)).orderBy(avenants.createdAt);
  }

  async getAvenantsByDevisIds(devisIds: number[]): Promise<Avenant[]> {
    if (devisIds.length === 0) return [];
    return db.select().from(avenants).where(inArray(avenants.devisId, devisIds)).orderBy(avenants.createdAt);
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

  async getFeeEntry(id: number): Promise<FeeEntry | undefined> {
    const [row] = await db.select().from(feeEntries).where(eq(feeEntries.id, id));
    return row;
  }

  async getFee(id: number): Promise<Fee | undefined> {
    const [row] = await db.select().from(fees).where(eq(fees.id, id));
    return row;
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

  // -------------------------------------------------------------------------
  // Design contracts
  // -------------------------------------------------------------------------
  async getDesignContractByProject(projectId: number): Promise<DesignContract | undefined> {
    const [row] = await db.select().from(designContracts).where(eq(designContracts.projectId, projectId));
    return row;
  }

  async getDesignContract(id: number): Promise<DesignContract | undefined> {
    const [row] = await db.select().from(designContracts).where(eq(designContracts.id, id));
    return row;
  }

  async createDesignContract(data: InsertDesignContract): Promise<DesignContract> {
    const [row] = await db.insert(designContracts).values(data).returning();
    return row;
  }

  async deleteDesignContract(id: number): Promise<void> {
    await db.delete(designContracts).where(eq(designContracts.id, id));
  }

  async getDesignContractMilestone(id: number): Promise<DesignContractMilestone | undefined> {
    const [row] = await db.select().from(designContractMilestones).where(eq(designContractMilestones.id, id)).limit(1);
    return row;
  }

  async getDesignContractMilestones(contractId: number): Promise<DesignContractMilestone[]> {
    return db
      .select()
      .from(designContractMilestones)
      .where(eq(designContractMilestones.contractId, contractId))
      .orderBy(asc(designContractMilestones.sequence));
  }

  async createDesignContractMilestones(rows: InsertDesignContractMilestone[]): Promise<DesignContractMilestone[]> {
    if (rows.length === 0) return [];
    return db.insert(designContractMilestones).values(rows).returning();
  }

  async updateDesignContractMilestone(
    id: number,
    data: Partial<InsertDesignContractMilestone>,
  ): Promise<DesignContractMilestone | undefined> {
    const [row] = await db.update(designContractMilestones).set(data).where(eq(designContractMilestones.id, id)).returning();
    return row;
  }

  async replaceDesignContractForProject(
    projectId: number,
    contract: InsertDesignContract,
    milestones: Omit<InsertDesignContractMilestone, "contractId">[],
    sideEffects?: {
      projectFeeMirror?: { conceptionFee: string | null; planningFee: string | null };
      feeMirrors?: Array<{ feeType: "conception" | "planning"; amountHt: string }>;
    },
  ): Promise<{ contract: DesignContract; milestones: DesignContractMilestone[]; previousStorageKey: string | null }> {
    return db.transaction(async (tx) => {
      const [prior] = await tx.select().from(designContracts).where(eq(designContracts.projectId, projectId));
      const previousStorageKey = prior?.storageKey ?? null;
      if (prior) {
        await tx.delete(designContracts).where(eq(designContracts.id, prior.id));
      }
      const [created] = await tx
        .insert(designContracts)
        .values({ ...contract, projectId })
        .returning();
      const milestoneRows = milestones.length === 0
        ? []
        : await tx
            .insert(designContractMilestones)
            .values(milestones.map((m) => ({ ...m, contractId: created.id })))
            .returning();

      // Project fee-field mirror + design-fee row reconciliation
      // run inside the SAME transaction as the contract row replacement so
      // partial persistence is impossible. Re-upload preserves prior
      // invoicedAmount on the matching fee row.
      if (sideEffects?.projectFeeMirror) {
        await tx
          .update(projects)
          .set({
            conceptionFee: sideEffects.projectFeeMirror.conceptionFee,
            planningFee: sideEffects.projectFeeMirror.planningFee,
          })
          .where(eq(projects.id, projectId));
      }
      if (sideEffects?.feeMirrors && sideEffects.feeMirrors.length > 0) {
        const existingFees = await tx.select().from(fees).where(eq(fees.projectId, projectId));
        for (const m of sideEffects.feeMirrors) {
          const prior = existingFees.find((f) => f.feeType === m.feeType);
          const invoiced = prior ? Number(prior.invoicedAmount ?? "0") : 0;
          const remaining = Math.max(0, Math.round((Number(m.amountHt) - invoiced) * 100) / 100);
          if (prior) {
            await tx.update(fees).set({
              baseAmountHt: m.amountHt,
              feeAmountHt: m.amountHt,
              remainingAmount: remaining.toFixed(2),
            }).where(eq(fees.id, prior.id));
          } else {
            await tx.insert(fees).values({
              projectId,
              feeType: m.feeType,
              baseAmountHt: m.amountHt,
              feeRate: null,
              feeAmountHt: m.amountHt,
              invoicedAmount: "0.00",
              remainingAmount: m.amountHt,
              status: "pending",
            });
          }
        }
      }

      return { contract: created, milestones: milestoneRows, previousStorageKey };
    });
  }

  async getReachedUninvoicedMilestones(opts: {
    staleAfterMs?: number;
    reminderQuietMs?: number;
    /**
     * When set, restrict results to contracts uploaded by this user. The
     * dashboard strip + daily digest scope by uploader so each architect
     * only sees their own projects' actionable milestones (the project
     * model has no first-class "owner" field — uploadedByUserId on the
     * contract is the de-facto ownership signal for the design-fee
     * lifecycle).
     */
    architectUserId?: number;
  }): Promise<Array<{
    milestone: DesignContractMilestone;
    contract: DesignContract;
    project: Project;
  }>> {
    const staleAfterMs = opts.staleAfterMs ?? 7 * 24 * 60 * 60 * 1000;
    const reminderQuietMs = opts.reminderQuietMs ?? 24 * 60 * 60 * 1000;
    const reachedCutoff = new Date(Date.now() - staleAfterMs);
    const reminderCutoff = new Date(Date.now() - reminderQuietMs);
    const conditions = [
      eq(designContractMilestones.status, "reached"),
      isNull(projects.archivedAt),
      lte(designContractMilestones.reachedAt, reachedCutoff),
      or(
        isNull(designContractMilestones.reminderLastSentAt),
        lte(designContractMilestones.reminderLastSentAt, reminderCutoff),
      ),
    ];
    if (opts.architectUserId !== undefined) {
      conditions.push(eq(designContracts.uploadedByUserId, opts.architectUserId));
    }
    const rows = await db
      .select({
        milestone: designContractMilestones,
        contract: designContracts,
        project: projects,
      })
      .from(designContractMilestones)
      .innerJoin(designContracts, eq(designContractMilestones.contractId, designContracts.id))
      .innerJoin(projects, eq(designContracts.projectId, projects.id))
      .where(and(...conditions))
      .orderBy(asc(designContractMilestones.reachedAt));
    return rows;
  }

  async markDesignContractMilestoneReminderSent(id: number): Promise<void> {
    await db
      .update(designContractMilestones)
      .set({ reminderLastSentAt: new Date() })
      .where(eq(designContractMilestones.id, id));
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

  async getArchidocProjects(options?: { includeDeleted?: boolean }): Promise<ArchidocProject[]> {
    if (options?.includeDeleted) {
      return db.select().from(archidocProjects).orderBy(archidocProjects.projectName);
    }
    return db
      .select()
      .from(archidocProjects)
      .where(eq(archidocProjects.isDeleted, false))
      .orderBy(archidocProjects.projectName);
  }

  async getSoftDeletedArchidocProjects(): Promise<ArchidocProject[]> {
    return db
      .select()
      .from(archidocProjects)
      .where(eq(archidocProjects.isDeleted, true))
      .orderBy(desc(archidocProjects.deletedAt));
  }

  async getArchidocProject(archidocId: string): Promise<ArchidocProject | undefined> {
    const [project] = await db.select().from(archidocProjects).where(eq(archidocProjects.archidocId, archidocId));
    return project;
  }

  async restoreArchidocProject(archidocId: string): Promise<ArchidocProject | undefined> {
    const [restored] = await db
      .update(archidocProjects)
      .set({ isDeleted: false, deletedAt: null })
      .where(eq(archidocProjects.archidocId, archidocId))
      .returning();
    return restored;
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

  async getArchidocContractors(options?: { includeDeleted?: boolean }): Promise<ArchidocContractor[]> {
    if (options?.includeDeleted) {
      return db.select().from(archidocContractors).orderBy(archidocContractors.name);
    }
    return db
      .select()
      .from(archidocContractors)
      .where(eq(archidocContractors.isDeleted, false))
      .orderBy(archidocContractors.name);
  }

  async getSoftDeletedArchidocContractors(): Promise<ArchidocContractor[]> {
    return db
      .select()
      .from(archidocContractors)
      .where(eq(archidocContractors.isDeleted, true))
      .orderBy(desc(archidocContractors.deletedAt));
  }

  async getArchidocContractor(archidocId: string): Promise<ArchidocContractor | undefined> {
    const [contractor] = await db.select().from(archidocContractors).where(eq(archidocContractors.archidocId, archidocId));
    return contractor;
  }

  async restoreArchidocContractor(archidocId: string): Promise<ArchidocContractor | undefined> {
    const [restored] = await db
      .update(archidocContractors)
      .set({ isDeleted: false, deletedAt: null })
      .where(eq(archidocContractors.archidocId, archidocId))
      .returning();
    return restored;
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

  async updateEmailDocument(id: number, data: Partial<InsertEmailDocument> & { extractionStatus?: string }): Promise<EmailDocument | undefined> {
    // Task #322 — 'skipped' is terminal: the dumped beta backlog must never
    // be revived through a generic update. Status changes for skipped docs
    // are refused at the storage layer regardless of caller.
    if (data.extractionStatus !== undefined) {
      const existing = await this.getEmailDocument(id);
      if (existing?.extractionStatus === "skipped") {
        delete data.extractionStatus;
      }
    }
    const [doc] = await db.update(emailDocuments).set({ ...data, updatedAt: new Date() }).where(eq(emailDocuments.id, id)).returning();
    // Unified intake (Task #229): the moment an email attachment is matched to
    // a project (and has a stored file), mirror it into the project-scoped
    // intake list so the two doors — manual upload and email — feed one list.
    // Idempotent via the partial unique index on source_email_document_id.
    if (doc) await this.mirrorEmailDocumentToIntake(doc);
    return doc;
  }

  /**
   * Ensure a project-scoped intake row exists for an email document.
   * No-op until the email doc has both a projectId and a stored file. The
   * insert relies on the partial unique index `(source_email_document_id)`
   * (ON CONFLICT DO NOTHING) so concurrent matches never create duplicates.
   */
  private async mirrorEmailDocumentToIntake(doc: EmailDocument): Promise<void> {
    if (doc.projectId == null || !doc.storageKey) return;
    // Task #322 — dumped backlog documents ('skipped') were written off in
    // the beta reset; assigning them a project must not resurrect them into
    // the intake pipeline.
    if (doc.extractionStatus === "skipped") return;
    // Tombstoned: an operator deliberately deleted the mirrored intake row —
    // do not resurrect it on subsequent email-document updates.
    if (doc.intakeDeletedAt) return;
    // Task #310 — hand the email-side extraction down to the intake
    // pipeline so Gemini is not called a second time for the same bytes.
    // Marked explicitly so the pipeline only trusts payloads that came
    // through this door.
    const emailParsed = doc.extractedData as Record<string, unknown> | null;
    const preParsed =
      emailParsed && typeof emailParsed === "object" && typeof emailParsed.documentType === "string"
        ? { ...emailParsed, preParsedFromEmail: true }
        : undefined;
    const [inserted] = await db.insert(projectIntakeDocuments).values({
      projectId: doc.projectId,
      fileName: doc.attachmentFileName ?? "document.pdf",
      storageKey: doc.storageKey,
      mimeType: "application/pdf",
      source: "gmail",
      analysisState: "pending",
      routingState: "unrouted",
      sourceEmailDocumentId: doc.id,
      ...(preParsed ? { extractedData: preParsed } : {}),
    }).onConflictDoNothing().returning();
    // Task #230 — enqueue background dedup → classify → route for the
    // newly-mirrored doc. Skip when ON CONFLICT swallowed the insert (the
    // doc — and its queue row — already exist). Dynamic import breaks the
    // storage ↔ ingest-queue module cycle.
    if (inserted) {
      const { enqueueIntakeJob } = await import("./services/intake/ingest-queue.service");
      void enqueueIntakeJob(inserted.id);
    }
  }

  async updateEmailDocumentLabelStatus(messageId: string): Promise<void> {
    await db.update(emailDocuments)
      .set({ gmailLabelApplied: true })
      .where(like(emailDocuments.emailMessageId, `${messageId}%`));
  }

  async getPendingEmailDocuments(): Promise<EmailDocument[]> {
    return db.select().from(emailDocuments).where(eq(emailDocuments.extractionStatus, "pending")).orderBy(emailDocuments.createdAt);
  }

  /**
   * Task #310 — pending email documents due for automatic processing:
   * captured on/after the backlog cutoff, retry backoff elapsed (or never
   * attempted), and with a stored file. Oldest received first so the
   * backlog drains chronologically.
   */
  async listDueEmailDocuments(limit: number, cutoff: Date): Promise<EmailDocument[]> {
    return db
      .select()
      .from(emailDocuments)
      .where(
        and(
          eq(emailDocuments.extractionStatus, "pending"),
          isNotNull(emailDocuments.storageKey),
          gte(emailDocuments.emailReceivedAt, cutoff),
          or(isNull(emailDocuments.nextProcessAttemptAt), lte(emailDocuments.nextProcessAttemptAt, new Date())),
        ),
      )
      .orderBy(asc(emailDocuments.emailReceivedAt))
      .limit(limit);
  }

  /**
   * Task #318 — queue drain stats for the email queue page banner.
   * `processedLast5Min` counts docs that reached a terminal extraction state
   * (completed / needs_review / failed) in the last 5 minutes, judged by
   * updatedAt — the sweeper writes updatedAt on every state change, so it is
   * a usable throughput proxy without a dedicated history table.
   */
  async getEmailQueueStats(): Promise<{ pending: number; processing: number; needsReview: number; oldestPendingAt: Date | null; processedLast5Min: number }> {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const [row] = await db
      .select({
        pending: sql<number>`COUNT(*) FILTER (WHERE ${emailDocuments.extractionStatus} = 'pending')`,
        processing: sql<number>`COUNT(*) FILTER (WHERE ${emailDocuments.extractionStatus} = 'processing')`,
        needsReview: sql<number>`COUNT(*) FILTER (WHERE ${emailDocuments.extractionStatus} = 'needs_review')`,
        oldestPendingAt: sql<Date | null>`MIN(${emailDocuments.createdAt}) FILTER (WHERE ${emailDocuments.extractionStatus} = 'pending')`,
        processedLast5Min: sql<number>`COUNT(*) FILTER (WHERE ${emailDocuments.extractionStatus} IN ('completed', 'needs_review', 'failed') AND ${emailDocuments.updatedAt} >= ${fiveMinAgo})`,
      })
      .from(emailDocuments);
    return {
      pending: Number(row?.pending ?? 0),
      processing: Number(row?.processing ?? 0),
      needsReview: Number(row?.needsReview ?? 0),
      oldestPendingAt: row?.oldestPendingAt ? new Date(row.oldestPendingAt) : null,
      processedLast5Min: Number(row?.processedLast5Min ?? 0),
    };
  }

  /**
   * Task #310 — atomic claim: flips a document to 'processing' only if it is
   * not already being processed. Both the background sweeper and the manual
   * admin route must go through this, so a manual click racing a sweep (or
   * two app instances sharing the DB) can never double-process the same doc
   * and duplicate its side effects (project document, Drive upload).
   * Returns the claimed row, or undefined when another worker holds it.
   */
  async claimEmailDocumentForProcessing(id: number, minReceivedAt: Date): Promise<EmailDocument | undefined> {
    // Task #322 — the claim predicate itself enforces the terminal 'skipped'
    // state and the intake watermark, so no caller (present or future) can
    // revive a dumped or pre-reset document, even racing the boundary checks.
    const [doc] = await db
      .update(emailDocuments)
      .set({ extractionStatus: "processing", updatedAt: new Date() })
      .where(and(
        eq(emailDocuments.id, id),
        ne(emailDocuments.extractionStatus, "processing"),
        ne(emailDocuments.extractionStatus, "skipped"),
        isNotNull(emailDocuments.emailReceivedAt),
        gte(emailDocuments.emailReceivedAt, minReceivedAt),
      ))
      .returning();
    return doc;
  }

  /**
   * Task #310 — a crash/restart mid-extraction leaves a document wedged on
   * "processing" forever (nothing else touches that status). Reclaim rows
   * whose last update is older than the stale window back to "pending".
   * A reclaim consumes an attempt so a doc that wedges every time still
   * terminates at the 5-attempt bound instead of looping forever.
   */
  async reclaimStaleProcessingEmailDocuments(staleMs: number): Promise<number> {
    const threshold = new Date(Date.now() - staleMs);
    const rows = await db
      .update(emailDocuments)
      .set({
        processingAttempts: sql`${emailDocuments.processingAttempts} + 1`,
        extractionStatus: sql`CASE WHEN ${emailDocuments.processingAttempts} + 1 >= 5 THEN 'failed' ELSE 'pending' END`,
        notes: sql`CASE WHEN ${emailDocuments.processingAttempts} + 1 >= 5 THEN 'Traitement interrompu à répétition (5 tentatives) — abandon.' ELSE ${emailDocuments.notes} END`,
        updatedAt: new Date(),
      })
      .where(and(eq(emailDocuments.extractionStatus, "processing"), lt(emailDocuments.updatedAt, threshold)))
      .returning({ id: emailDocuments.id });
    return rows.length;
  }

  /**
   * Task #310 — direct retry-state write. Bypasses updateEmailDocument on
   * purpose: retry columns are excluded from InsertEmailDocument (server-
   * authoritative) and a pure bookkeeping write must not re-trigger the
   * intake mirror.
   */
  async setEmailDocumentRetryState(
    id: number,
    data: { extractionStatus: string; processingAttempts: number; nextProcessAttemptAt: Date | null; notes?: string },
  ): Promise<void> {
    await db
      .update(emailDocuments)
      .set({
        extractionStatus: data.extractionStatus,
        processingAttempts: data.processingAttempts,
        nextProcessAttemptAt: data.nextProcessAttemptAt,
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        updatedAt: new Date(),
      })
      // Task #322 — retry bookkeeping only applies to a row currently held
      // by a claim; it must never move a terminal 'skipped' doc anywhere.
      .where(and(eq(emailDocuments.id, id), eq(emailDocuments.extractionStatus, "processing")));
  }

  async getProjectDocuments(projectId: number): Promise<ProjectDocument[]> {
    return db.select().from(projectDocuments).where(eq(projectDocuments.projectId, projectId)).orderBy(desc(projectDocuments.createdAt));
  }

  async getProjectDocument(id: number): Promise<ProjectDocument | undefined> {
    const [doc] = await db.select().from(projectDocuments).where(eq(projectDocuments.id, id));
    return doc;
  }

  /** Task #310 — idempotency probe: has this email doc already been filed? */
  async getProjectDocumentBySourceEmailDocumentId(sourceEmailDocumentId: number): Promise<ProjectDocument | undefined> {
    const [doc] = await db
      .select()
      .from(projectDocuments)
      .where(eq(projectDocuments.sourceEmailDocumentId, sourceEmailDocumentId));
    return doc;
  }

  async createProjectDocument(data: InsertProjectDocument): Promise<ProjectDocument> {
    const [doc] = await db.insert(projectDocuments).values(data).returning();
    return doc;
  }

  async getProjectIntakeDocuments(projectId: number, opts?: { includeVoid?: boolean }): Promise<(ProjectIntakeDocument & { isVoid: boolean })[]> {
    // Left-join the promoted devis (when promotedKind = "devis") so voided
    // quotations can be hidden from the intake list by default (Task #326).
    const rows = await db
      .select({ doc: projectIntakeDocuments, promotedDevisStatus: devis.status })
      .from(projectIntakeDocuments)
      .leftJoin(
        devis,
        and(eq(projectIntakeDocuments.promotedKind, "devis"), eq(projectIntakeDocuments.promotedId, devis.id)),
      )
      .where(eq(projectIntakeDocuments.projectId, projectId))
      .orderBy(desc(projectIntakeDocuments.createdAt));
    const docs = rows.map((r) => ({ ...r.doc, isVoid: r.promotedDevisStatus === "void" }));
    return opts?.includeVoid ? docs : docs.filter((d) => !d.isVoid);
  }

  async getProjectIntakeDocument(id: number): Promise<ProjectIntakeDocument | undefined> {
    const [doc] = await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, id));
    return doc;
  }

  async createProjectIntakeDocument(data: InsertProjectIntakeDocument): Promise<ProjectIntakeDocument> {
    const [doc] = await db.insert(projectIntakeDocuments).values(data).returning();
    return doc;
  }

  async getProjectIntakeDocumentByEmailDocumentId(emailDocumentId: number): Promise<ProjectIntakeDocument | undefined> {
    const [doc] = await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.sourceEmailDocumentId, emailDocumentId));
    return doc;
  }

  async deleteProjectIntakeDocument(id: number): Promise<void> {
    // intake_jobs rows cascade via their FK; promoted records are guarded at
    // the route level (a routed doc cannot be deleted from intake).
    await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, id));
  }

  async tombstoneEmailDocumentIntake(emailDocumentId: number): Promise<void> {
    await db.update(emailDocuments)
      .set({ intakeDeletedAt: new Date() })
      .where(eq(emailDocuments.id, emailDocumentId));
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
    // Defense in depth against double-sends: if a row with this dedupeKey
    // already exists (e.g. two parallel "Send" clicks both passed the
    // pre-insert dedupe probe), the unique index on dedupe_key would raise
    // a 23505. Use ON CONFLICT DO NOTHING and re-read the surviving row so
    // both callers observe the same comm id and only one email is queued.
    if (data.dedupeKey) {
      const inserted = await db
        .insert(projectCommunications)
        .values(data)
        .onConflictDoNothing({ target: projectCommunications.dedupeKey })
        .returning();
      if (inserted[0]) return inserted[0];
      const existing = await this.getProjectCommunicationByDedupeKey(data.dedupeKey);
      if (existing) return existing;
      // Extremely unlikely (row deleted between conflict and re-read) — fall
      // through to a plain insert which will surface the underlying issue.
    }
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

  async bumpContextsVersionAndClearPdfCache(devisId: number): Promise<void> {
    // Single atomic statement: nobody can observe the new version with the
    // old cache keys still set (or vice versa).
    await db
      .update(devisTranslations)
      .set({
        contextsVersion: sql`${devisTranslations.contextsVersion} + 1`,
        translatedPdfStorageKey: null,
        combinedPdfStorageKey: null,
        updatedAt: new Date(),
      })
      .where(eq(devisTranslations.devisId, devisId));
  }

  async updateDevisTranslationIfContextsVersion(
    devisId: number,
    data: Partial<InsertDevisTranslation>,
    expectedContextsVersion: number,
  ): Promise<boolean> {
    // Conditional publish: the WHERE guard is on the same row being updated,
    // so under READ COMMITTED a concurrent version bump makes this a no-op
    // (Postgres re-evaluates the qual against the updated row version).
    const rows = await db
      .update(devisTranslations)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(devisTranslations.devisId, devisId),
          eq(devisTranslations.contextsVersion, expectedContextsVersion),
        ),
      )
      .returning({ devisId: devisTranslations.devisId });
    return rows.length > 0;
  }

  async getDevisLineContexts(devisId: number): Promise<DevisLineContext[]> {
    return db.select().from(devisLineContexts).where(eq(devisLineContexts.devisId, devisId));
  }

  async getDevisLineContext(devisLineItemId: number): Promise<DevisLineContext | undefined> {
    const [row] = await db
      .select()
      .from(devisLineContexts)
      .where(eq(devisLineContexts.devisLineItemId, devisLineItemId));
    return row;
  }

  async createDevisLineContext(data: InsertDevisLineContext): Promise<DevisLineContext | undefined> {
    // ON CONFLICT DO NOTHING makes concurrent first-saves race-safe: exactly
    // one insert wins; the loser gets `undefined` (mapped to 409 upstream)
    // instead of a unique-violation 500.
    const [row] = await db
      .insert(devisLineContexts)
      .values(data)
      .onConflictDoNothing({ target: devisLineContexts.devisLineItemId })
      .returning();
    return row;
  }

  async updateDevisLineContextIfRevision(
    devisLineItemId: number,
    expectedRevision: number,
    document: unknown,
  ): Promise<DevisLineContext | undefined> {
    const [row] = await db
      .update(devisLineContexts)
      .set({
        document,
        revision: sql`${devisLineContexts.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(devisLineContexts.devisLineItemId, devisLineItemId),
          eq(devisLineContexts.revision, expectedRevision),
        ),
      )
      .returning();
    return row;
  }

  async saveDevisLineContextGuarded(
    devisId: number,
    devisLineItemId: number,
    document: unknown,
    baseRevision: number,
  ): Promise<
    | { outcome: "finalised" }
    | { outcome: "stale_create" }
    | { outcome: "stale_update" }
    | { outcome: "saved"; row: DevisLineContext }
  > {
    // Whole save in ONE transaction, serialized against finalisation via a
    // FOR UPDATE row lock on the translation row: the finalise path updates
    // that same row (status = 'finalised'), so either it commits first and
    // we see it here (reject), or we hold the lock and it waits until our
    // context write + version bump are committed. No check-then-write window.
    return db.transaction(async (tx) => {
      const [translation] = await tx
        .select({ status: devisTranslations.status })
        .from(devisTranslations)
        .where(eq(devisTranslations.devisId, devisId))
        .for("update");
      if (translation?.status === "finalised") {
        return { outcome: "finalised" as const };
      }

      let row: DevisLineContext | undefined;
      if (baseRevision === 0) {
        const [created] = await tx
          .insert(devisLineContexts)
          .values({ devisLineItemId, devisId, document, revision: 1 })
          .onConflictDoNothing({ target: devisLineContexts.devisLineItemId })
          .returning();
        if (!created) return { outcome: "stale_create" as const };
        row = created;
      } else {
        const [updated] = await tx
          .update(devisLineContexts)
          .set({ document, revision: sql`${devisLineContexts.revision} + 1`, updatedAt: new Date() })
          .where(
            and(
              eq(devisLineContexts.devisLineItemId, devisLineItemId),
              eq(devisLineContexts.revision, baseRevision),
            ),
          )
          .returning();
        if (!updated) return { outcome: "stale_update" as const };
        row = updated;
      }

      // Same transaction: version bump + cache-key clear commit atomically
      // with the context write (no-op when there is no translation row yet).
      if (translation) {
        await tx
          .update(devisTranslations)
          .set({
            contextsVersion: sql`${devisTranslations.contextsVersion} + 1`,
            translatedPdfStorageKey: null,
            combinedPdfStorageKey: null,
            updatedAt: new Date(),
          })
          .where(eq(devisTranslations.devisId, devisId));
      }
      return { outcome: "saved" as const, row };
    });
  }

  async getDevisCostAnalysis(devisId: number): Promise<DevisCostAnalysis | undefined> {
    const [row] = await db.select().from(devisCostAnalyses).where(eq(devisCostAnalyses.devisId, devisId));
    return row;
  }

  async upsertDevisCostAnalysisIfRevision(args: {
    devisId: number;
    rawText: string;
    document: unknown;
    warnings: string[];
    status: "draft" | "confirmed";
    expectedRevision: number | null;
    quotationFingerprint?: string | null;
    modelId?: string | null;
    promptVersion?: number | null;
    generatedAt?: Date | null;
    updatedByEmail?: string | null;
  }): Promise<
    | { outcome: "finalised" }
    | { outcome: "stale" }
    | { outcome: "saved"; analysis: DevisCostAnalysis }
  > {
    const { devisId } = args;
    // Same serialization strategy as saveDevisLineContextGuarded: FOR UPDATE
    // row lock on the translation row means either finalisation committed
    // first (reject) or it waits for our write + version bump to commit.
    return db.transaction(async (tx) => {
      const [translation] = await tx
        .select({ status: devisTranslations.status })
        .from(devisTranslations)
        .where(eq(devisTranslations.devisId, devisId))
        .for("update");
      if (translation?.status === "finalised") {
        return { outcome: "finalised" as const };
      }

      const [existing] = await tx
        .select({ revision: devisCostAnalyses.revision, status: devisCostAnalyses.status })
        .from(devisCostAnalyses)
        .where(eq(devisCostAnalyses.devisId, devisId));

      let row: DevisCostAnalysis | undefined;
      if (args.expectedRevision === null) {
        if (existing) return { outcome: "stale" as const };
        const [created] = await tx
          .insert(devisCostAnalyses)
          .values({
            devisId,
            rawText: args.rawText,
            document: args.document,
            warnings: args.warnings,
            status: args.status,
            revision: 1,
            quotationFingerprint: args.quotationFingerprint ?? null,
            modelId: args.modelId ?? null,
            promptVersion: args.promptVersion ?? null,
            generatedAt: args.generatedAt ?? null,
            updatedByEmail: args.updatedByEmail ?? null,
          })
          .onConflictDoNothing({ target: devisCostAnalyses.devisId })
          .returning();
        if (!created) return { outcome: "stale" as const };
        row = created;
      } else {
        const [updated] = await tx
          .update(devisCostAnalyses)
          .set({
            rawText: args.rawText,
            document: args.document,
            warnings: args.warnings,
            status: args.status,
            revision: sql`${devisCostAnalyses.revision} + 1`,
            ...(args.quotationFingerprint !== undefined
              ? { quotationFingerprint: args.quotationFingerprint }
              : {}),
            ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
            ...(args.promptVersion !== undefined ? { promptVersion: args.promptVersion } : {}),
            ...(args.generatedAt !== undefined ? { generatedAt: args.generatedAt } : {}),
            updatedByEmail: args.updatedByEmail ?? null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(devisCostAnalyses.devisId, devisId),
              eq(devisCostAnalyses.revision, args.expectedRevision),
            ),
          )
          .returning();
        if (!updated) return { outcome: "stale" as const };
        row = updated;
      }

      // A confirmed analysis renders into the PDFs, so any transition
      // involving 'confirmed' (before OR after) must invalidate the cache
      // atomically with the write — same version-guard as context saves.
      const touchesPdf = args.status === "confirmed" || existing?.status === "confirmed";
      if (touchesPdf && translation) {
        await tx
          .update(devisTranslations)
          .set({
            contextsVersion: sql`${devisTranslations.contextsVersion} + 1`,
            translatedPdfStorageKey: null,
            combinedPdfStorageKey: null,
            updatedAt: new Date(),
          })
          .where(eq(devisTranslations.devisId, devisId));
      }
      return { outcome: "saved" as const, analysis: row };
    });
  }

  async deleteDevisCostAnalysisIfRevision(
    devisId: number,
    expectedRevision: number,
  ): Promise<{ outcome: "deleted" | "stale" | "finalised" | "not_found" }> {
    return db.transaction(async (tx) => {
      const [translation] = await tx
        .select({ status: devisTranslations.status })
        .from(devisTranslations)
        .where(eq(devisTranslations.devisId, devisId))
        .for("update");
      if (translation?.status === "finalised") return { outcome: "finalised" as const };

      const [existing] = await tx
        .select({ status: devisCostAnalyses.status })
        .from(devisCostAnalyses)
        .where(eq(devisCostAnalyses.devisId, devisId));
      if (!existing) return { outcome: "not_found" as const };

      const deleted = await tx
        .delete(devisCostAnalyses)
        .where(
          and(
            eq(devisCostAnalyses.devisId, devisId),
            eq(devisCostAnalyses.revision, expectedRevision),
          ),
        )
        .returning({ id: devisCostAnalyses.id });
      if (deleted.length === 0) return { outcome: "stale" as const };

      if (existing.status === "confirmed" && translation) {
        await tx
          .update(devisTranslations)
          .set({
            contextsVersion: sql`${devisTranslations.contextsVersion} + 1`,
            translatedPdfStorageKey: null,
            combinedPdfStorageKey: null,
            updatedAt: new Date(),
          })
          .where(eq(devisTranslations.devisId, devisId));
      }
      return { outcome: "deleted" as const };
    });
  }

  async createDevisLineContextAsset(data: InsertDevisLineContextAsset): Promise<DevisLineContextAsset | undefined> {
    // Guarded like the context save: the asset row only commits while the
    // translation is not finalised, serialized via the same row lock.
    return db.transaction(async (tx) => {
      const [translation] = await tx
        .select({ status: devisTranslations.status })
        .from(devisTranslations)
        .where(eq(devisTranslations.devisId, data.devisId))
        .for("update");
      if (translation?.status === "finalised") return undefined;
      const [row] = await tx.insert(devisLineContextAssets).values(data).returning();
      return row;
    });
  }

  async getDevisLineContextAsset(id: number): Promise<DevisLineContextAsset | undefined> {
    const [row] = await db.select().from(devisLineContextAssets).where(eq(devisLineContextAssets.id, id));
    return row;
  }

  async getDevisLineContextAssets(devisLineItemId: number): Promise<DevisLineContextAsset[]> {
    return db
      .select()
      .from(devisLineContextAssets)
      .where(eq(devisLineContextAssets.devisLineItemId, devisLineItemId));
  }

  async getDevisLineContextAssetsByDevis(devisId: number): Promise<DevisLineContextAsset[]> {
    return db.select().from(devisLineContextAssets).where(eq(devisLineContextAssets.devisId, devisId));
  }

  async listStaleDevisLineContextAssets(
    cutoff: Date,
    limit: number,
  ): Promise<Array<{ asset: DevisLineContextAsset; document: unknown | null }>> {
    const rows = await db
      .select({
        asset: devisLineContextAssets,
        document: devisLineContexts.document,
      })
      .from(devisLineContextAssets)
      .leftJoin(
        devisLineContexts,
        eq(devisLineContexts.devisLineItemId, devisLineContextAssets.devisLineItemId),
      )
      .where(lt(devisLineContextAssets.createdAt, cutoff))
      .orderBy(asc(devisLineContextAssets.createdAt))
      .limit(limit);
    return rows;
  }

  async deleteDevisLineContextAsset(id: number): Promise<DevisLineContextAsset | undefined> {
    const [row] = await db
      .delete(devisLineContextAssets)
      .where(eq(devisLineContextAssets.id, id))
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

  async listAwaitingArchitectInbox(limit: number): Promise<InboxContractorResponseRow[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    const rows = await db
      .select({
        checkId: devisChecks.id,
        checkQuery: devisChecks.query,
        checkUpdatedAt: devisChecks.updatedAt,
        devisId: devis.id,
        devisCode: devis.devisCode,
        projectId: devis.projectId,
        projectName: projects.name,
        contractorName: contractors.name,
      })
      .from(devisChecks)
      .innerJoin(devis, eq(devis.id, devisChecks.devisId))
      .innerJoin(projects, eq(projects.id, devis.projectId))
      .leftJoin(contractors, eq(contractors.id, devis.contractorId))
      .where(eq(devisChecks.status, "awaiting_architect"))
      .orderBy(desc(devisChecks.updatedAt))
      .limit(safeLimit);

    if (rows.length === 0) return [];

    const checkIds = rows.map((r) => r.checkId);
    const latestMessages = await db
      .select()
      .from(devisCheckMessages)
      .where(
        and(
          inArray(devisCheckMessages.checkId, checkIds),
          eq(devisCheckMessages.authorType, "contractor"),
        ),
      )
      .orderBy(desc(devisCheckMessages.createdAt));

    const latestByCheckId = new Map<number, typeof latestMessages[number]>();
    for (const m of latestMessages) {
      if (!latestByCheckId.has(m.checkId)) latestByCheckId.set(m.checkId, m);
    }

    return rows.map((r) => {
      const msg = latestByCheckId.get(r.checkId);
      return {
        checkId: r.checkId,
        checkQuery: r.checkQuery,
        checkUpdatedAt: r.checkUpdatedAt,
        devisId: r.devisId,
        devisCode: r.devisCode,
        projectId: r.projectId,
        projectName: r.projectName,
        contractorName: r.contractorName,
        latestMessageBody: msg?.body ?? null,
        latestMessageAt: msg?.createdAt ?? null,
        latestMessageAuthor: msg?.authorName ?? msg?.authorEmail ?? null,
      };
    });
  }

  async countAwaitingArchitectInbox(): Promise<number> {
    const [row] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(devisChecks)
      .where(eq(devisChecks.status, "awaiting_architect"));
    return row?.value ?? 0;
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

  async getLatestDevisCheckToken(devisId: number): Promise<DevisCheckToken | undefined> {
    const [t] = await db
      .select()
      .from(devisCheckTokens)
      .where(eq(devisCheckTokens.devisId, devisId))
      .orderBy(desc(devisCheckTokens.createdAt))
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

  async extendDevisCheckTokenExpiry(id: number, expiresAt: Date | null): Promise<DevisCheckToken | undefined> {
    const [row] = await db
      .update(devisCheckTokens)
      .set({ expiresAt })
      .where(and(eq(devisCheckTokens.id, id), isNull(devisCheckTokens.revokedAt)))
      .returning();
    return row;
  }

  async revokeDevisCheckTokenById(id: number): Promise<DevisCheckToken | undefined> {
    const [row] = await db
      .update(devisCheckTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(devisCheckTokens.id, id), isNull(devisCheckTokens.revokedAt)))
      .returning();
    return row;
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

  // Lifecycle-bound revoke: a devis is "fully invoiced" when the sum of its
  // invoice HT >= its avenant-adjusted contracted HT (i.e. resteARealiser
  // <= 0). Avenants of approved type 'pv' add to the contracted total, 'mv'
  // subtract. Implemented as a single UPDATE so it stays cheap to run
  // either after a single mutation (with a devisId predicate) or as a
  // bulk safety-net sweep in the periodic cleanup job.
  private async revokeFullyInvoicedTokensQuery(
    now: Date,
    devisId: number | null,
  ): Promise<number> {
    const filter = devisId == null
      ? sql``
      : sql` AND t.devis_id = ${devisId}`;
    const result = await db.execute<{ id: number }>(sql`
      UPDATE devis_check_tokens AS t
      SET revoked_at = ${now}
      WHERE t.revoked_at IS NULL${filter}
        AND EXISTS (
          SELECT 1 FROM devis d
          WHERE d.id = t.devis_id
            AND (
              SELECT COALESCE(SUM(i.amount_ht), 0)::numeric
              FROM invoices i WHERE i.devis_id = d.id
            ) >= (
              d.amount_ht::numeric
              + COALESCE((
                  SELECT SUM(a.amount_ht)::numeric FROM avenants a
                  WHERE a.devis_id = d.id AND a.status = 'approved' AND a.type = 'pv'
                ), 0)
              - COALESCE((
                  SELECT SUM(a.amount_ht)::numeric FROM avenants a
                  WHERE a.devis_id = d.id AND a.status = 'approved' AND a.type = 'mv'
                ), 0)
            )
        )
      RETURNING t.id
    `);
    // db.execute returns the underlying pg QueryResult<T>; we use its
    // strongly-typed `rows` array so the row count is derived without a cast.
    return result.rows.length;
  }

  async revokeDevisCheckTokensForFullyInvoicedDevis(now: Date = new Date()): Promise<number> {
    return this.revokeFullyInvoicedTokensQuery(now, null);
  }

  async revokeDevisCheckTokenIfFullyInvoiced(
    devisId: number,
    now: Date = new Date(),
  ): Promise<number> {
    return this.revokeFullyInvoicedTokensQuery(now, devisId);
  }

  // ----------------------------------------------------------------------
  // AT2 client review portal storage methods.
  // Mirror the devis-check counterparts above; kept verbatim-similar so
  // future contract changes apply mechanically to both portals.
  // ----------------------------------------------------------------------

  async listClientChecks(devisId: number): Promise<ClientCheck[]> {
    return db
      .select()
      .from(clientChecks)
      .where(eq(clientChecks.devisId, devisId))
      .orderBy(asc(clientChecks.createdAt));
  }

  async getClientCheck(id: number): Promise<ClientCheck | undefined> {
    const [c] = await db.select().from(clientChecks).where(eq(clientChecks.id, id));
    return c;
  }

  async createClientCheck(data: InsertClientCheck): Promise<ClientCheck> {
    const [created] = await db.insert(clientChecks).values(data).returning();
    return created;
  }

  async updateClientCheck(
    id: number,
    data: Partial<InsertClientCheck> & { resolvedAt?: Date | null },
  ): Promise<ClientCheck | undefined> {
    const [updated] = await db
      .update(clientChecks)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(clientChecks.id, id))
      .returning();
    return updated;
  }

  async listClientCheckMessages(checkId: number): Promise<ClientCheckMessage[]> {
    return db
      .select()
      .from(clientCheckMessages)
      .where(eq(clientCheckMessages.checkId, checkId))
      .orderBy(asc(clientCheckMessages.createdAt));
  }

  async createClientCheckMessage(data: InsertClientCheckMessage): Promise<ClientCheckMessage> {
    const [created] = await db.insert(clientCheckMessages).values(data).returning();
    return created;
  }

  async getActiveClientCheckToken(devisId: number): Promise<ClientCheckToken | undefined> {
    const [t] = await db
      .select()
      .from(clientCheckTokens)
      .where(and(eq(clientCheckTokens.devisId, devisId), isNull(clientCheckTokens.revokedAt)))
      .limit(1);
    return t;
  }

  async getLatestClientCheckToken(devisId: number): Promise<ClientCheckToken | undefined> {
    const [t] = await db
      .select()
      .from(clientCheckTokens)
      .where(eq(clientCheckTokens.devisId, devisId))
      .orderBy(desc(clientCheckTokens.createdAt))
      .limit(1);
    return t;
  }

  async createClientCheckToken(data: InsertClientCheckToken): Promise<ClientCheckToken> {
    // Revoke any existing active row first to satisfy the partial unique
    // index `client_check_tokens_one_active_idx`. Critically this also
    // covers expired-but-not-yet-revoked rows that the cleanup sweep has
    // not gotten to yet — the AT1 footgun the architect flagged for the
    // contractor portal applies verbatim here.
    //
    // Wrapped in a transaction with a per-devis advisory lock so two
    // concurrent issue requests (e.g. double-click) don't race the revoke +
    // insert and trip the partial unique index — the loser would otherwise
    // surface as a 500. A simple row-level lock on the existing active row
    // is NOT enough: when no active row exists yet, both transactions would
    // see "nothing to update" and proceed to two concurrent INSERTs that
    // both target the partial unique index. `pg_advisory_xact_lock` gives
    // us a per-devis mutex that exists regardless of whether a row is
    // present, automatically released on commit/rollback.
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${data.devisId}::bigint)`);
      await tx
        .update(clientCheckTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(clientCheckTokens.devisId, data.devisId), isNull(clientCheckTokens.revokedAt)));
      const [created] = await tx.insert(clientCheckTokens).values(data).returning();
      return created;
    });
  }

  async revokeClientCheckTokensForDevis(devisId: number): Promise<void> {
    await db
      .update(clientCheckTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(clientCheckTokens.devisId, devisId), isNull(clientCheckTokens.revokedAt)));
  }

  async getClientCheckTokenByHash(hash: string): Promise<ClientCheckToken | undefined> {
    const [t] = await db.select().from(clientCheckTokens).where(eq(clientCheckTokens.tokenHash, hash));
    return t;
  }

  async touchClientCheckTokenUsed(id: number, expiresAt: Date | null): Promise<void> {
    await db
      .update(clientCheckTokens)
      .set({ lastUsedAt: new Date(), expiresAt })
      .where(eq(clientCheckTokens.id, id));
  }

  async extendClientCheckTokenExpiry(id: number, expiresAt: Date | null): Promise<ClientCheckToken | undefined> {
    const [row] = await db
      .update(clientCheckTokens)
      .set({ expiresAt })
      .where(and(eq(clientCheckTokens.id, id), isNull(clientCheckTokens.revokedAt)))
      .returning();
    return row;
  }

  async revokeClientCheckTokenById(id: number): Promise<ClientCheckToken | undefined> {
    const [row] = await db
      .update(clientCheckTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(clientCheckTokens.id, id), isNull(clientCheckTokens.revokedAt)))
      .returning();
    return row;
  }

  // --- Project-scoped client share link (Task #388) ---------------------

  async getActiveProjectShareToken(projectId: number): Promise<ClientProjectShareToken | undefined> {
    const [t] = await db
      .select()
      .from(clientProjectShareTokens)
      .where(and(eq(clientProjectShareTokens.projectId, projectId), isNull(clientProjectShareTokens.revokedAt)))
      .limit(1);
    return t;
  }

  async getLatestProjectShareToken(projectId: number): Promise<ClientProjectShareToken | undefined> {
    const [t] = await db
      .select()
      .from(clientProjectShareTokens)
      .where(eq(clientProjectShareTokens.projectId, projectId))
      .orderBy(desc(clientProjectShareTokens.createdAt))
      .limit(1);
    return t;
  }

  async createProjectShareToken(data: InsertClientProjectShareToken): Promise<ClientProjectShareToken> {
    // Same race-hardening as createClientCheckToken: advisory lock keyed on
    // the project so two concurrent issues can't trip the partial unique
    // index. Uses a distinct lock namespace offset so it can't collide with
    // the per-devis lock keyed on devis ids.
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('client_project_share'), ${data.projectId}::int)`);
      const [prior] = await tx
        .select()
        .from(clientProjectShareTokens)
        .where(and(eq(clientProjectShareTokens.projectId, data.projectId), isNull(clientProjectShareTokens.revokedAt)))
        .limit(1);
      if (prior) {
        await tx
          .update(clientProjectShareTokens)
          .set({ revokedAt: new Date() })
          .where(eq(clientProjectShareTokens.id, prior.id));
      }
      const [created] = await tx.insert(clientProjectShareTokens).values(data).returning();
      if (prior) {
        // Carry the publish memberships forward — rotating the link must not
        // silently unpublish the quotations the architect already curated.
        const memberships = await tx
          .select()
          .from(clientProjectShareDevis)
          .where(eq(clientProjectShareDevis.tokenId, prior.id));
        if (memberships.length > 0) {
          await tx.insert(clientProjectShareDevis).values(
            memberships.map((m) => ({
              tokenId: created.id,
              devisId: m.devisId,
              publishedByUserId: m.publishedByUserId,
              publishedAt: m.publishedAt,
            })),
          );
        }
      }
      return created;
    });
  }

  async getProjectShareTokenByHash(hash: string): Promise<ClientProjectShareToken | undefined> {
    const [t] = await db
      .select()
      .from(clientProjectShareTokens)
      .where(eq(clientProjectShareTokens.tokenHash, hash));
    return t;
  }

  async touchProjectShareTokenUsed(id: number, expiresAt: Date | null): Promise<void> {
    await db
      .update(clientProjectShareTokens)
      .set({ lastUsedAt: new Date(), expiresAt })
      .where(eq(clientProjectShareTokens.id, id));
  }

  async extendProjectShareTokenExpiry(id: number, expiresAt: Date | null): Promise<ClientProjectShareToken | undefined> {
    const [row] = await db
      .update(clientProjectShareTokens)
      .set({ expiresAt })
      .where(and(eq(clientProjectShareTokens.id, id), isNull(clientProjectShareTokens.revokedAt)))
      .returning();
    return row;
  }

  async revokeProjectShareTokenById(id: number): Promise<ClientProjectShareToken | undefined> {
    const [row] = await db
      .update(clientProjectShareTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(clientProjectShareTokens.id, id), isNull(clientProjectShareTokens.revokedAt)))
      .returning();
    return row;
  }

  async listProjectShareDevisIds(tokenId: number): Promise<number[]> {
    const rows = await db
      .select({ devisId: clientProjectShareDevis.devisId })
      .from(clientProjectShareDevis)
      .where(eq(clientProjectShareDevis.tokenId, tokenId));
    return rows.map((r) => r.devisId);
  }

  async publishDevisToProjectShare(data: InsertClientProjectShareDevis): Promise<ClientProjectShareDevis> {
    // Idempotent: re-publishing an already-published devis is a no-op that
    // returns the existing row (unique index on token_id + devis_id).
    const [created] = await db
      .insert(clientProjectShareDevis)
      .values(data)
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [existing] = await db
      .select()
      .from(clientProjectShareDevis)
      .where(and(
        eq(clientProjectShareDevis.tokenId, data.tokenId),
        eq(clientProjectShareDevis.devisId, data.devisId),
      ));
    return existing;
  }

  async unpublishDevisFromProjectShare(tokenId: number, devisId: number): Promise<boolean> {
    const rows = await db
      .delete(clientProjectShareDevis)
      .where(and(
        eq(clientProjectShareDevis.tokenId, tokenId),
        eq(clientProjectShareDevis.devisId, devisId),
      ))
      .returning({ id: clientProjectShareDevis.id });
    return rows.length > 0;
  }

  async createProjectShareAuditEntry(data: InsertClientProjectShareAuditEntry): Promise<ClientProjectShareAuditEntry> {
    const [row] = await db.insert(clientProjectShareAudit).values(data).returning();
    return row;
  }

  async createProjectShareAuditEntryIfAbsentSince(
    data: InsertClientProjectShareAuditEntry & { tokenId: number },
    since: Date,
  ): Promise<boolean> {
    // Task #409 — atomic once-per-window audit insert. The advisory lock
    // (namespace distinct from the issue-path lock) serialises concurrent
    // lookups on the same token so check-then-insert cannot race.
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('client_project_share_audit_dedup'), ${data.tokenId}::int)`);
      const [existing] = await tx
        .select({ id: clientProjectShareAudit.id })
        .from(clientProjectShareAudit)
        .where(and(
          eq(clientProjectShareAudit.tokenId, data.tokenId),
          eq(clientProjectShareAudit.action, data.action),
          gte(clientProjectShareAudit.createdAt, since),
        ))
        .limit(1);
      if (existing) return false;
      await tx.insert(clientProjectShareAudit).values(data);
      return true;
    });
  }

  // --- Task #410 — ArchiDoc link-lookup misses --------------------------

  async upsertArchidocLinkLookupMiss(projectId: number, reason: ArchidocLookupMissReason): Promise<void> {
    await db
      .insert(archidocLinkLookupMisses)
      .values({ projectId, reason, lastMissAt: new Date() })
      .onConflictDoUpdate({
        target: archidocLinkLookupMisses.projectId,
        set: { reason, lastMissAt: new Date() },
      });
  }

  async clearArchidocLinkLookupMiss(projectId: number): Promise<void> {
    await db.delete(archidocLinkLookupMisses).where(eq(archidocLinkLookupMisses.projectId, projectId));
  }

  async getArchidocLinkLookupMiss(projectId: number): Promise<ArchidocLinkLookupMiss | undefined> {
    const [row] = await db
      .select()
      .from(archidocLinkLookupMisses)
      .where(eq(archidocLinkLookupMisses.projectId, projectId))
      .limit(1);
    return row;
  }

  async listProjectShareAuditEntries(projectId: number, limit = 100): Promise<ClientProjectShareAuditEntry[]> {
    return db
      .select()
      .from(clientProjectShareAudit)
      .where(eq(clientProjectShareAudit.projectId, projectId))
      .orderBy(desc(clientProjectShareAudit.createdAt), desc(clientProjectShareAudit.id))
      .limit(limit);
  }

  async revokeExpiredClientCheckTokens(now: Date = new Date()): Promise<number> {
    const rows = await db
      .update(clientCheckTokens)
      .set({ revokedAt: now })
      .where(
        and(
          isNull(clientCheckTokens.revokedAt),
          isNotNull(clientCheckTokens.expiresAt),
          lte(clientCheckTokens.expiresAt, now),
        ),
      )
      .returning({ id: clientCheckTokens.id });
    return rows.length;
  }

  // Same sweep for the project-scoped share links: revoke expired-but-not-
  // revoked rows so a stale expired row can never block the partial unique
  // "one active per project" index when a new link is issued.
  async revokeExpiredClientProjectShareTokens(now: Date = new Date()): Promise<number> {
    const rows = await db
      .update(clientProjectShareTokens)
      .set({ revokedAt: now })
      .where(
        and(
          isNull(clientProjectShareTokens.revokedAt),
          isNotNull(clientProjectShareTokens.expiresAt),
          lte(clientProjectShareTokens.expiresAt, now),
        ),
      )
      .returning({ id: clientProjectShareTokens.id });
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
    //
    // System (audit) messages are EXCLUDED from the fingerprint: each
    // dispatch writes one such row in every check thread, and counting
    // them would defeat the dedupe (a second click — or any retry — would
    // see a bumped fingerprint and queue another email even though the
    // conversation hasn't actually moved).
    if (checkIds.length === 0) return 0;
    const rows = await db
      .select({ id: devisCheckMessages.id })
      .from(devisCheckMessages)
      .where(
        and(
          inArray(devisCheckMessages.checkId, checkIds),
          ne(devisCheckMessages.authorType, "system"),
        ),
      )
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

  // -- Gmail polling per-user OAuth (migration 0030) -----------------------
  async listGmailPollingUsers(): Promise<User[]> {
    return db
      .select()
      .from(users)
      .where(
        and(
          isNotNull(users.gmailRefreshToken),
          eq(users.gmailPollingEnabled, true),
        ),
      );
  }

  async updateUserGmailTokens(userId: number, tokens: {
    gmailRefreshToken?: string | null;
    gmailAccessToken?: string | null;
    gmailTokenExpiresAt?: Date | null;
    gmailScopeGranted?: string | null;
  }): Promise<void> {
    // Build the update payload defensively: `undefined` means "leave alone"
    // (notably for refresh_token which Google only rotates occasionally),
    // `null` means "explicitly clear" (used by unlink).
    const patch: Record<string, unknown> = {};
    if (tokens.gmailRefreshToken !== undefined) patch.gmailRefreshToken = tokens.gmailRefreshToken;
    if (tokens.gmailAccessToken !== undefined) patch.gmailAccessToken = tokens.gmailAccessToken;
    if (tokens.gmailTokenExpiresAt !== undefined) patch.gmailTokenExpiresAt = tokens.gmailTokenExpiresAt;
    if (tokens.gmailScopeGranted !== undefined) patch.gmailScopeGranted = tokens.gmailScopeGranted;
    if (Object.keys(patch).length === 0) return;
    await db.update(users).set(patch).where(eq(users.id, userId));
  }

  async updateUserGmailPollStatus(userId: number, status: {
    gmailLastPollAt: Date;
    gmailLastPollStatus: string;
    gmailLastPollError: string | null;
  }): Promise<void> {
    await db.update(users).set(status).where(eq(users.id, userId));
  }

  async setUserGmailPollingEnabled(userId: number, enabled: boolean): Promise<void> {
    await db.update(users).set({ gmailPollingEnabled: enabled }).where(eq(users.id, userId));
  }

  async unlinkUserGmail(userId: number): Promise<void> {
    await db.update(users).set({
      gmailRefreshToken: null,
      gmailAccessToken: null,
      gmailTokenExpiresAt: null,
      gmailScopeGranted: null,
      gmailLastPollStatus: null,
      gmailLastPollError: null,
    }).where(eq(users.id, userId));
  }

  // -- Insurance overrides (AT3, contract §1.3 / §2.1.4) -------------------
  async createInsuranceOverride(data: InsertInsuranceOverride): Promise<InsuranceOverride> {
    const [row] = await db.insert(insuranceOverrides).values(data).returning();
    return row;
  }

  async listInsuranceOverridesForDevis(devisId: number): Promise<InsuranceOverride[]> {
    return db
      .select()
      .from(insuranceOverrides)
      .where(eq(insuranceOverrides.devisId, devisId))
      .orderBy(desc(insuranceOverrides.createdAt));
  }

  async getLatestInsuranceOverrideForDevis(devisId: number): Promise<InsuranceOverride | undefined> {
    const [row] = await db
      .select()
      .from(insuranceOverrides)
      .where(eq(insuranceOverrides.devisId, devisId))
      .orderBy(desc(insuranceOverrides.createdAt))
      .limit(1);
    return row;
  }

  // -- Batch readiness queries (Task #374 devis readiness strip) -----------

  async getDevisTranslationStatusesByProject(projectId: number): Promise<Record<number, string>> {
    const rows = await db
      .select({ devisId: devisTranslations.devisId, status: devisTranslations.status })
      .from(devisTranslations)
      .innerJoin(devis, eq(devisTranslations.devisId, devis.id))
      .where(eq(devis.projectId, projectId));
    const out: Record<number, string> = {};
    for (const r of rows) out[r.devisId] = r.status;
    return out;
  }

  async countOpenClientChecksForProject(projectId: number): Promise<Record<number, number>> {
    const rows = await db
      .select({ devisId: clientChecks.devisId })
      .from(clientChecks)
      .innerJoin(devis, eq(clientChecks.devisId, devis.id))
      .where(and(eq(devis.projectId, projectId), eq(clientChecks.status, "open")));
    const out: Record<number, number> = {};
    for (const r of rows) out[r.devisId] = (out[r.devisId] ?? 0) + 1;
    return out;
  }

  async listDevisIdsWithInsuranceOverride(devisIds: number[]): Promise<Set<number>> {
    if (devisIds.length === 0) return new Set();
    const rows = await db
      .selectDistinct({ devisId: insuranceOverrides.devisId })
      .from(insuranceOverrides)
      .where(inArray(insuranceOverrides.devisId, devisIds));
    return new Set(rows.map((r) => r.devisId));
  }

  async getContractorsByIds(ids: number[]): Promise<Contractor[]> {
    if (ids.length === 0) return [];
    return db.select().from(contractors).where(inArray(contractors.id, ids));
  }

  // -- Archisign envelope tracking + inbound webhook (AT4) -----------------

  async claimWebhookEventIn(data: InsertWebhookEventIn): Promise<boolean> {
    // INSERT ... ON CONFLICT DO NOTHING returning the row when newly
    // inserted; absence of a row means the dedup index won — caller
    // short-circuits to 200 {deduplicated:true}.
    const rows = await db
      .insert(webhookEventsIn)
      .values(data)
      .onConflictDoNothing({ target: [webhookEventsIn.source, webhookEventsIn.eventId] })
      .returning({ id: webhookEventsIn.id });
    return rows.length > 0;
  }

  async getDevisByArchisignEnvelopeId(envelopeId: string): Promise<Devis | undefined> {
    const [row] = await db
      .select()
      .from(devis)
      .where(eq(devis.archisignEnvelopeId, envelopeId))
      .limit(1);
    return row;
  }

  async recordSignedPdfRetentionBreach(
    data: InsertSignedPdfRetentionBreach,
  ): Promise<SignedPdfRetentionBreach | undefined> {
    // Race-safety: even if claimWebhookEventIn already deduped, the
    // (envelope_id, incident_ref) UNIQUE index belt-and-braces against
    // double-insertion if a future caller path bypasses the inbound
    // dedup. Returning undefined on conflict lets AT5 know "this breach
    // was already recorded — don't re-fire the downstream notify".
    const rows = await db
      .insert(signedPdfRetentionBreaches)
      .values(data)
      .onConflictDoNothing({
        target: [signedPdfRetentionBreaches.archisignEnvelopeId, signedPdfRetentionBreaches.incidentRef],
      })
      .returning();
    return rows[0];
  }

  // -- Outbound webhook deliveries (AT5) -----------------------------------

  async claimWebhookDeliveryOut(
    data: InsertWebhookDeliveryOut,
  ): Promise<{ row: WebhookDeliveryOut; created: boolean }> {
    // INSERT ... ON CONFLICT (event_id) DO NOTHING returning the inserted
    // row when we won the race; otherwise SELECT the existing row so the
    // caller observes the original eventType/payload (G6: eventId stable).
    const inserted = await db
      .insert(webhookDeliveriesOut)
      .values(data)
      .onConflictDoNothing({ target: webhookDeliveriesOut.eventId })
      .returning();
    if (inserted[0]) {
      return { row: inserted[0], created: true };
    }
    const [existing] = await db
      .select()
      .from(webhookDeliveriesOut)
      .where(eq(webhookDeliveriesOut.eventId, data.eventId))
      .limit(1);
    if (!existing) {
      // Should not happen — INSERT failed without a conflict row available.
      throw new Error(`claimWebhookDeliveryOut: race lost but no existing row for eventId=${data.eventId}`);
    }
    return { row: existing, created: false };
  }

  async getWebhookDeliveryOutById(id: number): Promise<WebhookDeliveryOut | undefined> {
    const [row] = await db
      .select()
      .from(webhookDeliveriesOut)
      .where(eq(webhookDeliveriesOut.id, id))
      .limit(1);
    return row;
  }

  async getWebhookDeliveryOutByEventId(
    eventId: string,
  ): Promise<WebhookDeliveryOut | undefined> {
    const [row] = await db
      .select()
      .from(webhookDeliveriesOut)
      .where(eq(webhookDeliveriesOut.eventId, eventId))
      .limit(1);
    return row;
  }

  async listWebhookDeliveriesOut(filter?: {
    state?: WebhookDeliveryState;
    limit?: number;
    offset?: number;
  }): Promise<WebhookDeliveryOut[]> {
    const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 500);
    const offset = Math.max(filter?.offset ?? 0, 0);
    const baseQuery = db.select().from(webhookDeliveriesOut);
    const filtered = filter?.state
      ? baseQuery.where(eq(webhookDeliveriesOut.state, filter.state))
      : baseQuery;
    return filtered
      .orderBy(desc(webhookDeliveriesOut.updatedAt))
      .limit(limit)
      .offset(offset);
  }

  async listDueWebhookDeliveries(limit: number): Promise<WebhookDeliveryOut[]> {
    const cap = Math.min(Math.max(limit, 1), 100);
    return db
      .select()
      .from(webhookDeliveriesOut)
      .where(
        and(
          eq(webhookDeliveriesOut.state, "pending"),
          or(
            isNull(webhookDeliveriesOut.nextAttemptAt),
            lte(webhookDeliveriesOut.nextAttemptAt, sql`CURRENT_TIMESTAMP`),
          ),
        ),
      )
      .orderBy(asc(webhookDeliveriesOut.createdAt))
      .limit(cap);
  }

  async updateWebhookDeliveryAttempt(
    id: number,
    patch: {
      state: WebhookDeliveryState;
      attemptCount: number;
      lastAttemptAt: Date;
      lastErrorBody?: string | null;
      nextAttemptAt?: Date | null;
      succeededAt?: Date | null;
      deadLetteredAt?: Date | null;
    },
  ): Promise<WebhookDeliveryOut | undefined> {
    const [row] = await db
      .update(webhookDeliveriesOut)
      .set({
        state: patch.state,
        attemptCount: patch.attemptCount,
        lastAttemptAt: patch.lastAttemptAt,
        lastErrorBody: patch.lastErrorBody ?? null,
        nextAttemptAt: patch.nextAttemptAt ?? null,
        succeededAt: patch.succeededAt ?? null,
        deadLetteredAt: patch.deadLetteredAt ?? null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(webhookDeliveriesOut.id, id))
      .returning();
    return row;
  }

  async resetWebhookDeliveryForRetry(id: number): Promise<WebhookDeliveryOut | undefined> {
    // Admin one-click retry: state→pending, clear terminal flags, arm
    // for immediate attempt (next_attempt_at=NULL). Preserves event_id
    // and attempt_count so admins can see the cumulative attempt history.
    const [row] = await db
      .update(webhookDeliveriesOut)
      .set({
        state: "pending",
        nextAttemptAt: null,
        deadLetteredAt: null,
        succeededAt: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(webhookDeliveriesOut.id, id))
      .returning();
    return row;
  }

  // --- Task #198: Drive auto-upload ----------------------------------

  async setProjectDriveFolderId(projectId: number, folderId: string): Promise<void> {
    await db.update(projects).set({ driveFolderId: folderId }).where(eq(projects.id, projectId));
  }

  async setLotDriveFolderId(lotId: number, folderId: string): Promise<void> {
    await db.update(lots).set({ driveFolderId: folderId }).where(eq(lots.id, lotId));
  }

  async setDevisDriveLink(devisId: number, fileId: string, webViewLink: string): Promise<void> {
    await db
      .update(devis)
      .set({ driveFileId: fileId, driveWebViewLink: webViewLink, driveUploadedAt: new Date() })
      .where(eq(devis.id, devisId));
  }

  async recordSignedPdfPersistFailure(
    devisId: number,
    errorMessage: string,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    // Increment attempts even when we're giving up (next_attempt_at=null)
    // so the row's attempt count is the audit-truth of how hard we tried.
    await db
      .update(devis)
      .set({
        signedPdfRetryAttempts: sql`${devis.signedPdfRetryAttempts} + 1`,
        signedPdfNextAttemptAt: nextAttemptAt,
        signedPdfLastError: errorMessage.slice(0, 2000),
      })
      .where(and(eq(devis.id, devisId), isNull(devis.signedPdfStorageKey)));
  }

  async armSignedPdfPersistRetry(devisId: number, nextAttemptAt: Date): Promise<void> {
    // Pre-arm the retry queue BEFORE the detached first-attempt task
    // runs. If the process crashes between this row's commit and the
    // detached persist completing, the sweeper will pick the row up
    // when next_attempt_at is due. Conditional WHERE keeps the arming
    // a no-op once a real attempt has either succeeded
    // (signed_pdf_storage_key set) or recorded a failure (attempts > 0).
    await db
      .update(devis)
      .set({ signedPdfNextAttemptAt: nextAttemptAt })
      .where(
        and(
          eq(devis.id, devisId),
          isNull(devis.signedPdfStorageKey),
          eq(devis.signedPdfRetryAttempts, 0),
        ),
      );
  }

  async clearSignedPdfRetry(devisId: number): Promise<void> {
    await db
      .update(devis)
      .set({
        signedPdfRetryAttempts: 0,
        signedPdfNextAttemptAt: null,
        signedPdfLastError: null,
      })
      .where(eq(devis.id, devisId));
  }

  async listDueSignedPdfRetries(limit: number): Promise<Array<{ id: number }>> {
    // Pick devis that need a (re)try: signed_pdf_storage_key NULL
    // (no audit copy yet), envelope present, attempts under cap, and
    // signed_pdf_next_attempt_at IS NOT NULL AND <= now.
    //
    // CRITICAL: NULL next_attempt_at means TERMINAL (retention breach
    // gave up, or no retry is currently scheduled). We MUST NOT pick
    // those rows up. The webhook handler arms next_attempt_at
    // immediately after writing client_signed_off, so a process crash
    // before the detached persist runs still leaves the row picked
    // up by this sweeper on the next pass.
    const rows = await db
      .select({ id: devis.id })
      .from(devis)
      .where(
        and(
          isNull(devis.signedPdfStorageKey),
          isNotNull(devis.archisignEnvelopeId),
          isNotNull(devis.signedPdfNextAttemptAt),
          lte(devis.signedPdfNextAttemptAt, new Date()),
          sql`${devis.signedPdfRetryAttempts} < 5`,
        ),
      )
      .limit(limit);
    return rows;
  }

  async listSignedPdfRecoveryCandidates() {
    // Devis stuck at `client_signed_off` with an envelope but no
    // persisted audit copy. LEFT JOIN signed_pdf_retention_breaches so
    // the admin UI can grey out rows whose bytes Archisign has already
    // purged (no point retrying — the source of truth is gone).
    const rows = await db
      .select({
        id: devis.id,
        devisCode: devis.devisCode,
        projectId: devis.projectId,
        lotId: devis.lotId,
        archisignEnvelopeId: devis.archisignEnvelopeId,
        signedPdfRetryAttempts: devis.signedPdfRetryAttempts,
        signedPdfNextAttemptAt: devis.signedPdfNextAttemptAt,
        signedPdfLastError: devis.signedPdfLastError,
        dateSigned: devis.dateSigned,
        retentionBreachedAt: signedPdfRetentionBreaches.detectedAt,
        retentionIncidentRef: signedPdfRetentionBreaches.incidentRef,
      })
      .from(devis)
      .leftJoin(
        signedPdfRetentionBreaches,
        eq(signedPdfRetentionBreaches.devisId, devis.id),
      )
      .where(
        and(
          eq(devis.signOffStage, "client_signed_off"),
          isNotNull(devis.archisignEnvelopeId),
          isNull(devis.signedPdfStorageKey),
        ),
      )
      .orderBy(desc(devis.dateSigned), desc(devis.id));
    return rows;
  }

  async listArchisignRenderingDriftDevis() {
    // Task #279 / #283 — rows whose CURRENT envelope reported §3.5.1.1
    // rendering drift (subject and/or body half of the emailRendering
    // echo). Both flags are reset to NULL on each fresh /create without
    // drift, so no additional envelope-liveness filter is needed here.
    const rows = await db
      .select({
        id: devis.id,
        devisCode: devis.devisCode,
        devisNumber: devis.devisNumber,
        projectId: devis.projectId,
        projectName: projects.name,
        archisignEnvelopeId: devis.archisignEnvelopeId,
        archisignEnvelopeStatus: devis.archisignEnvelopeStatus,
        signOffStage: devis.signOffStage,
        archisignSubjectDriftAt: devis.archisignSubjectDriftAt,
        archisignBodyDriftAt: devis.archisignBodyDriftAt,
      })
      .from(devis)
      .leftJoin(projects, eq(projects.id, devis.projectId))
      .where(
        or(
          isNotNull(devis.archisignSubjectDriftAt),
          isNotNull(devis.archisignBodyDriftAt),
        ),
      )
      .orderBy(
        desc(
          sql`GREATEST(${devis.archisignSubjectDriftAt}, ${devis.archisignBodyDriftAt})`,
        ),
        desc(devis.id),
      );
    return rows;
  }

  async setDevisSignedPdfStorageKey(devisId: number, storageKey: string): Promise<void> {
    // Task #206 — one-shot persist. Guarded against overwrite so a
    // redelivered `envelope.signed` webhook can never replace an
    // already-persisted signed PDF (each Archisign download mints a
    // new short-lived URL but the bytes are immutable; we keep the
    // first-saved key as the canonical audit pointer).
    await db
      .update(devis)
      .set({ signedPdfStorageKey: storageKey })
      .where(and(eq(devis.id, devisId), isNull(devis.signedPdfStorageKey)));
  }

  async setInvoiceDriveLink(invoiceId: number, fileId: string, webViewLink: string): Promise<void> {
    await db
      .update(invoices)
      .set({ driveFileId: fileId, driveWebViewLink: webViewLink, driveUploadedAt: new Date() })
      .where(eq(invoices.id, invoiceId));
  }

  async setCertificatDriveLink(certificatId: number, fileId: string, webViewLink: string): Promise<void> {
    await db
      .update(certificats)
      .set({ driveFileId: fileId, driveWebViewLink: webViewLink, driveUploadedAt: new Date() })
      .where(eq(certificats.id, certificatId));
  }

  async upsertDriveUpload(data: InsertDriveUpload): Promise<DriveUpload> {
    // ON CONFLICT DO NOTHING semantics: re-enqueueing an existing
    // (docKind, docId) row never resets a succeeded/dead-lettered row.
    // We INSERT and on conflict return the EXISTING row untouched.
    const [inserted] = await db
      .insert(driveUploads)
      .values(data)
      .onConflictDoNothing({
        target: [driveUploads.docKind, driveUploads.docId],
      })
      .returning();
    if (inserted) return inserted;
    const [existing] = await db
      .select()
      .from(driveUploads)
      .where(and(eq(driveUploads.docKind, data.docKind), eq(driveUploads.docId, data.docId)));
    return existing;
  }

  async claimDriveUploadForAttempt(uploadId: number): Promise<DriveUpload | null> {
    // Atomic claim: only flip from `pending` → `in_flight`. If another
    // worker has already claimed it (or the row finished/dead-lettered)
    // the UPDATE matches zero rows and we bail.
    const [row] = await db
      .update(driveUploads)
      .set({ state: "in_flight", lastAttemptAt: new Date(), updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(driveUploads.id, uploadId), eq(driveUploads.state, "pending")))
      .returning();
    return row ?? null;
  }

  async markDriveUploadSucceeded(args: { uploadId: number; attempts: number; driveFileId: string; driveWebViewLink: string }): Promise<void> {
    await db
      .update(driveUploads)
      .set({
        state: "succeeded",
        attempts: args.attempts,
        driveFileId: args.driveFileId,
        driveWebViewLink: args.driveWebViewLink,
        lastError: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(driveUploads.id, args.uploadId));
  }

  async markDriveUploadDeadLettered(args: { uploadId: number; attempts: number; lastError: string }): Promise<void> {
    await db
      .update(driveUploads)
      .set({
        state: "dead_letter",
        attempts: args.attempts,
        lastError: args.lastError,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(driveUploads.id, args.uploadId));
  }

  async markDriveUploadPendingRetry(args: { uploadId: number; attempts: number; lastError: string; nextAttemptAt: Date }): Promise<void> {
    await db
      .update(driveUploads)
      .set({
        state: "pending",
        attempts: args.attempts,
        lastError: args.lastError,
        nextAttemptAt: args.nextAttemptAt,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(driveUploads.id, args.uploadId));
  }

  async reclaimStaleDriveUploads(maxAgeMs: number): Promise<number> {
    // Stale-claim recovery (architect review of Task #198): if a
    // worker crashed between flipping pending→in_flight and finishing
    // the upload, the row would otherwise sit in `in_flight` forever
    // because the sweeper only scans `pending`. We reclaim any
    // `in_flight` row whose `lastAttemptAt` is older than the
    // configured lease window, returning it to `pending` for the
    // sweeper to re-attempt.
    const cutoff = new Date(Date.now() - maxAgeMs);
    const reclaimed = await db
      .update(driveUploads)
      .set({
        state: "pending",
        nextAttemptAt: new Date(),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(eq(driveUploads.state, "in_flight"), lte(driveUploads.lastAttemptAt, cutoff)))
      .returning({ id: driveUploads.id });
    return reclaimed.length;
  }

  async listDueDriveUploads(limit: number): Promise<DriveUpload[]> {
    return db
      .select()
      .from(driveUploads)
      .where(and(eq(driveUploads.state, "pending"), lte(driveUploads.nextAttemptAt, new Date())))
      .orderBy(asc(driveUploads.nextAttemptAt))
      .limit(limit);
  }

  async listDriveUploads(filter?: { state?: string; limit?: number; offset?: number }): Promise<DriveUpload[]> {
    const where = filter?.state ? eq(driveUploads.state, filter.state) : undefined;
    let q = db.select().from(driveUploads).$dynamic();
    if (where) q = q.where(where);
    return q
      .orderBy(desc(driveUploads.updatedAt))
      .limit(filter?.limit ?? 200)
      .offset(filter?.offset ?? 0);
  }

  async getDriveUpload(uploadId: number): Promise<DriveUpload | undefined> {
    const [row] = await db.select().from(driveUploads).where(eq(driveUploads.id, uploadId));
    return row;
  }

  async resetDriveUploadForRetry(uploadId: number): Promise<DriveUpload | undefined> {
    const [row] = await db
      .update(driveUploads)
      .set({
        state: "pending",
        nextAttemptAt: new Date(),
        lastError: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(driveUploads.id, uploadId))
      .returning();
    return row;
  }

  // ---------------------------------------------------------------------
  // Intake ingest queue + routing (Task #230). The queue row (intake_jobs)
  // mirrors drive_uploads exactly — ON CONFLICT DO NOTHING idempotency on
  // (intake_document_id), atomic claim flip, exponential-backoff retry, and
  // a dead-letter terminal state for the admin DLQ. The user-facing
  // analysis/routing state lives on project_intake_documents.
  // ---------------------------------------------------------------------
  async updateProjectIntakeDocument(id: number, data: Partial<InsertProjectIntakeDocument>): Promise<ProjectIntakeDocument | undefined> {
    const [doc] = await db
      .update(projectIntakeDocuments)
      .set({ ...data, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(projectIntakeDocuments.id, id))
      .returning();
    return doc;
  }

  async findProcessedIntakeDuplicateByFingerprint(projectId: number, fingerprint: string, excludeId: number): Promise<ProjectIntakeDocument | undefined> {
    // A "true duplicate" is another intake doc in the SAME project that has
    // already been analysed (so its routing outcome is known) and carries
    // the identical exact-bytes fingerprint. Oldest wins so the duplicate
    // always points back to the original.
    const [doc] = await db
      .select()
      .from(projectIntakeDocuments)
      .where(and(
        eq(projectIntakeDocuments.projectId, projectId),
        eq(projectIntakeDocuments.contentFingerprint, fingerprint),
        eq(projectIntakeDocuments.analysisState, "analyzed"),
        ne(projectIntakeDocuments.id, excludeId),
      ))
      .orderBy(asc(projectIntakeDocuments.id))
      .limit(1);
    return doc;
  }

  async findProcessedIntakeDuplicateByTextHash(projectId: number, textHash: string, excludeId: number): Promise<ProjectIntakeDocument | undefined> {
    // Secondary, near-duplicate check: same project, already analysed, and
    // the canonical extracted-content hash (stored inside extracted_data)
    // matches — this catches the same logical document re-exported with
    // different bytes.
    const [doc] = await db
      .select()
      .from(projectIntakeDocuments)
      .where(and(
        eq(projectIntakeDocuments.projectId, projectId),
        eq(projectIntakeDocuments.analysisState, "analyzed"),
        ne(projectIntakeDocuments.id, excludeId),
        sql`${projectIntakeDocuments.extractedData}->>'contentHash' = ${textHash}`,
      ))
      .orderBy(asc(projectIntakeDocuments.id))
      .limit(1);
    return doc;
  }

  async upsertIntakeJob(intakeDocumentId: number): Promise<IntakeJob> {
    const [inserted] = await db
      .insert(intakeJobs)
      .values({
        intakeDocumentId,
        state: "pending",
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing({ target: [intakeJobs.intakeDocumentId] })
      .returning();
    if (inserted) return inserted;
    const [existing] = await db
      .select()
      .from(intakeJobs)
      .where(eq(intakeJobs.intakeDocumentId, intakeDocumentId));
    return existing;
  }

  async claimIntakeJobForAttempt(jobId: number): Promise<IntakeJob | null> {
    const [row] = await db
      .update(intakeJobs)
      .set({ state: "in_flight", lastAttemptAt: new Date(), updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(intakeJobs.id, jobId), eq(intakeJobs.state, "pending")))
      .returning();
    return row ?? null;
  }

  async markIntakeJobSucceeded(args: { jobId: number; attempts: number }): Promise<void> {
    await db
      .update(intakeJobs)
      .set({ state: "succeeded", attempts: args.attempts, lastError: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(intakeJobs.id, args.jobId));
  }

  async markIntakeJobDeadLettered(args: { jobId: number; attempts: number; lastError: string }): Promise<void> {
    await db
      .update(intakeJobs)
      .set({ state: "dead_letter", attempts: args.attempts, lastError: args.lastError, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(intakeJobs.id, args.jobId));
  }

  async markIntakeJobPendingRetry(args: { jobId: number; attempts: number; lastError: string; nextAttemptAt: Date }): Promise<void> {
    await db
      .update(intakeJobs)
      .set({ state: "pending", attempts: args.attempts, lastError: args.lastError, nextAttemptAt: args.nextAttemptAt, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(intakeJobs.id, args.jobId));
  }

  async reclaimStaleIntakeJobs(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const reclaimed = await db
      .update(intakeJobs)
      .set({ state: "pending", nextAttemptAt: new Date(), updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(intakeJobs.state, "in_flight"), lte(intakeJobs.lastAttemptAt, cutoff)))
      .returning({ id: intakeJobs.id });
    return reclaimed.length;
  }

  async failOrphanedAnalyzingIntakeDocuments(): Promise<number> {
    // Self-heal drift between the queue row and the owning document. If a
    // job reached a terminal error state (dead_letter / failed) but the
    // paired "mark document failed" write did not land — e.g. a DB blip
    // between the two writes in attemptIntakeJob's permanent-failure path
    // — the document is wedged on `analyzing` forever: the in_flight
    // reclaim never touches it because its job is already terminal. Force
    // such orphans to a terminal state so the UI stops spinning.
    const orphans = await db
      .select({ id: projectIntakeDocuments.id, notes: projectIntakeDocuments.notes })
      .from(projectIntakeDocuments)
      .innerJoin(intakeJobs, eq(intakeJobs.intakeDocumentId, projectIntakeDocuments.id))
      .where(
        and(
          eq(projectIntakeDocuments.analysisState, "analyzing"),
          inArray(intakeJobs.state, ["dead_letter", "failed"]),
        ),
      );
    for (const o of orphans) {
      const note =
        "Analysis marked failed by drift repair: the queue job was terminal but the document was left on \"analyzing\".";
      await this.updateProjectIntakeDocument(o.id, {
        analysisState: "failed",
        routingState: "failed",
        notes: o.notes ? `${o.notes}\n${note}` : note,
      });
    }
    return orphans.length;
  }

  async listDueIntakeJobs(limit: number): Promise<IntakeJob[]> {
    return db
      .select()
      .from(intakeJobs)
      .where(and(eq(intakeJobs.state, "pending"), lte(intakeJobs.nextAttemptAt, new Date())))
      .orderBy(asc(intakeJobs.nextAttemptAt))
      .limit(limit);
  }

  // --- Overlap & supersession detection engine (Task #231) --------------

  async getDocumentEmbedding(devisId: number): Promise<DocumentEmbedding | undefined> {
    const [row] = await db
      .select()
      .from(documentEmbeddings)
      .where(eq(documentEmbeddings.devisId, devisId));
    return row;
  }

  async upsertDocumentEmbedding(args: { projectId: number; devisId: number; contentHash: string; model: string; embedding: number[] }): Promise<void> {
    if (args.embedding.length !== DEVIS_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedding dimension mismatch: got ${args.embedding.length}, expected ${DEVIS_EMBEDDING_DIMENSIONS}`,
      );
    }
    await db
      .insert(documentEmbeddings)
      .values({
        projectId: args.projectId,
        devisId: args.devisId,
        contentHash: args.contentHash,
        model: args.model,
        embedding: args.embedding,
      })
      .onConflictDoUpdate({
        target: [documentEmbeddings.devisId],
        set: {
          projectId: args.projectId,
          contentHash: args.contentHash,
          model: args.model,
          embedding: args.embedding,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  }

  // Cosine-distance nearest neighbours within the SAME project (single-tenant
  // IDOR boundary — never crosses projects). Returns ascending distance
  // (0 = identical, 2 = opposite); caller filters by maxDistance.
  async findSimilarProjectDevis(args: { projectId: number; devisId: number; limit: number; maxDistance: number }): Promise<Array<{ devisId: number; distance: number }>> {
    const [target] = await db
      .select({ embedding: documentEmbeddings.embedding })
      .from(documentEmbeddings)
      .where(eq(documentEmbeddings.devisId, args.devisId));
    if (!target) return [];
    const literal = `[${target.embedding.join(",")}]`;
    const rows = await db.execute<{ devis_id: number; distance: number }>(sql`
      SELECT devis_id, (embedding <=> ${literal}::vector) AS distance
      FROM document_embeddings
      WHERE project_id = ${args.projectId}
        AND devis_id <> ${args.devisId}
        AND (embedding <=> ${literal}::vector) <= ${args.maxDistance}
      ORDER BY distance ASC
      LIMIT ${args.limit}
    `);
    return rows.rows.map((r) => ({ devisId: Number(r.devis_id), distance: Number(r.distance) }));
  }

  async getOverlapCasesByProject(projectId: number, status?: OverlapCaseStatus): Promise<OverlapCase[]> {
    return db
      .select()
      .from(overlapCases)
      .where(status
        ? and(eq(overlapCases.projectId, projectId), eq(overlapCases.status, status))
        : eq(overlapCases.projectId, projectId))
      .orderBy(desc(overlapCases.updatedAt));
  }

  async getOverlapCasesByProjects(projectIds: number[], status?: OverlapCaseStatus): Promise<OverlapCase[]> {
    if (projectIds.length === 0) return [];
    return db
      .select()
      .from(overlapCases)
      .where(status
        ? and(inArray(overlapCases.projectId, projectIds), eq(overlapCases.status, status))
        : inArray(overlapCases.projectId, projectIds))
      .orderBy(desc(overlapCases.updatedAt));
  }

  async getOverlapCase(id: number): Promise<OverlapCase | undefined> {
    const [row] = await db.select().from(overlapCases).where(eq(overlapCases.id, id));
    return row;
  }

  async transitionDevisAccountingState(args: AccountingStateTransition): Promise<void> {
    await this.applyAccountingStateTransitions([args]);
  }

  async applyAccountingStateTransitions(
    transitions: AccountingStateTransition[],
  ): Promise<void> {
    if (transitions.length === 0) return;
    await db.transaction(async (tx) => {
      for (const t of transitions) {
        // Compare-and-set: only move the devis if it is still in the state the
        // caller read. A 0-row result means a concurrent change raced us, so we
        // abort the whole batch rather than partially apply one decision.
        const updated = await tx
          .update(devis)
          .set({ accountingState: t.toState, updatedAt: new Date() })
          .where(and(eq(devis.id, t.devisId), eq(devis.accountingState, t.fromState)))
          .returning({ id: devis.id });
        if (updated.length === 0) {
          throw new AccountingStateConflictError(
            `Devis ${t.devisId} is no longer in expected state '${t.fromState}'`,
          );
        }
        await tx.insert(accountingStateChanges).values({
          devisId: t.devisId,
          projectId: t.projectId,
          fromState: t.fromState,
          toState: t.toState,
          reason: t.reason,
          overlapCaseId: t.overlapCaseId ?? null,
          actorUserId: t.actorUserId ?? null,
          note: t.note ?? null,
        });
      }
    });
  }

  async getDismissedOverlapCaseIds(projectId: number): Promise<number[]> {
    const rows = await db
      .selectDistinct({ overlapCaseId: accountingStateChanges.overlapCaseId })
      .from(accountingStateChanges)
      .where(and(
        eq(accountingStateChanges.projectId, projectId),
        eq(accountingStateChanges.reason, "human_dismiss"),
      ));
    return rows
      .map((r) => r.overlapCaseId)
      .filter((id): id is number => id != null);
  }

  // Overlap cases an architect has ruled on EITHER way (confirm or dismiss).
  // Detection never withdraws a case whose members were superseded by a human
  // confirm (the superseded devis still have status != 'void', so the same
  // overlap is re-detected and the case stays active/needs_review). Read
  // surfaces therefore exclude every humanly-resolved case, not just dismissed
  // ones, so a decision clears the review queue + status badge immediately.
  async getResolvedOverlapCaseIds(projectId: number): Promise<number[]> {
    const rows = await db
      .selectDistinct({ overlapCaseId: accountingStateChanges.overlapCaseId })
      .from(accountingStateChanges)
      .where(and(
        eq(accountingStateChanges.projectId, projectId),
        inArray(accountingStateChanges.reason, ["human_confirm", "human_dismiss"]),
      ));
    return rows
      .map((r) => r.overlapCaseId)
      .filter((id): id is number => id != null);
  }

  async getResolvedOverlapCaseRowsByProjects(
    projectIds: number[],
  ): Promise<Array<{ projectId: number; overlapCaseId: number }>> {
    if (projectIds.length === 0) return [];
    const rows = await db
      .selectDistinct({
        projectId: accountingStateChanges.projectId,
        overlapCaseId: accountingStateChanges.overlapCaseId,
      })
      .from(accountingStateChanges)
      .where(and(
        inArray(accountingStateChanges.projectId, projectIds),
        inArray(accountingStateChanges.reason, ["human_confirm", "human_dismiss"]),
      ));
    return rows
      .filter((r): r is { projectId: number; overlapCaseId: number } => r.overlapCaseId != null);
  }

  async getAccountingStateChangesByDevis(devisId: number): Promise<AccountingStateChange[]> {
    return db
      .select()
      .from(accountingStateChanges)
      .where(eq(accountingStateChanges.devisId, devisId))
      .orderBy(desc(accountingStateChanges.id));
  }

  // Human confirm/dismiss audit rows for a project (powers the resolved-case
  // history view). Ordered newest-first so callers can take the latest row per
  // overlap case as the current decision.
  async getHumanResolvedOverlapDecisions(projectId: number): Promise<AccountingStateChange[]> {
    return db
      .select()
      .from(accountingStateChanges)
      .where(and(
        eq(accountingStateChanges.projectId, projectId),
        isNotNull(accountingStateChanges.overlapCaseId),
        inArray(accountingStateChanges.reason, ["human_confirm", "human_dismiss"]),
      ))
      .orderBy(desc(accountingStateChanges.id));
  }

  async upsertReconciliationJob(projectId: number): Promise<ReconciliationJob> {
    const [inserted] = await db
      .insert(reconciliationJobs)
      .values({
        projectId,
        state: "pending",
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing({ target: [reconciliationJobs.projectId] })
      .returning();
    if (inserted) return inserted;
    // A row already exists for this project. If a previous run finished
    // (succeeded/dead_letter) re-arm it so newly-arrived documents get a
    // fresh pass; otherwise leave the in-flight/pending run to coalesce.
    const [rearmed] = await db
      .update(reconciliationJobs)
      .set({ state: "pending", attempts: 0, lastError: null, nextAttemptAt: new Date(), updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(reconciliationJobs.projectId, projectId), inArray(reconciliationJobs.state, ["succeeded", "dead_letter", "failed"])))
      .returning();
    if (rearmed) return rearmed;
    const [existing] = await db
      .select()
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.projectId, projectId));
    return existing;
  }

  async claimReconciliationJobForAttempt(jobId: number): Promise<ReconciliationJob | null> {
    const [row] = await db
      .update(reconciliationJobs)
      .set({ state: "in_flight", lastAttemptAt: new Date(), updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(reconciliationJobs.id, jobId), eq(reconciliationJobs.state, "pending")))
      .returning();
    return row ?? null;
  }

  async markReconciliationJobSucceeded(args: { jobId: number; attempts: number }): Promise<void> {
    await db
      .update(reconciliationJobs)
      .set({ state: "succeeded", attempts: args.attempts, lastError: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(reconciliationJobs.id, args.jobId));
  }

  async markReconciliationJobDeadLettered(args: { jobId: number; attempts: number; lastError: string }): Promise<void> {
    await db
      .update(reconciliationJobs)
      .set({ state: "dead_letter", attempts: args.attempts, lastError: args.lastError, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(reconciliationJobs.id, args.jobId));
  }

  async markReconciliationJobPendingRetry(args: { jobId: number; attempts: number; lastError: string; nextAttemptAt: Date }): Promise<void> {
    await db
      .update(reconciliationJobs)
      .set({ state: "pending", attempts: args.attempts, lastError: args.lastError, nextAttemptAt: args.nextAttemptAt, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(reconciliationJobs.id, args.jobId));
  }

  async reclaimStaleReconciliationJobs(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const reclaimed = await db
      .update(reconciliationJobs)
      .set({ state: "pending", nextAttemptAt: new Date(), updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(reconciliationJobs.state, "in_flight"), lte(reconciliationJobs.lastAttemptAt, cutoff)))
      .returning({ id: reconciliationJobs.id });
    return reclaimed.length;
  }

  async listDueReconciliationJobs(limit: number): Promise<ReconciliationJob[]> {
    return db
      .select()
      .from(reconciliationJobs)
      .where(and(eq(reconciliationJobs.state, "pending"), lte(reconciliationJobs.nextAttemptAt, new Date())))
      .orderBy(asc(reconciliationJobs.nextAttemptAt))
      .limit(limit);
  }

  async listIntakeJobs(filter?: { state?: string; limit?: number; offset?: number }): Promise<Array<IntakeJob & { projectId: number; fileName: string; source: string; analysisState: string; routingState: string; promotedKind: string | null; promotedId: number | null }>> {
    const where = filter?.state ? eq(intakeJobs.state, filter.state) : undefined;
    let q = db
      .select({
        id: intakeJobs.id,
        intakeDocumentId: intakeJobs.intakeDocumentId,
        state: intakeJobs.state,
        attempts: intakeJobs.attempts,
        lastError: intakeJobs.lastError,
        lastAttemptAt: intakeJobs.lastAttemptAt,
        nextAttemptAt: intakeJobs.nextAttemptAt,
        createdAt: intakeJobs.createdAt,
        updatedAt: intakeJobs.updatedAt,
        projectId: projectIntakeDocuments.projectId,
        fileName: projectIntakeDocuments.fileName,
        source: projectIntakeDocuments.source,
        analysisState: projectIntakeDocuments.analysisState,
        routingState: projectIntakeDocuments.routingState,
        promotedKind: projectIntakeDocuments.promotedKind,
        promotedId: projectIntakeDocuments.promotedId,
      })
      .from(intakeJobs)
      .innerJoin(projectIntakeDocuments, eq(intakeJobs.intakeDocumentId, projectIntakeDocuments.id))
      .$dynamic();
    if (where) q = q.where(where);
    return q
      .orderBy(desc(intakeJobs.updatedAt))
      .limit(filter?.limit ?? 200)
      .offset(filter?.offset ?? 0);
  }

  async getIntakeJob(jobId: number): Promise<IntakeJob | undefined> {
    const [row] = await db.select().from(intakeJobs).where(eq(intakeJobs.id, jobId));
    return row;
  }

  async getIntakeJobByDocumentId(intakeDocumentId: number): Promise<IntakeJob | undefined> {
    const [row] = await db.select().from(intakeJobs).where(eq(intakeJobs.intakeDocumentId, intakeDocumentId));
    return row;
  }

  async resetIntakeJobForRetry(jobId: number): Promise<IntakeJob | undefined> {
    const [row] = await db
      .update(intakeJobs)
      .set({ state: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(intakeJobs.id, jobId))
      .returning();
    return row;
  }

  // ---------------------------------------------------------------------
  // Pennylane push queue (Task #214). Mirrors the drive_uploads shape
  // exactly — ON CONFLICT DO NOTHING idempotency on (kind, doc_id),
  // atomic claim flip, exponential-backoff pending retry, and a
  // dedicated dead-letter terminal state for the admin DLQ.
  // ---------------------------------------------------------------------
  async upsertPennylanePush(data: InsertPennylanePush): Promise<PennylanePush> {
    const [inserted] = await db
      .insert(pennylanePushes)
      .values(data)
      .onConflictDoNothing({
        target: [pennylanePushes.kind, pennylanePushes.docId],
      })
      .returning();
    if (inserted) return inserted;
    const [existing] = await db
      .select()
      .from(pennylanePushes)
      .where(
        and(
          eq(pennylanePushes.kind, data.kind),
          eq(pennylanePushes.docId, data.docId),
        ),
      );
    return existing;
  }

  async claimPennylanePushForAttempt(pushId: number): Promise<PennylanePush | null> {
    const [row] = await db
      .update(pennylanePushes)
      .set({
        state: "in_flight",
        lastAttemptAt: new Date(),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(eq(pennylanePushes.id, pushId), eq(pennylanePushes.state, "pending")),
      )
      .returning();
    return row ?? null;
  }

  async markPennylanePushSucceeded(args: {
    pushId: number;
    attempts: number;
    pennylaneId: string | null;
    dryRun?: boolean;
  }): Promise<void> {
    await db
      .update(pennylanePushes)
      .set({
        state: "succeeded",
        attempts: args.attempts,
        pennylaneId: args.pennylaneId,
        dryRun: args.dryRun ?? false,
        lastError: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(pennylanePushes.id, args.pushId));
  }

  async markPennylanePushDeadLettered(args: { pushId: number; attempts: number; lastError: string }): Promise<void> {
    await db
      .update(pennylanePushes)
      .set({
        state: "dead_letter",
        attempts: args.attempts,
        lastError: args.lastError,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(pennylanePushes.id, args.pushId));
  }

  async markPennylanePushPendingRetry(args: { pushId: number; attempts: number; lastError: string; nextAttemptAt: Date }): Promise<void> {
    await db
      .update(pennylanePushes)
      .set({
        state: "pending",
        attempts: args.attempts,
        lastError: args.lastError,
        nextAttemptAt: args.nextAttemptAt,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(pennylanePushes.id, args.pushId));
  }

  async reclaimStalePennylanePushes(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const reclaimed = await db
      .update(pennylanePushes)
      .set({
        state: "pending",
        nextAttemptAt: new Date(),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(pennylanePushes.state, "in_flight"),
          lte(pennylanePushes.lastAttemptAt, cutoff),
        ),
      )
      .returning({ id: pennylanePushes.id });
    return reclaimed.length;
  }

  async listDuePennylanePushes(limit: number): Promise<PennylanePush[]> {
    return db
      .select()
      .from(pennylanePushes)
      .where(
        and(
          eq(pennylanePushes.state, "pending"),
          lte(pennylanePushes.nextAttemptAt, new Date()),
        ),
      )
      .orderBy(asc(pennylanePushes.nextAttemptAt))
      .limit(limit);
  }

  async listPennylanePushes(filter?: {
    state?: PennylanePushState;
    kind?: PennylanePushKind;
    limit?: number;
    offset?: number;
  }): Promise<PennylanePush[]> {
    const clauses: SQL[] = [];
    if (filter?.state) clauses.push(eq(pennylanePushes.state, filter.state));
    if (filter?.kind) clauses.push(eq(pennylanePushes.kind, filter.kind));
    let q = db.select().from(pennylanePushes).$dynamic();
    if (clauses.length === 1) q = q.where(clauses[0]);
    else if (clauses.length > 1) q = q.where(and(...clauses));
    return q
      .orderBy(desc(pennylanePushes.updatedAt))
      .limit(filter?.limit ?? 200)
      .offset(filter?.offset ?? 0);
  }

  async getPennylanePush(pushId: number): Promise<PennylanePush | undefined> {
    const [row] = await db
      .select()
      .from(pennylanePushes)
      .where(eq(pennylanePushes.id, pushId));
    return row;
  }

  async resetPennylanePushForRetry(pushId: number): Promise<PennylanePush | undefined> {
    const [row] = await db
      .update(pennylanePushes)
      .set({
        state: "pending",
        nextAttemptAt: new Date(),
        lastError: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(pennylanePushes.id, pushId))
      .returning();
    return row;
  }

  // ---------------------------------------------------------------------
  // Pennylane mirror-column setters/getters (Task #214). Kept thin —
  // the queue worker + paid poller call these after a successful API
  // hop. Never write the columns directly from a route handler.
  // ---------------------------------------------------------------------
  async setProjectPennylaneCustomerId(projectId: number, customerId: string): Promise<void> {
    await db
      .update(projects)
      .set({
        pennylaneCustomerId: customerId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(projects.id, projectId));
  }

  async setFeeEntryPennylaneInvoice(args: {
    feeEntryId: number;
    pennylaneInvoiceId: string;
    pennylanePdfStorageKey: string | null;
    pennylaneStatus: string | null;
  }): Promise<void> {
    await db
      .update(feeEntries)
      .set({
        pennylaneInvoiceId: args.pennylaneInvoiceId,
        pennylanePdfStorageKey: args.pennylanePdfStorageKey,
        pennylaneStatus: args.pennylaneStatus,
        pennylanePushedAt: new Date(),
      })
      .where(eq(feeEntries.id, args.feeEntryId));
  }

  async setFeeEntryPennylanePaid(args: {
    feeEntryId: number;
    paidAt: Date | null;
    paidAmount: number | null;
    pennylaneStatus: string;
  }): Promise<void> {
    await db
      .update(feeEntries)
      .set({
        pennylanePaidAt: args.paidAt,
        pennylanePaidAmount: args.paidAmount === null ? null : args.paidAmount.toFixed(2),
        pennylaneStatus: args.pennylaneStatus,
      })
      .where(eq(feeEntries.id, args.feeEntryId));
  }

  async getFeeEntryByPennylaneInvoiceId(invoiceId: string): Promise<FeeEntry | undefined> {
    const [row] = await db
      .select()
      .from(feeEntries)
      .where(eq(feeEntries.pennylaneInvoiceId, invoiceId));
    return row;
  }

  async listFeeEntriesWithPennylaneInvoice(args?: {
    onlyUnpaid?: boolean;
    limit?: number;
  }): Promise<FeeEntry[]> {
    const clauses: SQL[] = [isNotNull(feeEntries.pennylaneInvoiceId)];
    if (args?.onlyUnpaid) clauses.push(isNull(feeEntries.pennylanePaidAt));
    let q = db.select().from(feeEntries).$dynamic();
    q = q.where(and(...clauses));
    return q.orderBy(asc(feeEntries.id)).limit(args?.limit ?? 500);
  }

  // --- Banking mismatch overrides (Task #225) ---------------------------
  async createBankingMismatchOverride(
    data: InsertBankingMismatchOverride,
  ): Promise<BankingMismatchOverride> {
    const [row] = await db.insert(bankingMismatchOverrides).values(data).returning();
    return row;
  }

  async findBankingMismatchOverride(args: {
    docKind: "devis" | "invoice";
    docId: number;
    docIban: string;
    archidocIban: string;
  }): Promise<BankingMismatchOverride | undefined> {
    const [row] = await db
      .select()
      .from(bankingMismatchOverrides)
      .where(
        and(
          eq(bankingMismatchOverrides.docKind, args.docKind),
          eq(bankingMismatchOverrides.docId, args.docId),
          eq(bankingMismatchOverrides.docIban, args.docIban),
          eq(bankingMismatchOverrides.archidocIban, args.archidocIban),
        ),
      );
    return row;
  }

  async listBankingMismatchOverridesByContractor(
    contractorId: number,
  ): Promise<BankingMismatchOverride[]> {
    return db
      .select()
      .from(bankingMismatchOverrides)
      .where(eq(bankingMismatchOverrides.contractorId, contractorId))
      .orderBy(desc(bankingMismatchOverrides.createdAt));
  }
}

export const storage = new DatabaseStorage();
