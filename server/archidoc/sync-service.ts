import { db, pool } from "../db";
import { eq, desc, inArray, and, or, isNull, ne, notInArray, lt, count, sql } from "drizzle-orm";
import {
  archidocProjects,
  archidocContractors,
  archidocTrades,
  archidocProposalFees,
  archidocSyncLog,
  archidocSiretIssues,
  archidocTechnicalLots,
  archidocTechnicalLotCatalogue,
  planningRevisions,
} from "@shared/schema";
import {
  isArchidocConfigured,
  fetchProjects,
  fetchContractors,
  fetchSuppliers,
  fetchTrades,
  fetchProposalFees,
  fetchTechnicalLots,
  type ArchidocProjectData,
  type ArchidocContractorData,
  type ArchidocSupplierData,
  type ArchidocTradeData,
} from "./sync-client";
import { normalizeSiret } from "../gmail/document-parser";
import { env } from "../env";
import { validateIban, normaliseIban, validateBic, normaliseBic } from "@shared/iban";

// Canonical form of the configured Archidoc backend URL — used to stamp
// every mirror row so a future repointing of ARCHIDOC_BASE_URL can be
// detected by the reconciliation pass and the previous backend's rows
// can be soft-deleted in bulk. Kept narrow (origin only) so trailing
// slashes / query strings can never cause spurious mismatches.
export function getCurrentSourceBaseUrl(): string | null {
  const raw = env.ARCHIDOC_BASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

// Mirror writes must satisfy the same 14-digit SIRET check constraint as the
// canonical contractors table. Strip non-digits and accept only canonical
// 14-digit values; anything else is logged so upstream ArchiDoc data quality
// issues surface instead of silently being persisted as garbage or dropped to
// NULL further down the pipeline.
export function normaliseMirrorSiret(
  raw: string | null | undefined,
  context: { archidocId: string; name?: string | null },
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  const digits = normalizeSiret(trimmed);
  if (digits.length === 14) return digits;
  console.warn(
    `[ArchiDoc Sync] Malformed SIRET on mirror contractor ${context.archidocId}` +
      (context.name ? ` (${context.name})` : "") +
      `: ${JSON.stringify(raw)} -> coerced to NULL (digits=${digits.length})`,
  );
  return null;
}

// A sync run that crashes (process restart, dropped DB connection) between
// createSyncLog and completeSyncLog leaves its row stuck on "running"
// forever, making the UI claim a sync is in flight. Any row still "running"
// past this threshold is dead — the upstream client itself times out at 30s
// per call — so mark it failed before reporting status or starting new runs.
const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;

// --- Mirror-sync serialization -------------------------------------------
//
// Full/incremental syncs can be triggered concurrently (operator Sync
// button, sync.full webhook, schedulers). Two overlapping full syncs each
// reconcile against their own upstream snapshot and can soft-delete rows the
// other just wrote, so the final mirror depends on timing. A session-scoped
// Postgres advisory lock (held on a dedicated pooled connection for the
// duration of the run) serializes syncs across processes/instances; callers
// that cannot acquire it report "already syncing" instead of running.
//
// The same lock also makes stale-run recovery safe: recovery only fires when
// it can acquire the lock, i.e. when NO sync is genuinely live — so a long
// legitimate run can never be falsely marked failed by the age threshold.
const SYNC_LOCK_KEY = "archidoc_mirror_sync";

export async function withMirrorSyncLock<T>(
  fn: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [SYNC_LOCK_KEY],
    );
    if (!res.rows[0]?.locked) return { acquired: false };
    try {
      return { acquired: true, result: await fn() };
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [SYNC_LOCK_KEY])
        .catch((err) => console.error("[ArchiDoc Sync] advisory unlock failed:", err));
    }
  } finally {
    client.release();
  }
}

// Probe whether a mirror sync is currently running by testing the advisory
// lock: if we can acquire it, nobody is syncing (release immediately); if we
// can't, a sync genuinely holds it. Server truth for the UI's "sync in
// progress" badge — unlike the sync-log table, it can't be wedged by a
// crashed run leaving a stale "running" row.
export async function isMirrorSyncInProgress(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [SYNC_LOCK_KEY],
    );
    if (res.rows[0]?.locked) {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [SYNC_LOCK_KEY])
        .catch((err) => console.error("[ArchiDoc Sync] advisory unlock failed:", err));
      return false;
    }
    return true;
  } finally {
    client.release();
  }
}

export async function recoverStaleRunningSyncLogs(): Promise<number> {
  // Only recover when no sync currently holds the lock — a held lock means a
  // genuinely live run, which must never be marked failed regardless of age.
  const outcome = await withMirrorSyncLock(() => recoverStaleRunningSyncLogsUnsafe());
  return outcome.acquired ? outcome.result : 0;
}

async function recoverStaleRunningSyncLogsUnsafe(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS);
  const recovered = await db.update(archidocSyncLog)
    .set({
      status: "failed",
      completedAt: new Date(),
      errorMessage: "Sync did not complete (process interrupted); marked failed by stale-run recovery",
    })
    .where(and(eq(archidocSyncLog.status, "running"), lt(archidocSyncLog.startedAt, cutoff)))
    .returning({ id: archidocSyncLog.id });
  if (recovered.length > 0) {
    console.warn(`[ArchiDoc Sync] Recovered ${recovered.length} stale 'running' sync log row(s)`);
  }
  return recovered.length;
}

async function createSyncLog(syncType: string) {
  const [entry] = await db.insert(archidocSyncLog).values({
    syncType,
    status: "running",
  }).returning();
  return entry;
}

