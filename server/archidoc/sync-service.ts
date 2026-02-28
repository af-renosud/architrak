import { db } from "../db";
import { eq, desc } from "drizzle-orm";
import {
  archidocProjects,
  archidocContractors,
  archidocTrades,
  archidocProposalFees,
  archidocSyncLog,
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

async function createSyncLog(syncType: string) {
  const [entry] = await db.insert(archidocSyncLog).values({
    syncType,
    status: "running",
  }).returning();
  return entry;
}

async function completeSyncLog(id: number, status: string, recordsUpdated: number, errorMessage?: string) {
  await db.update(archidocSyncLog)
    .set({
      status,
      completedAt: new Date(),
      recordsUpdated,
      errorMessage: errorMessage || null,
    })
    .where(eq(archidocSyncLog.id, id));
}

async function upsertProject(p: ArchidocProjectData) {
  const clientName = p.clients?.[0]?.name || null;
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
    isDeleted: p.isDeleted ?? false,
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

async function upsertContractor(c: ArchidocContractorData) {
  const values = {
    archidocId: c.id,
    name: c.name,
    siret: c.siret || null,
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
}

async function upsertTrade(t: ArchidocTradeData) {
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
    for (const project of response.projects) {
      await upsertProject(project);
      count++;
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
    for (const contractor of response.contractors) {
      await upsertContractor(contractor);
      count++;
    }

    await completeSyncLog(log.id, "completed", count);
    console.log(`[ArchiDoc Sync] Contractors synced: ${count} records`);
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
