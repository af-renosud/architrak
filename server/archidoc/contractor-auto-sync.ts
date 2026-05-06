import { db } from "../db";
import { eq, desc, and, isNotNull, isNull, notInArray } from "drizzle-orm";
import { archidocSyncLog, archidocContractors, contractors } from "@shared/schema";
import type { ArchidocContractor, InsertContractor } from "@shared/schema";
import { syncContractors } from "./sync-service";
import { isArchidocConfigured } from "./sync-client";
import { normalizeSiret } from "../gmail/document-parser";

export const CONTRACTOR_AUTO_SYNC_TYPE = "contractor_auto_import";

// Only persist a SIRET if it normalises to the canonical 14-digit form.
// Anything shorter/longer is unusable for the SIRET-first matcher and would
// only contaminate the column, so we coerce it back to null.
export function normaliseSiretForStorage(raw: string | null | undefined): string | null {
  const digits = normalizeSiret(raw);
  return digits.length === 14 ? digits : null;
}

function pickContactFields(mirror: ArchidocContractor) {
  const contacts = (mirror.contacts as any[]) || [];
  const primaryContact = contacts.find((c: any) => c.isPrimary) || contacts[0];
  return {
    contactName: primaryContact?.name ?? null,
    contactJobTitle: primaryContact?.jobTitle ?? null,
    contactMobile: primaryContact?.mobile ?? null,
    email: primaryContact?.email ?? null,
    phone: mirror.officePhone ?? primaryContact?.mobile ?? null,
  };
}

function buildSyncedFields(mirror: ArchidocContractor): Omit<InsertContractor, "notes"> {
  const contact = pickContactFields(mirror);
  return {
    name: mirror.name,
    siret: normaliseSiretForStorage(mirror.siret),
    address: [mirror.address1, mirror.address2].filter(Boolean).join(", ") || null,
    email: contact.email,
    phone: contact.phone,
    archidocId: mirror.archidocId,
    contactName: contact.contactName,
    contactJobTitle: contact.contactJobTitle,
    contactMobile: contact.contactMobile,
    town: mirror.town ?? null,
    postcode: mirror.postcode ?? null,
    website: mirror.website ?? null,
    insuranceStatus: mirror.insuranceStatus ?? null,
    decennaleInsurer: mirror.decennaleInsurer ?? null,
    decennalePolicyNumber: mirror.decennalePolicyNumber ?? null,
    decennaleEndDate: mirror.decennaleEndDate ?? null,
    rcProInsurer: mirror.rcProInsurer ?? null,
    rcProPolicyNumber: mirror.rcProPolicyNumber ?? null,
    rcProEndDate: mirror.rcProEndDate ?? null,
    specialConditions: mirror.specialConditions ?? null,
  };
}

export interface ContractorAutoSyncResult {
  mirrorUpdated: number;
  created: number;
  updated: number;
  skipped: number;
  orphaned: number;
  unorphaned: number;
  error?: string;
}