async function completeSyncLog(
  id: number,
  status: string,
  recordsUpdated: number,
  errorMessage?: string,
  malformedSiretCount = 0,
) {
  await db.update(archidocSyncLog)
    .set({
      status,
      completedAt: new Date(),
      recordsUpdated,
      malformedSiretCount,
      errorMessage: errorMessage || null,
    })
    .where(eq(archidocSyncLog.id, id));
}

export interface MirrorSiretIssue {
  archidocId: string;
  name: string | null;
  rawSiret: string;
}

// Persist contractors whose upstream SIRET could not be normalised so operators
// have a place to chase them down in ArchiDoc. Any contractors that arrived
// with a clean SIRET in this batch are removed from the issues table because
// they have just been fixed upstream.
export async function recordSiretIssues(
  issues: MirrorSiretIssue[],
  clearedArchidocIds: string[],
  syncLogId: number | null,
): Promise<void> {
  if (issues.length > 0) {
    const now = new Date();
    for (const issue of issues) {
      await db.insert(archidocSiretIssues)
        .values({
          archidocId: issue.archidocId,
          name: issue.name,
          rawSiret: issue.rawSiret,
          firstSeenAt: now,
          lastSeenAt: now,
          lastSyncLogId: syncLogId,
        })
        .onConflictDoUpdate({
          target: archidocSiretIssues.archidocId,
          set: {
            name: issue.name,
            rawSiret: issue.rawSiret,
            lastSeenAt: now,
            lastSyncLogId: syncLogId,
          },
        });
    }
  }

  if (clearedArchidocIds.length > 0) {
    await db.delete(archidocSiretIssues)
      .where(inArray(archidocSiretIssues.archidocId, clearedArchidocIds));
  }
}

export async function upsertProject(p: ArchidocProjectData) {
  const clientName = p.clients?.[0]?.name || null;
  const upstreamDeleted = p.isDeleted ?? false;
  const values = {
    archidocId: p.id,
    projectName: p.projectName,
    code: p.code || null,
    clientName,
    address: p.siteAddress || null,
    status: p.status || null,
    clients: p.clients || null,
    lotContractors: p.lotContractors || null,
    customLots: p.customLots || null,
    actors: p.actors || null,
    isDeleted: upstreamDeleted,
    // Clear the soft-delete audit timestamp whenever upstream confirms
    // the row is alive again (re-pointed backend, undelete, etc).
    deletedAt: upstreamDeleted ? new Date() : null,
    sourceBaseUrl: getCurrentSourceBaseUrl(),
    archidocUpdatedAt: p.updatedAt ? new Date(p.updatedAt) : null,
    syncedAt: new Date(),
  };

  const existing = await db.select()
    .from(archidocProjects)
    .where(eq(archidocProjects.archidocId, p.id))
    .limit(1);

  if (existing.length > 0) {
    await db.update(archidocProjects)
      .set(values)
      .where(eq(archidocProjects.archidocId, p.id));
  } else {
    await db.insert(archidocProjects).values(values);
  }
}

export async function upsertContractor(
  c: ArchidocContractorData,
): Promise<{ siretIssue: MirrorSiretIssue | null }> {
  const normalisedSiret = normaliseMirrorSiret(c.siret, { archidocId: c.id, name: c.name });
  const rawTrimmed = c.siret == null ? "" : String(c.siret).trim();
  const siretIssue: MirrorSiretIssue | null =
    rawTrimmed !== "" && normalisedSiret === null
      ? { archidocId: c.id, name: c.name ?? null, rawSiret: rawTrimmed }
      : null;
  const values = {
    archidocId: c.id,
    partnerType: c.partnerType ?? "contractor",
    name: c.name,
    siret: normalisedSiret,
    address1: c.address1 || null,
    address2: c.address2 || null,
    town: c.town || null,
    postcode: c.postcode || null,
    officePhone: c.officePhone || null,
    website: c.website || null,
    tradeIds: c.tradeIds || null,
    insuranceStatus: c.insuranceStatus || null,
    decennaleInsurer: c.decennale?.insurer || null,
    decennalePolicyNumber: c.decennale?.policyNumber || null,
    decennaleEndDate: c.decennale?.endDate || null,
    rcProInsurer: c.rcPro?.insurer || null,
    rcProPolicyNumber: c.rcPro?.policyNumber || null,
    rcProEndDate: c.rcPro?.endDate || null,
    specialConditions: c.specialConditions || null,
    contacts: c.contacts || null,
    // Task #225 — Banking mirror. We revalidate IBAN/BIC shape+checksum
    // before persist; a value that fails validation is stored as NULL
    // (the downstream certificat gate will then refuse to issue, which
    // is the safe failure mode).
    accountHolderName: c.banking?.accountHolderName || null,
    iban: c.banking?.iban && validateIban(c.banking.iban).valid
      ? normaliseIban(c.banking.iban)
      : null,
    bic: c.banking?.bic && validateBic(c.banking.bic).valid
      ? normaliseBic(c.banking.bic)
      : null,
    bankName: c.banking?.bankName || null,
    ribDocumentUrl: c.banking?.ribDocumentUrl || null,
    ribDocumentName: c.banking?.ribDocumentName || null,
    // Task #226 — read PREFIXED keys (`bankingVerifiedAt` etc.); the
    // short forms were silently coercing every audit field to NULL.
    bankingVerifiedAt: c.banking?.bankingVerifiedAt ? new Date(c.banking.bankingVerifiedAt) : null,
    bankingVerifiedBy: c.banking?.bankingVerifiedBy || null,
    bankingAiExtractedData: (c.banking?.bankingAiExtractedData ?? null) as object | null,
    // Re-asserting the row in the upstream response always undoes any
    // prior soft-delete (operator may have re-pointed the backend or
    // restored the contractor on Archidoc).
    isDeleted: false,
    deletedAt: null,
    sourceBaseUrl: getCurrentSourceBaseUrl(),
    archidocUpdatedAt: c.updatedAt ? new Date(c.updatedAt) : null,
    syncedAt: new Date(),
  };

  const existing = await db.select()
    .from(archidocContractors)
    .where(eq(archidocContractors.archidocId, c.id))
    .limit(1);

  if (existing.length > 0) {
    await db.update(archidocContractors)
      .set(values)
      .where(eq(archidocContractors.archidocId, c.id));
  } else {
    await db.insert(archidocContractors).values(values);
  }

  return { siretIssue };
}

