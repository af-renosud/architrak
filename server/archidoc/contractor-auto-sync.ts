import { db } from "../db";
import { eq, desc } from "drizzle-orm";
import { archidocSyncLog, archidocContractors, contractors } from "@shared/schema";
import type { ArchidocContractor, InsertContractor } from "@shared/schema";
import { syncContractors } from "./sync-service";
import { isArchidocConfigured } from "./sync-client";

export const CONTRACTOR_AUTO_SYNC_TYPE = "contractor_auto_import";

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

function buildSyncedFields(mirror: ArchidocContractor): Omit<InsertContractor, "notes" | "defaultTvaRate"> {
  const contact = pickContactFields(mirror);
  return {
    name: mirror.name,
    siret: mirror.siret ?? null,
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
  error?: string;
}

export async function runContractorAutoSync(options: { incremental?: boolean } = {}): Promise<ContractorAutoSyncResult> {
  if (!isArchidocConfigured()) {
    return { mirrorUpdated: 0, created: 0, updated: 0, skipped: 0, error: "ArchiDoc not configured" };
  }

  const [logEntry] = await db
    .insert(archidocSyncLog)
    .values({ syncType: CONTRACTOR_AUTO_SYNC_TYPE, status: "running" })
    .returning();

  try {
    const mirrorResult = await syncContractors(options.incremental ?? false);
    if (mirrorResult.error) {
      throw new Error(mirrorResult.error);
    }

    const allMirror = await db.select().from(archidocContractors);
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const mirror of allMirror) {
      const fields = buildSyncedFields(mirror);

      const [existing] = await db
        .select()
        .from(contractors)
        .where(eq(contractors.archidocId, mirror.archidocId))
        .limit(1);

      if (existing) {
        await db
          .update(contractors)
          .set(fields)
          .where(eq(contractors.id, existing.id));
        updated++;
      } else {
        try {
          await db.insert(contractors).values({
            ...fields,
            defaultTvaRate: "20.00",
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

    await db
      .update(archidocSyncLog)
      .set({
        status: "completed",
        completedAt: new Date(),
        recordsUpdated: created + updated,
      })
      .where(eq(archidocSyncLog.id, logEntry.id));

    console.log(
      `[ArchiDoc Contractor AutoSync] Done: mirror=${mirrorResult.updated} created=${created} updated=${updated} skipped=${skipped}`,
    );

    return { mirrorUpdated: mirrorResult.updated, created, updated, skipped };
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
    return { mirrorUpdated: 0, created: 0, updated: 0, skipped: 0, error: message };
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
