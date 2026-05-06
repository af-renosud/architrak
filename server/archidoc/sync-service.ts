import { db } from "../db";
import { eq, desc, inArray, and, or, isNull, ne, notInArray } from "drizzle-orm";
import {
  archidocProjects,
  archidocContractors,
  archidocTrades,
  archidocProposalFees,
  archidocSyncLog,
  archidocSiretIssues,
} from "@shared/schema";
import {
  isArchidocConfigured,
  fetchProjects,
  fetchContractors,
  fetchTrades,
  fetchProposalFees,
  type ArchidocProjectData,
  type ArchidocContractorData,
  type ArchidocTradeData,
} from "./sync-client";
import { normalizeSiret } from "../gmail/document-parser";
import { env } from "../env";

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

function getLastSyncTime(syncType: string): Promise<Date | null> {
  return db.select({ completedAt: archidocSyncLog.completedAt })
    .from(archidocSyncLog)
    .where(eq(archidocSyncLog.syncType, syncType))
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
}> {
  const currentSource = getCurrentSourceBaseUrl();
  if (!currentSource) {
    return { projects: 0, contractors: 0 };
  }
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

  if (projectOrphans.length > 0 || contractorOrphans.length > 0) {
    console.log(
      `[ArchiDoc Sync] Boot reconciliation cleared previous-backend mirror rows: ${projectOrphans.length} projects, ${contractorOrphans.length} contractors (current source: ${currentSource})`,
    );
  }

  return { projects: projectOrphans.length, contractors: contractorOrphans.length };
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

    const missing = await db
      .update(archidocContractors)
      .set({ isDeleted: true, deletedAt: now })
      .where(missingPredicate)
      .returning({ archidocId: archidocContractors.archidocId });
    softDeletedMissingFromResponse = missing.length;
  }

  return { softDeletedDifferentSource, softDeletedMissingFromResponse };
}

export async function syncProjects(incremental = true): Promise<{ updated: number; error?: string }> {
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

    if (!incremental) {
      const reconciled = await reconcileProjectMirror(seenIds, getCurrentSourceBaseUrl());
      if (reconciled.softDeletedDifferentSource > 0 || reconciled.softDeletedMissingFromResponse > 0) {
        console.log(
          `[ArchiDoc Sync] Project mirror reconciled: ${reconciled.softDeletedDifferentSource} cleared from previous backend, ${reconciled.softDeletedMissingFromResponse} missing from response soft-deleted`,
        );
      }
    }

    await completeSyncLog(log.id, "completed", count);
    console.log(`[ArchiDoc Sync] Projects synced: ${count} records`);
    return { updated: count };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(log.id, "failed", 0, message);
    console.error(`[ArchiDoc Sync] Project sync failed: ${message}`);
    return { updated: 0, error: message };
  }
}

export async function syncContractors(incremental = true): Promise<{ updated: number; error?: string }> {
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

    const response = await fetchContractors(since);
    let count = 0;
    const issues: MirrorSiretIssue[] = [];
    const cleared: string[] = [];
    const seenIds: string[] = [];
    for (const contractor of response.contractors) {
      const { siretIssue } = await upsertContractor(contractor);
      if (siretIssue) {
        issues.push(siretIssue);
      } else {
        cleared.push(contractor.id);
      }
      seenIds.push(contractor.id);
      count++;
    }

    if (!incremental) {
      const reconciled = await reconcileContractorMirror(seenIds, getCurrentSourceBaseUrl());
      if (reconciled.softDeletedDifferentSource > 0 || reconciled.softDeletedMissingFromResponse > 0) {
        console.log(
          `[ArchiDoc Sync] Contractor mirror reconciled: ${reconciled.softDeletedDifferentSource} cleared from previous backend, ${reconciled.softDeletedMissingFromResponse} missing from response soft-deleted`,
        );
      }
    }

    await recordSiretIssues(issues, cleared, log.id);
    await completeSyncLog(log.id, "completed", count, undefined, issues.length);
    if (issues.length > 0) {
      console.log(
        `[ArchiDoc Sync] Contractors synced: ${count} records (${issues.length} with malformed SIRETs)`,
      );
    } else {
      console.log(`[ArchiDoc Sync] Contractors synced: ${count} records`);
    }
    return { updated: count };
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

export async function fullSync(): Promise<{
  projects: { updated: number; error?: string };
  contractors: { updated: number; error?: string };
  trades: { updated: number; error?: string };
  proposalFees: { updated: number; error?: string };
}> {
  console.log("[ArchiDoc Sync] Starting full sync...");

  const [projectsResult, contractorsResult, tradesResult, feesResult] = await Promise.all([
    syncProjects(false),
    syncContractors(false),
    syncTrades(),
    syncAllProposalFees(),
  ]);

  console.log("[ArchiDoc Sync] Full sync complete", {
    projects: projectsResult.updated,
    contractors: contractorsResult.updated,
    trades: tradesResult.updated,
    proposalFees: feesResult.updated,
  });

  return {
    projects: projectsResult,
    contractors: contractorsResult,
    trades: tradesResult,
    proposalFees: feesResult,
  };
}

export async function incrementalSync(): Promise<{
  projects: { updated: number; error?: string };
  contractors: { updated: number; error?: string };
  trades: { updated: number; error?: string };
  proposalFees: { updated: number; error?: string };
}> {
  console.log("[ArchiDoc Sync] Starting incremental sync...");

  const [projectsResult, contractorsResult, tradesResult, feesResult] = await Promise.all([
    syncProjects(true),
    syncContractors(true),
    syncTrades(),
    syncAllProposalFees(),
  ]);

  return {
    projects: projectsResult,
    contractors: contractorsResult,
    trades: tradesResult,
    proposalFees: feesResult,
  };
}

export async function getLastSyncStatus(): Promise<{
  configured: boolean;
  lastSync: Date | null;
  lastSyncType: string | null;
  lastSyncStatus: string | null;
}> {
  const configured = isArchidocConfigured();

  const lastLog = await db.select()
    .from(archidocSyncLog)
    .orderBy(desc(archidocSyncLog.id))
    .limit(1);

  if (lastLog.length === 0) {
    return { configured, lastSync: null, lastSyncType: null, lastSyncStatus: null };
  }

  const entry = lastLog[0];
  return {
    configured,
    lastSync: entry.completedAt || entry.startedAt,
    lastSyncType: entry.syncType,
    lastSyncStatus: entry.status,
  };
}