export function mapSupplierToContractorData(
  supplier: ArchidocSupplierData,
): ArchidocContractorData {
  const contactName = supplier.contactName ?? supplier.contact;
  const email = supplier.email ?? supplier.contactEmail;
  const phone = supplier.phone ?? supplier.contactPhone;
  const hasContact =
    Boolean(contactName?.trim())
    || Boolean(email?.trim())
    || Boolean(phone?.trim());

  return {
    id: supplier.id,
    name: supplier.name,
    partnerType: "supplier",
    officePhone: phone,
    website: supplier.website,
    specialConditions: supplier.description ?? supplier.notes,
    contacts: hasContact
      ? [{
          name: contactName?.trim() || supplier.name,
          email,
          mobile: phone,
          isPrimary: true,
        }]
      : [],
    updatedAt: supplier.updatedAt,
  };
}

export function isEligibleSupplier(supplier: ArchidocSupplierData): boolean {
  // The current authenticated feed contains active supplier partners only and
  // omits this flag. Older ArchiDoc supplier contracts expose isActive, so an
  // explicit false must still be treated as removed from the live mirror.
  return supplier.isActive !== false;
}

export async function upsertTrade(t: ArchidocTradeData) {
  const values = {
    archidocId: t.id,
    label: t.label,
    description: t.description || null,
    category: t.category || null,
    sortOrder: t.sortOrder ?? null,
    syncedAt: new Date(),
  };

  const existing = await db.select()
    .from(archidocTrades)
    .where(eq(archidocTrades.archidocId, t.id))
    .limit(1);

  if (existing.length > 0) {
    await db.update(archidocTrades)
      .set(values)
      .where(eq(archidocTrades.archidocId, t.id));
  } else {
    await db.insert(archidocTrades).values(values);
  }
}

// Watermark for incremental syncs. Only COMPLETED runs advance the
// watermark: a failed (or crashed/stale-recovered) run also has a
// completedAt, and using it would silently skip every upstream change made
// between the failure and the next run.
function getLastSyncTime(syncType: string): Promise<Date | null> {
  return db.select({ completedAt: archidocSyncLog.completedAt })
    .from(archidocSyncLog)
    .where(and(eq(archidocSyncLog.syncType, syncType), eq(archidocSyncLog.status, "completed")))
    .orderBy(desc(archidocSyncLog.id))
    .limit(1)
    .then(rows => rows[0]?.completedAt ?? null);
}

// Reconciliation pass — only safe to run on full syncs (where the
// upstream response is the complete authoritative set). Soft-deletes
// any mirror row whose archidoc_id is not in `seenIds`, AND any row
// stamped with a different `source_base_url` than the one currently
// configured (so a backend swap auto-clears the previous backend's
// rows in the same run). NULL `source_base_url` is treated as "from
// a previous backend" since legacy rows pre-date the column. Soft-
// delete only — never DROP — because architrak.projects /
// architrak.contractors hold archidoc_id references and operators
// need the audit trail.
export interface ReconciliationResult {
  softDeletedDifferentSource: number;
  softDeletedMissingFromResponse: number;
  // Set when the mirror-wipe guardrail refused the missing-from-response
  // soft-delete pass because it would have removed all (or nearly all)
  // active mirror rows — almost always an empty/truncated upstream
  // response, not a genuine mass deletion.
  wipeGuardWarning?: string;
}

// Guardrail: a full-sync response that is empty or drastically truncated
// (upstream bug, wrong backend, auth half-failure returning []) must not
// soft-delete the whole mirror. Refuse the missing-from-response pass when
// it would remove every active row, or ≥90% of a mirror that has at least
// MIN_ROWS_FOR_RATIO_GUARD rows.
const MIN_ROWS_FOR_RATIO_GUARD = 5;
const WIPE_GUARD_RATIO = 0.9;

export function wipeGuardVerdict(
  entity: string,
  activeCount: number,
  wouldDelete: number,
  seenCount: number,
): string | null {
  if (activeCount === 0 || wouldDelete === 0) return null;
  const wipesAll = wouldDelete >= activeCount;
  const wipesMost = activeCount >= MIN_ROWS_FOR_RATIO_GUARD && wouldDelete / activeCount >= WIPE_GUARD_RATIO;
  if (!wipesAll && !wipesMost) return null;
  return (
    `Refused to soft-delete ${wouldDelete} of ${activeCount} active mirrored ${entity} ` +
    `(upstream response contained ${seenCount}); this looks like an empty/truncated upstream response, not a mass deletion. ` +
    `No rows were removed.`
  );
}