export async function runContractorAutoSync(options: { incremental?: boolean } = {}): Promise<ContractorAutoSyncResult> {
  if (!isArchidocConfigured()) {
    return { mirrorUpdated: 0, created: 0, updated: 0, skipped: 0, orphaned: 0, unorphaned: 0, error: "ArchiDoc not configured" };
  }

  const [logEntry] = await db
    .insert(archidocSyncLog)
    .values({ syncType: CONTRACTOR_AUTO_SYNC_TYPE, status: "running" })
    .returning();

  try {
    const incremental = options.incremental ?? false;
    const syncStartedAt = new Date();
    const mirrorResult = await syncContractors(incremental);
    if (mirrorResult.error) {
      throw new Error(mirrorResult.error);
    }

    // Exclude soft-deleted mirror rows so the auto-sync doesn't
    // resurrect contractors that the reconciliation pass just cleared
    // (rows from a previously-configured Archidoc backend, or rows
    // missing from the latest full sync response).
    const allMirror = await db
      .select()
      .from(archidocContractors)
      .where(eq(archidocContractors.isDeleted, false));
    // On a full sync, only iterate mirror rows refreshed in this run so we
    // don't keep upserting (and re-clearing the orphan flag for) stale rows.
    // On incremental runs, every mirror row is potentially up-to-date.
    const mirrorToProcess = incremental
      ? allMirror
      : allMirror.filter((m) => m.syncedAt && m.syncedAt >= syncStartedAt);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let unorphaned = 0;

    for (const mirror of mirrorToProcess) {
      const fields = buildSyncedFields(mirror);

      const [existing] = await db
        .select()
        .from(contractors)
        .where(eq(contractors.archidocId, mirror.archidocId))
        .limit(1);

      if (existing) {
        // Only flip archidocOrphanedAt back to null when transitioning out of
        // the orphaned state, so we don't churn the column on every run.
        const setFields = existing.archidocOrphanedAt
          ? { ...fields, archidocOrphanedAt: null }
          : fields;
        await db
          .update(contractors)
          .set(setFields)
          .where(eq(contractors.id, existing.id));
        updated++;
        if (existing.archidocOrphanedAt) unorphaned++;
      } else {
        try {
          await db.insert(contractors).values({
            ...fields,
            notes: null,
          });
          created++;
        } catch (err) {
          console.error(
            `[ArchiDoc Contractor AutoSync] Failed to insert contractor ${mirror.archidocId} (${mirror.name}):`,
            err,
          );
          skipped++;
        }
      }
    }

    // Orphan detection only runs after a full (non-incremental) sync, because
    // incremental syncs only return contractors changed since the last run, so
    // absence from the response is not proof of upstream deletion.
    let orphaned = 0;
    if (!incremental) {
      // Use this run's syncedAt timestamp as source of truth: any mirror row
      // not refreshed in this pass is stale (no longer returned by ArchiDoc).
      const freshMirrorIds = mirrorToProcess.map((m) => m.archidocId);

      if (freshMirrorIds.length > 0) {
        const newlyOrphaned = await db
          .update(contractors)
          .set({ archidocOrphanedAt: new Date() })
          .where(
            and(
              isNotNull(contractors.archidocId),
              isNull(contractors.archidocOrphanedAt),
              notInArray(contractors.archidocId, freshMirrorIds),
            ),
          )
          .returning({ id: contractors.id });
        orphaned = newlyOrphaned.length;
      } else {
        const newlyOrphaned = await db
          .update(contractors)
          .set({ archidocOrphanedAt: new Date() })
          .where(and(isNotNull(contractors.archidocId), isNull(contractors.archidocOrphanedAt)))
          .returning({ id: contractors.id });
        orphaned = newlyOrphaned.length;
      }
    }

    await db
      .update(archidocSyncLog)
      .set({
        status: "completed",
        completedAt: new Date(),
        recordsUpdated: created + updated,
      })
      .where(eq(archidocSyncLog.id, logEntry.id));

    console.log(
      `[ArchiDoc Contractor AutoSync] Done: mirror=${mirrorResult.updated} created=${created} updated=${updated} skipped=${skipped} orphaned=${orphaned}`,
    );

    return { mirrorUpdated: mirrorResult.updated, created, updated, skipped, orphaned, unorphaned };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(archidocSyncLog)
      .set({
        status: "failed",
        completedAt: new Date(),
        recordsUpdated: 0,
        errorMessage: message,
      })
      .where(eq(archidocSyncLog.id, logEntry.id));
    console.error(`[ArchiDoc Contractor AutoSync] Failed: ${message}`);
    return { mirrorUpdated: 0, created: 0, updated: 0, skipped: 0, orphaned: 0, unorphaned: 0, error: message };
  }
}

export async function getLastContractorAutoSync(): Promise<{
  lastSyncedAt: Date | null;
  status: string | null;
  errorMessage: string | null;
}> {
  const [entry] = await db
    .select()
    .from(archidocSyncLog)
    .where(eq(archidocSyncLog.syncType, CONTRACTOR_AUTO_SYNC_TYPE))
    .orderBy(desc(archidocSyncLog.id))
    .limit(1);

  if (!entry) {
    return { lastSyncedAt: null, status: null, errorMessage: null };
  }
  return {
    lastSyncedAt: entry.completedAt || entry.startedAt,
    status: entry.status,
    errorMessage: entry.errorMessage,
  };
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startContractorAutoSyncScheduler(intervalMs: number = 60 * 60 * 1000): void {
  if (intervalHandle) return;
  if (!isArchidocConfigured()) {
    console.log("[ArchiDoc Contractor AutoSync] ArchiDoc not configured, scheduler disabled");
    return;
  }

  console.log(`[ArchiDoc Contractor AutoSync] Scheduler starting, interval=${intervalMs / 1000}s`);

  const tick = async () => {
    if (inFlight) {
      console.log("[ArchiDoc Contractor AutoSync] Previous run still in flight, skipping tick");
      return;
    }
    inFlight = true;
    try {
      await runContractorAutoSync({ incremental: false });
    } catch (err) {
      console.error("[ArchiDoc Contractor AutoSync] Unhandled tick error:", err);
    } finally {
      inFlight = false;
    }
  };

  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error("[ArchiDoc Contractor AutoSync] Tick rejected:", err));
  }, intervalMs);

  setTimeout(() => {
    tick().catch((err) => console.error("[ArchiDoc Contractor AutoSync] Initial run rejected:", err));
  }, 30_000);
}

export function stopContractorAutoSyncScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