// Boot-time reconciliation — soft-deletes mirror rows whose
// `source_base_url` does not match the currently-configured backend
// (or is NULL because they predate the column). MUST be called from
// the server boot path BEFORE schedulers/webhooks open so a backend
// swap performed via deployment-secret change cannot leave a stale
// mirror visible until the next full sync runs (~1h cadence).
//
// Unlike the full-sync reconciliation pass, this function never
// considers "missing from response" — there is no response at boot.
// It is therefore safe to invoke even when the upstream API is down.
//
// No-op when ARCHIDOC_BASE_URL is unset (we have no current source
// to compare against — preserve every mirror row to avoid wiping the
// table on accidental config-loss).
export async function clearPreviousBackendMirrorRows(): Promise<{
  projects: number;
  contractors: number;
  technicalLots: number;
}> {
  const currentSource = getCurrentSourceBaseUrl();
  if (!currentSource) {
    return { projects: 0, contractors: 0, technicalLots: 0 };
  }
  const outcome = await withMirrorSyncLock(
    () => clearPreviousBackendMirrorRowsUnsafe(currentSource),
  );
  if (!outcome.acquired) {
    console.log(
      "[ArchiDoc Sync] Boot reconciliation skipped — another mirror sync holds the shared lock",
    );
    return { projects: 0, contractors: 0, technicalLots: 0 };
  }
  return outcome.result;
}

export async function ensurePreviousBackendMirrorRowsReconciled(): Promise<void> {
  const currentSource = getCurrentSourceBaseUrl();
  if (!currentSource) return;
  const outcome = await withMirrorSyncLock(
    () => clearPreviousBackendMirrorRowsUnsafe(currentSource),
  );
  if (outcome.acquired) return;

  console.log(
    "[ArchiDoc Sync] Boot reconciliation deferred — retrying after the active mirror sync",
  );
  const timer = setTimeout(() => {
    void ensurePreviousBackendMirrorRowsReconciled().catch((err) => {
      console.error("[ArchiDoc Sync] Deferred boot reconciliation failed:", err);
    });
  }, 1_000);
  timer.unref();
}

export async function reconcilePreviousBackendMirrorRowsWithinHeldLock(): Promise<{
  projects: number;
  contractors: number;
  technicalLots: number;
}> {
  const currentSource = getCurrentSourceBaseUrl();
  if (!currentSource) {
    return { projects: 0, contractors: 0, technicalLots: 0 };
  }
  return clearPreviousBackendMirrorRowsUnsafe(currentSource);
}

async function clearPreviousBackendMirrorRowsUnsafe(currentSource: string): Promise<{
  projects: number;
  contractors: number;
  technicalLots: number;
}> {
  const now = new Date();

  const projectOrphans = await db
    .update(archidocProjects)
    .set({ isDeleted: true, deletedAt: now })
    .where(
      and(
        eq(archidocProjects.isDeleted, false),
        or(
          isNull(archidocProjects.sourceBaseUrl),
          ne(archidocProjects.sourceBaseUrl, currentSource),
        ),
      ),
    )
    .returning({ archidocId: archidocProjects.archidocId });

  const contractorOrphans = await db
    .update(archidocContractors)
    .set({ isDeleted: true, deletedAt: now })
    .where(
      and(
        eq(archidocContractors.isDeleted, false),
        or(
          isNull(archidocContractors.sourceBaseUrl),
          ne(archidocContractors.sourceBaseUrl, currentSource),
        ),
      ),
    )
    .returning({ archidocId: archidocContractors.archidocId });

  // Technical lots: soft-delete rows from a previous backend source.
  // These rows have no isDeleted flag — we clear them by updating
  // sourceBaseUrl to a sentinel so they are excluded from the active mirror.
  // We use the existing isActive field as the soft-delete marker: set to false
  // and stamp deletedAt. Since the table has a deletedAt column we use that.
  let technicalLotOrphans = 0;
  try {
    const orphans = await db
      .update(archidocTechnicalLots)
      .set({ isActive: false, deletedAt: now, syncedAt: now })
      .where(
        and(
          eq(archidocTechnicalLots.isActive, true),
          or(
            isNull(archidocTechnicalLots.sourceBaseUrl),
            ne(archidocTechnicalLots.sourceBaseUrl, currentSource),
          ),
        ),
      )
      .returning({ archidocId: archidocTechnicalLots.archidocId });
    technicalLotOrphans = orphans.length;
  } catch {
    // Table may not exist yet (migrations pending) — no-op
  }

  if (projectOrphans.length > 0 || contractorOrphans.length > 0 || technicalLotOrphans > 0) {
    console.log(
      `[ArchiDoc Sync] Boot reconciliation cleared previous-backend mirror rows: ${projectOrphans.length} projects, ${contractorOrphans.length} contractors, ${technicalLotOrphans} technical lots (current source: ${currentSource})`,
    );
  }

  return { projects: projectOrphans.length, contractors: contractorOrphans.length, technicalLots: technicalLotOrphans };
}

export async function reconcileProjectMirror(
  seenIds: string[],
  currentSource: string | null,
): Promise<ReconciliationResult> {
  const now = new Date();
  let softDeletedDifferentSource = 0;
  let softDeletedMissingFromResponse = 0;

  if (currentSource) {
    const orphans = await db
      .update(archidocProjects)
      .set({ isDeleted: true, deletedAt: now })
      .where(
        and(
          eq(archidocProjects.isDeleted, false),
          or(
            isNull(archidocProjects.sourceBaseUrl),
            ne(archidocProjects.sourceBaseUrl, currentSource),
          ),
        ),
      )
      .returning({ archidocId: archidocProjects.archidocId });
    softDeletedDifferentSource = orphans.length;

    const missingPredicate = seenIds.length > 0
      ? and(
          eq(archidocProjects.isDeleted, false),
          eq(archidocProjects.sourceBaseUrl, currentSource),
          notInArray(archidocProjects.archidocId, seenIds),
        )
      : and(
          eq(archidocProjects.isDeleted, false),
          eq(archidocProjects.sourceBaseUrl, currentSource),
        );

    const [{ value: activeCount }] = await db
      .select({ value: count() })
      .from(archidocProjects)
      .where(and(eq(archidocProjects.isDeleted, false), eq(archidocProjects.sourceBaseUrl, currentSource)));
    const [{ value: wouldDelete }] = await db
      .select({ value: count() })
      .from(archidocProjects)
      .where(missingPredicate);

    const warning = wipeGuardVerdict("projects", activeCount, wouldDelete, seenIds.length);
    if (warning) {
      console.error(`[ArchiDoc Sync] WIPE GUARD: ${warning}`);
      return { softDeletedDifferentSource, softDeletedMissingFromResponse, wipeGuardWarning: warning };
    }

    const missing = await db
      .update(archidocProjects)
      .set({ isDeleted: true, deletedAt: now })
      .where(missingPredicate)
      .returning({ archidocId: archidocProjects.archidocId });
    softDeletedMissingFromResponse = missing.length;
  }

  return { softDeletedDifferentSource, softDeletedMissingFromResponse };
}

export async function reconcileContractorMirror(
  seenIds: string[],
  currentSource: string | null,
): Promise<ReconciliationResult> {
  const now = new Date();
  let softDeletedDifferentSource = 0;
  let softDeletedMissingFromResponse = 0;

  if (currentSource) {
    const orphans = await db
      .update(archidocContractors)
      .set({ isDeleted: true, deletedAt: now })
      .where(
        and(
          eq(archidocContractors.isDeleted, false),
          or(
            isNull(archidocContractors.sourceBaseUrl),
            ne(archidocContractors.sourceBaseUrl, currentSource),
          ),
        ),
      )
      .returning({ archidocId: archidocContractors.archidocId });
    softDeletedDifferentSource = orphans.length;

    const missingPredicate = seenIds.length > 0
      ? and(
          eq(archidocContractors.isDeleted, false),
          eq(archidocContractors.sourceBaseUrl, currentSource),
          notInArray(archidocContractors.archidocId, seenIds),
        )
      : and(
          eq(archidocContractors.isDeleted, false),
          eq(archidocContractors.sourceBaseUrl, currentSource),
        );

    const [{ value: activeCount }] = await db
      .select({ value: count() })
      .from(archidocContractors)
      .where(and(eq(archidocContractors.isDeleted, false), eq(archidocContractors.sourceBaseUrl, currentSource)));
    const [{ value: wouldDelete }] = await db
      .select({ value: count() })
      .from(archidocContractors)
      .where(missingPredicate);

    const warning = wipeGuardVerdict("contractors", activeCount, wouldDelete, seenIds.length);
    if (warning) {
      console.error(`[ArchiDoc Sync] WIPE GUARD: ${warning}`);
      return { softDeletedDifferentSource, softDeletedMissingFromResponse, wipeGuardWarning: warning };
    }

    const missing = await db
      .update(archidocContractors)
      .set({ isDeleted: true, deletedAt: now })
      .where(missingPredicate)
      .returning({ archidocId: archidocContractors.archidocId });
    softDeletedMissingFromResponse = missing.length;
  }

  return { softDeletedDifferentSource, softDeletedMissingFromResponse };
}

export async function syncProjects(incremental = true): Promise<{ updated: number; error?: string; warning?: string }> {
  if (!isArchidocConfigured()) {
    console.log("[ArchiDoc Sync] Not configured, skipping project sync");
    return { updated: 0, error: "Not configured" };
  }

  const log = await createSyncLog("projects");
  try {
    let since: string | undefined;
    if (incremental) {
      const last = await getLastSyncTime("projects");
      if (last) since = last.toISOString();
    }

    const response = await fetchProjects(since);
    let count = 0;
    const seenIds: string[] = [];
    for (const project of response.projects) {
      await upsertProject(project);
      seenIds.push(project.id);
      count++;
    }

    let warning: string | undefined;
    if (!incremental) {
      const reconciled = await reconcileProjectMirror(seenIds, getCurrentSourceBaseUrl());
      if (reconciled.softDeletedDifferentSource > 0 || reconciled.softDeletedMissingFromResponse > 0) {
        console.log(
          `[ArchiDoc Sync] Project mirror reconciled: ${reconciled.softDeletedDifferentSource} cleared from previous backend, ${reconciled.softDeletedMissingFromResponse} missing from response soft-deleted`,
        );
      }
      warning = reconciled.wipeGuardWarning;
    }

    await completeSyncLog(log.id, "completed", count, warning ? `WARNING: ${warning}` : undefined);
    console.log(`[ArchiDoc Sync] Projects synced: ${count} records`);
    return { updated: count, warning };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(log.id, "failed", 0, message);
    console.error(`[ArchiDoc Sync] Project sync failed: ${message}`);
    return { updated: 0, error: message };
  }
}

export async function syncContractors(incremental = true): Promise<{ updated: number; error?: string; warning?: string }> {
  if (!isArchidocConfigured()) {
    console.log("[ArchiDoc Sync] Not configured, skipping contractor sync");
    return { updated: 0, error: "Not configured" };
  }

  const log = await createSyncLog("contractors");
  try {
    let since: string | undefined;
    if (incremental) {
      const last = await getLastSyncTime("contractors");
      if (last) since = last.toISOString();
    }

    const [response, suppliers] = await Promise.all([
      fetchContractors(since),
      // ArchiDoc classifies supplier partners structurally by exposing them
      // from a dedicated authenticated feed. The feed is intentionally read
      // in full even during incremental syncs because it has no `since`
      // contract and is currently small.
      fetchSuppliers(),
    ]);
    const partnersById = new Map<string, ArchidocContractorData>();
    for (const contractor of response.contractors) {
      partnersById.set(contractor.id, { ...contractor, partnerType: "contractor" });
    }
    for (const supplier of suppliers.filter(isEligibleSupplier)) {
      const mapped = mapSupplierToContractorData(supplier);
      const existing = partnersById.get(supplier.id);
      // If ArchiDoc ever exposes the same stable partner through both feeds,
      // keep the richer contractor fields but preserve the authoritative
      // supplier classification.
      partnersById.set(
        supplier.id,
        existing ? { ...mapped, ...existing, partnerType: "supplier" } : mapped,
      );
    }

    let count = 0;
    const issues: MirrorSiretIssue[] = [];
    const cleared: string[] = [];
    const seenIds: string[] = [];
    for (const contractor of Array.from(partnersById.values())) {
      const { siretIssue } = await upsertContractor(contractor);
      if (siretIssue) {
        issues.push(siretIssue);
      } else {
        cleared.push(contractor.id);
      }
      seenIds.push(contractor.id);
      count++;
    }

    let warning: string | undefined;
    if (!incremental) {
      const reconciled = await reconcileContractorMirror(seenIds, getCurrentSourceBaseUrl());
      if (reconciled.softDeletedDifferentSource > 0 || reconciled.softDeletedMissingFromResponse > 0) {
        console.log(
          `[ArchiDoc Sync] Contractor mirror reconciled: ${reconciled.softDeletedDifferentSource} cleared from previous backend, ${reconciled.softDeletedMissingFromResponse} missing from response soft-deleted`,
        );
      }
      warning = reconciled.wipeGuardWarning;
    }

    await recordSiretIssues(issues, cleared, log.id);
    await completeSyncLog(log.id, "completed", count, warning ? `WARNING: ${warning}` : undefined, issues.length);
    if (issues.length > 0) {
      console.log(
        `[ArchiDoc Sync] Contractors synced: ${count} records (${issues.length} with malformed SIRETs)`,
      );
    } else {
      console.log(`[ArchiDoc Sync] Contractors synced: ${count} records`);
    }
    return { updated: count, warning };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(log.id, "failed", 0, message);
    console.error(`[ArchiDoc Sync] Contractor sync failed: ${message}`);
    return { updated: 0, error: message };
  }
}

export async function syncTrades(): Promise<{ updated: number; error?: string }> {
  if (!isArchidocConfigured()) {
    console.log("[ArchiDoc Sync] Not configured, skipping trades sync");
    return { updated: 0, error: "Not configured" };
  }

  const log = await createSyncLog("trades");
  try {
    const response = await fetchTrades();
    let count = 0;
    for (const trade of response.trades) {
      await upsertTrade(trade);
      count++;
    }

    await completeSyncLog(log.id, "completed", count);
    console.log(`[ArchiDoc Sync] Trades synced: ${count} records`);
    return { updated: count };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(log.id, "failed", 0, message);
    console.error(`[ArchiDoc Sync] Trades sync failed: ${message}`);
    return { updated: 0, error: message };
  }
}

export async function upsertProposalFee(fee: { projectId: string; proServiceHt?: number; proServiceTva?: number; proServiceTtc?: number; planningHt?: number; planningTva?: number; planningTtc?: number; pmPercentage?: number; pmNote?: string }) {
  const values = {
    archidocProjectId: fee.projectId,
    proServiceHt: fee.proServiceHt?.toString() || null,
    proServiceTva: fee.proServiceTva?.toString() || null,
    proServiceTtc: fee.proServiceTtc?.toString() || null,
    planningHt: fee.planningHt?.toString() || null,
    planningTva: fee.planningTva?.toString() || null,
    planningTtc: fee.planningTtc?.toString() || null,
    pmPercentage: fee.pmPercentage?.toString() || null,
    pmNote: fee.pmNote || null,
    syncedAt: new Date(),
  };

  const existing = await db.select()
    .from(archidocProposalFees)
    .where(eq(archidocProposalFees.archidocProjectId, fee.projectId))
    .limit(1);

  if (existing.length > 0) {
    await db.update(archidocProposalFees)
      .set(values)
      .where(eq(archidocProposalFees.archidocProjectId, fee.projectId));
  } else {
    await db.insert(archidocProposalFees).values(values);
  }
}

export async function syncAllProposalFees(): Promise<{ updated: number; error?: string }> {
  if (!isArchidocConfigured()) {
    return { updated: 0, error: "Not configured" };
  }

  try {
    const response = await fetchProposalFees();
    let count = 0;
    for (const fee of response.proposalFees) {
      const values = {
        archidocProjectId: fee.projectId,
        proServiceHt: fee.proServiceHt?.toString() || null,
        proServiceTva: fee.proServiceTva?.toString() || null,
        proServiceTtc: fee.proServiceTtc?.toString() || null,
        planningHt: fee.planningHt?.toString() || null,
        planningTva: fee.planningTva?.toString() || null,
        planningTtc: fee.planningTtc?.toString() || null,
        pmPercentage: fee.pmPercentage?.toString() || null,
        pmNote: fee.pmNote || null,
        syncedAt: new Date(),
      };

      const existing = await db.select()
        .from(archidocProposalFees)
        .where(eq(archidocProposalFees.archidocProjectId, fee.projectId))
        .limit(1);

      if (existing.length > 0) {
        await db.update(archidocProposalFees)
          .set(values)
          .where(eq(archidocProposalFees.archidocProjectId, fee.projectId));
      } else {
        await db.insert(archidocProposalFees).values(values);
      }
      count++;
    }

    console.log(`[ArchiDoc Sync] Proposal fees synced: ${count} records`);
    return { updated: count };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ArchiDoc Sync] Proposal fees sync failed: ${message}`);
    return { updated: 0, error: message };
  }
}

type MirrorSyncTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function backfillMutablePlanningTechnicalLots(
  tx: MirrorSyncTx,
  sourceBaseUrl: string | null,
): Promise<number> {
  const backfilled = await tx.execute(sql`
    UPDATE planning_revisions AS pr
       SET archidoc_technical_lot_id = atl.archidoc_id,
           updated_at = CURRENT_TIMESTAMP
      FROM lots AS project_lot,
           archidoc_technical_lots AS atl
     WHERE pr.lot_id = project_lot.id
       AND pr.archidoc_technical_lot_id IS NULL
       AND pr.status IN ('draft', 'reviewed')
       AND atl.code = project_lot.lot_number
       AND atl.is_active = true
       AND atl.deleted_at IS NULL
       AND atl.source_base_url IS NOT DISTINCT FROM ${sourceBaseUrl}
    RETURNING pr.id
  `);
  return backfilled.rows.length;
}

// --- Technical-lot catalogue sync ----------------------------------------
//
// The endpoint returns ALL rows including tombstones, so we enforce that any
// previously-mirrored ID from the same source must appear in the response
// (unless the mirror is empty — first catalogue). Absence of a known ID is
// treated as a protocol violation (truncated / wrong endpoint), not a
// deletion signal. The service layer must never infer deletion from absence.

export async function syncTechnicalLots(): Promise<{ updated: number; error?: string; warning?: string }> {
  if (!isArchidocConfigured()) {
    console.log("[ArchiDoc Sync] Not configured, skipping technical-lots sync");
    return { updated: 0, error: "Not configured" };
  }

  const log = await createSyncLog("technical_lots");
  try {
    const sourceBaseUrl = getCurrentSourceBaseUrl();
    const response = await fetchTechnicalLots();

    // Omission guard: if the mirror is non-empty, every previously-mirrored
    // ID from this source must be present in the response (the endpoint always
    // returns all tombstones too). A missing ID means the response is
    // truncated or wrong — preserve LKG and reject.
    if (sourceBaseUrl) {
      const mirroredRows = await db
        .select({ archidocId: archidocTechnicalLots.archidocId })
        .from(archidocTechnicalLots)
        .where(eq(archidocTechnicalLots.sourceBaseUrl, sourceBaseUrl));

      if (mirroredRows.length > 0) {
        const responseIds = new Set(response.lots.map((l) => l.id));
        const missing = mirroredRows
          .map((r) => r.archidocId)
          .filter((id) => !responseIds.has(id));
        if (missing.length > 0) {
          const msg =
            `Technical-lots response omitted ${missing.length} previously-mirrored ID(s) ` +
            `(e.g. ${missing.slice(0, 3).join(", ")}). ` +
            `Endpoint must return all rows including tombstones; rejecting to preserve LKG.`;
          console.error(`[ArchiDoc Sync] ${msg}`);
          await completeSyncLog(log.id, "failed", 0, msg);
          return { updated: 0, error: msg };
        }
      }
    }

    // Atomic upsert of all rows + catalogue singleton in a single transaction.
    const now = new Date();
    let backfilledRevisionCount = 0;
    await db.transaction(async (tx) => {
      const responseIds = response.lots.map((lot) => lot.id);
      if (sourceBaseUrl && responseIds.length > 0) {
        const sourceCollisions = await tx
          .select({ archidocId: archidocTechnicalLots.archidocId })
          .from(archidocTechnicalLots)
          .where(
            and(
              inArray(archidocTechnicalLots.archidocId, responseIds),
              or(
                isNull(archidocTechnicalLots.sourceBaseUrl),
                ne(archidocTechnicalLots.sourceBaseUrl, sourceBaseUrl),
              ),
            ),
          )
          .for("update");
        if (sourceCollisions.length > 0) {
          const collisionIds = sourceCollisions.map((row) => row.archidocId);
          const referenced = await tx
            .select({
              revisionId: planningRevisions.id,
              archidocTechnicalLotId: planningRevisions.archidocTechnicalLotId,
            })
            .from(planningRevisions)
            .where(inArray(planningRevisions.archidocTechnicalLotId, collisionIds))
            .limit(10);
          if (referenced.length > 0) {
            throw new Error(
              `Technical-lot source switch would reuse ${referenced.length} Planning-referenced ID(s) ` +
              `(e.g. ${referenced.map((row) => row.archidocTechnicalLotId).slice(0, 3).join(", ")}); ` +
              "rejecting the whole catalogue to preserve historical identity.",
            );
          }
        }
      }

      for (const lot of response.lots) {
        await tx
          .insert(archidocTechnicalLots)
          .values({
            archidocId: lot.id,
            code: lot.code,
            labelFr: lot.labelFr,
            displayOrder: lot.displayOrder,
            isActive: lot.isActive,
            deletedAt: lot.deletedAt ? new Date(lot.deletedAt) : null,
            archidocCreatedAt: new Date(lot.createdAt),
            archidocUpdatedAt: new Date(lot.updatedAt),
            sourceBaseUrl,
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: archidocTechnicalLots.archidocId,
            set: {
              code: lot.code,
              labelFr: lot.labelFr,
              displayOrder: lot.displayOrder,
              isActive: lot.isActive,
              deletedAt: lot.deletedAt ? new Date(lot.deletedAt) : null,
              archidocCreatedAt: new Date(lot.createdAt),
              archidocUpdatedAt: new Date(lot.updatedAt),
              sourceBaseUrl,
              syncedAt: now,
            },
          });
      }

      // Upsert the singleton catalogue metadata row (singletonKey = 1, enforced by DB check).
      await tx
        .insert(archidocTechnicalLotCatalogue)
        .values({
          singletonKey: 1,
          revision: response.catalogue.revision,
          changedAt: new Date(response.catalogue.changedAt),
          sourceBaseUrl,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: archidocTechnicalLotCatalogue.singletonKey,
          set: {
            revision: response.catalogue.revision,
            changedAt: new Date(response.catalogue.changedAt),
            sourceBaseUrl,
            syncedAt: now,
          },
        });

      // Migrate only mutable Planning history. Existing project-lot IDs remain
      // intact for audit/promotion compatibility; the dedicated ArchiDoc
      // reference is attached only when the codes match exactly and the
      // upstream lot is currently selectable. Approved/superseded snapshots
      // are deliberately never changed.
      backfilledRevisionCount = await backfillMutablePlanningTechnicalLots(tx, sourceBaseUrl);
    });

    await completeSyncLog(log.id, "completed", response.lots.length);
    console.log(
      `[ArchiDoc Sync] Technical lots synced: ${response.lots.length} records; ` +
      `${backfilledRevisionCount} mutable Planning revision(s) exact-code backfilled`,
    );
    return { updated: response.lots.length };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(log.id, "failed", 0, message);
    console.error(`[ArchiDoc Sync] Technical lots sync failed: ${message}`);
    return { updated: 0, error: message };
  }
}

export interface MirrorSyncResult {
  projects: { updated: number; error?: string; warning?: string };
  contractors: { updated: number; error?: string; warning?: string };
  trades: { updated: number; error?: string };
  proposalFees: { updated: number; error?: string };
  technicalLots: { updated: number; error?: string; warning?: string };
  // True when another sync already held the mirror-sync lock; nothing ran.
  alreadyRunning?: boolean;
}

const ALREADY_RUNNING_RESULT: MirrorSyncResult = {
  projects: { updated: 0 },
  contractors: { updated: 0 },
  trades: { updated: 0 },
  proposalFees: { updated: 0 },
  technicalLots: { updated: 0 },
  alreadyRunning: true,
};

export async function fullSync(): Promise<MirrorSyncResult> {
  const outcome = await withMirrorSyncLock(async () => {
    console.log("[ArchiDoc Sync] Starting full sync...");
    await recoverStaleRunningSyncLogsUnsafe();
    await reconcilePreviousBackendMirrorRowsWithinHeldLock();

    const [projectsResult, contractorsResult, tradesResult, feesResult, technicalLotsResult] = await Promise.all([
      syncProjects(false),
      syncContractors(false),
      syncTrades(),
      syncAllProposalFees(),
      syncTechnicalLots(),
    ]);

    console.log("[ArchiDoc Sync] Full sync complete", {
      projects: projectsResult.updated,
      contractors: contractorsResult.updated,
      trades: tradesResult.updated,
      proposalFees: feesResult.updated,
      technicalLots: technicalLotsResult.updated,
    });

    return {
      projects: projectsResult,
      contractors: contractorsResult,
      trades: tradesResult,
      proposalFees: feesResult,
      technicalLots: technicalLotsResult,
    };
  });

  if (!outcome.acquired) {
    console.log("[ArchiDoc Sync] Full sync skipped — another sync is already running");
    return ALREADY_RUNNING_RESULT;
  }
  return outcome.result;
}

export async function incrementalSync(): Promise<MirrorSyncResult> {
  const outcome = await withMirrorSyncLock(async () => {
    console.log("[ArchiDoc Sync] Starting incremental sync...");
    await recoverStaleRunningSyncLogsUnsafe();
    await reconcilePreviousBackendMirrorRowsWithinHeldLock();

    const [projectsResult, contractorsResult, tradesResult, feesResult, technicalLotsResult] = await Promise.all([
      syncProjects(true),
      syncContractors(true),
      syncTrades(),
      syncAllProposalFees(),
      syncTechnicalLots(),
    ]);

    return {
      projects: projectsResult,
      contractors: contractorsResult,
      trades: tradesResult,
      proposalFees: feesResult,
      technicalLots: technicalLotsResult,
    };
  });

  if (!outcome.acquired) {
    console.log("[ArchiDoc Sync] Incremental sync skipped — another sync is already running");
    return ALREADY_RUNNING_RESULT;
  }
  return outcome.result;
}

export async function getLastSyncStatus(): Promise<{
  configured: boolean;
  lastSync: Date | null;
  lastSyncType: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  technicalLots: {
    lastSync: Date | null;
    lastSyncStatus: string | null;
    lastSyncError: string | null;
    count: number | null;
  };
}> {
  const configured = isArchidocConfigured();

  // Repair any run that crashed mid-sync before reporting, so the UI never
  // claims a sync is still in flight when the process died.
  await recoverStaleRunningSyncLogs();

  const lastLog = await db.select()
    .from(archidocSyncLog)
    .orderBy(desc(archidocSyncLog.id))
    .limit(1);

  // Latest technical_lots sync log entry.
  const lastTechLog = await db.select()
    .from(archidocSyncLog)
    .where(eq(archidocSyncLog.syncType, "technical_lots"))
    .orderBy(desc(archidocSyncLog.id))
    .limit(1);

  // Current mirrored count (all rows regardless of active/deleted).
  let technicalLotsCount: number | null = null;
  try {
    const [{ value: cnt }] = await db
      .select({ value: count() })
      .from(archidocTechnicalLots);
    technicalLotsCount = cnt;
  } catch {
    // table may not exist yet (migrations pending) — silently return null
  }

  const techEntry = lastTechLog[0];
  const technicalLots = {
    lastSync: techEntry ? (techEntry.completedAt || techEntry.startedAt) : null,
    lastSyncStatus: techEntry?.status ?? null,
    lastSyncError: techEntry?.errorMessage ?? null,
    count: technicalLotsCount,
  };

  if (lastLog.length === 0) {
    return { configured, lastSync: null, lastSyncType: null, lastSyncStatus: null, lastSyncError: null, technicalLots };
  }

  const entry = lastLog[0];
  return {
    configured,
    lastSync: entry.completedAt || entry.startedAt,
    lastSyncType: entry.syncType,
    lastSyncStatus: entry.status,
    lastSyncError: entry.errorMessage ?? null,
    technicalLots,
  };
}
