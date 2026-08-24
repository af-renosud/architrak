import { createHash } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import {
  archidocContractors,
  archidocSupplierPaymentAssignments,
  archidocSupplierPaymentCursor,
  archidocSupplierPaymentReadiness,
  archidocSyncLog,
  contractors,
  projects,
} from "@shared/schema";
import {
  fetchSupplierPaymentReadinessPage,
  isArchidocConfigured,
  SupplierPaymentCursorExpiredError,
} from "./sync-client";
import {
  SUPPLIER_PAYMENT_READINESS_CONTRACT_VERSION,
  type SupplierPaymentReadinessChange,
  type SupplierPaymentReadinessMode,
  type SupplierPaymentReadinessResponse,
  type SupplierPaymentReadinessSupplier,
} from "./supplier-payment-readiness-wire";

const MIN_ROWS_FOR_RATIO_GUARD = 5;
const WIPE_GUARD_RATIO = 0.9;

export interface SupplierPaymentReadinessSyncResult {
  updated: number;
  deleted: number;
  mode?: SupplierPaymentReadinessMode;
  cursor?: string;
  recoveredExpiredCursor?: boolean;
  error?: string;
  warning?: string;
}

export interface SupplierPaymentReadinessWindow {
  mode: SupplierPaymentReadinessMode;
  afterSequenceExclusive: string | null;
  throughSequenceInclusive: string;
  minimumAvailableSequence: string;
  changes: SupplierPaymentReadinessChange[];
}

class SupplierPaymentReadinessSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierPaymentReadinessSyncError";
  }
}

function currentSourceBaseUrl(): string {
  const raw = env.ARCHIDOC_BASE_URL;
  if (!raw) {
    throw new SupplierPaymentReadinessSyncError(
      "Supplier payment-readiness sync is not configured.",
    );
  }
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    throw new SupplierPaymentReadinessSyncError(
      "Supplier payment-readiness sync has an invalid ArchiDoc base URL.",
    );
  }
}

function changePayloadHash(change: SupplierPaymentReadinessChange): string {
  return createHash("sha256").update(JSON.stringify(change)).digest("hex");
}

function wipeGuardWarning(
  activeCount: number,
  wouldDelete: number,
  seenCount: number,
): string | null {
  if (activeCount === 0 || wouldDelete === 0) return null;
  const wipesAll = wouldDelete >= activeCount;
  const wipesMost =
    activeCount >= MIN_ROWS_FOR_RATIO_GUARD &&
    wouldDelete / activeCount >= WIPE_GUARD_RATIO;
  if (!wipesAll && !wipesMost) return null;
  return (
    `Refused supplier payment-readiness bootstrap reconciliation: it would ` +
    `soft-delete ${wouldDelete} of ${activeCount} active suppliers while the ` +
    `complete snapshot contained ${seenCount}.`
  );
}

async function fetchFrozenWindow(
  mode: SupplierPaymentReadinessMode,
  afterSequenceExclusive: string | null,
): Promise<SupplierPaymentReadinessWindow> {
  const pages: SupplierPaymentReadinessResponse[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = await fetchSupplierPaymentReadinessPage(
      pageToken
        ? { pageToken }
        : {
            mode,
            afterSequence:
              mode === "incremental"
                ? afterSequenceExclusive ?? undefined
                : undefined,
            limit: 200,
          },
    );
    pages.push(page);
    if (page.nextPageToken) {
      if (seenTokens.has(page.nextPageToken)) {
        throw new SupplierPaymentReadinessSyncError(
          "ArchiDoc repeated a supplier payment-readiness page token.",
        );
      }
      seenTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    } else {
      pageToken = undefined;
    }
  } while (pageToken);

  const first = pages[0];
  if (!first) {
    throw new SupplierPaymentReadinessSyncError(
      "ArchiDoc returned no supplier payment-readiness page.",
    );
  }
  if (
    first.syncWindow.mode !== mode ||
    first.syncWindow.afterSequenceExclusive !== afterSequenceExclusive
  ) {
    throw new SupplierPaymentReadinessSyncError(
      "ArchiDoc returned a supplier payment-readiness window that does not match the requested cursor.",
    );
  }

  const changes: SupplierPaymentReadinessChange[] = [];
  let priorSequence: bigint | null = null;
  let priorBootstrapSupplierId: string | null = null;
  const bootstrapSupplierIds = new Set<string>();
  const changeSequences = new Set<string>();
  const assignmentIds = new Set<string>();
  for (const page of pages) {
    if (
      page.syncWindow.mode !== first.syncWindow.mode ||
      page.syncWindow.afterSequenceExclusive !==
        first.syncWindow.afterSequenceExclusive ||
      page.syncWindow.throughSequenceInclusive !==
        first.syncWindow.throughSequenceInclusive ||
      page.syncWindow.minimumAvailableSequence !==
        first.syncWindow.minimumAvailableSequence
    ) {
      throw new SupplierPaymentReadinessSyncError(
        "ArchiDoc changed the frozen supplier payment-readiness window between pages.",
      );
    }
    for (const change of page.changes) {
      const sequence = BigInt(change.sequence);
      if (changeSequences.has(change.sequence)) {
        throw new SupplierPaymentReadinessSyncError(
          "Supplier payment-readiness sequence was duplicated across pages.",
        );
      }
      changeSequences.add(change.sequence);
      if (
        mode === "incremental" &&
        priorSequence !== null &&
        sequence <= priorSequence
      ) {
        throw new SupplierPaymentReadinessSyncError(
          "Supplier payment-readiness events are not globally ordered across pages.",
        );
      }
      if (mode === "bootstrap") {
        if (change.operation !== "upsert") {
          throw new SupplierPaymentReadinessSyncError(
            "A supplier payment-readiness bootstrap contained a delete event.",
          );
        }
        if (
          bootstrapSupplierIds.has(change.supplier.id) ||
          (
            priorBootstrapSupplierId !== null &&
            change.supplier.id <= priorBootstrapSupplierId
          )
        ) {
          throw new SupplierPaymentReadinessSyncError(
            "Supplier payment-readiness bootstrap suppliers are duplicated or out of order across pages.",
          );
        }
        bootstrapSupplierIds.add(change.supplier.id);
        priorBootstrapSupplierId = change.supplier.id;
      }
      if (change.operation === "upsert") {
        for (const assignment of
          change.supplier.projectPaymentAssignments) {
          if (assignmentIds.has(assignment.id)) {
            throw new SupplierPaymentReadinessSyncError(
              "Supplier payment-readiness assignment was duplicated across pages.",
            );
          }
          assignmentIds.add(assignment.id);
        }
      }
      changes.push(change);
      priorSequence = sequence;
    }
  }

  return {
    mode,
    afterSequenceExclusive,
    throughSequenceInclusive: first.syncWindow.throughSequenceInclusive,
    minimumAvailableSequence: first.syncWindow.minimumAvailableSequence,
    changes,
  };
}

export async function fetchSupplierPaymentReadinessWindowWithRecovery(
  mode: SupplierPaymentReadinessMode,
  afterSequenceExclusive: string | null,
): Promise<{
  window: SupplierPaymentReadinessWindow;
  recoveredExpiredCursor: boolean;
}> {
  try {
    return {
      window: await fetchFrozenWindow(mode, afterSequenceExclusive),
      recoveredExpiredCursor: false,
    };
  } catch (error) {
    if (!(error instanceof SupplierPaymentCursorExpiredError)) throw error;
    return {
      window: await fetchFrozenWindow("bootstrap", null),
      recoveredExpiredCursor: true,
    };
  }
}

function canonicalSupplierFields(supplier: SupplierPaymentReadinessSupplier) {
  const contact = supplier.primaryContact;
  const banking = supplier.banking;
  return {
    name: supplier.name,
    siret: supplier.siret,
    address:
      [supplier.address1, supplier.address2].filter(Boolean).join(", ") ||
      null,
    email: contact?.email ?? null,
    phone: contact?.mobile ?? null,
    archidocId: supplier.id,
    archidocPartnerType: "supplier" as const,
    contactName: contact?.name ?? null,
    contactJobTitle: contact?.jobTitle ?? null,
    contactMobile: contact?.mobile ?? null,
    town: supplier.town,
    postcode: supplier.postcode,
    accountHolderName: banking?.accountHolderName ?? null,
    iban: banking?.iban ?? null,
    bic: banking?.bic ?? null,
    bankName: banking?.bankName ?? null,
    // The v1 feed carries a protected, hash-bound downloadPath rather than
    // the legacy contractor RIB URL. Keep it exclusively in readiness
    // metadata until the protected fetch consumer supplies the mandatory hash.
    ribDocumentUrl: null,
    ribDocumentName: banking?.ribDocument?.fileName ?? null,
    bankingVerifiedAt: banking?.bankingVerifiedAt
      ? new Date(banking.bankingVerifiedAt)
      : null,
    bankingVerifiedBy: banking?.bankingVerifiedBy?.displayName ?? null,
    bankingAiExtractedData: null,
  };
}

async function acquireSealDomainLocks(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  supplierIds: string[],
  incomingAssignments: Map<string, string[]>,
): Promise<void> {
  if (supplierIds.length === 0) return;
  const [canonicalRows, oldAssignments] = await Promise.all([
    tx
      .select({ id: contractors.id, archidocId: contractors.archidocId })
      .from(contractors)
      .where(inArray(contractors.archidocId, supplierIds)),
    tx
      .select({
        supplierArchidocId:
          archidocSupplierPaymentAssignments.supplierArchidocId,
        projectArchidocId:
          archidocSupplierPaymentAssignments.projectArchidocId,
      })
      .from(archidocSupplierPaymentAssignments)
      .where(
        inArray(
          archidocSupplierPaymentAssignments.supplierArchidocId,
          supplierIds,
        ),
      ),
  ]);
  const projectIdsBySupplier = new Map<string, Set<string>>();
  for (const supplierId of supplierIds) {
    projectIdsBySupplier.set(
      supplierId,
      new Set(incomingAssignments.get(supplierId) ?? []),
    );
  }
  for (const assignment of oldAssignments) {
    projectIdsBySupplier
      .get(assignment.supplierArchidocId)
      ?.add(assignment.projectArchidocId);
  }
  const allProjectArchidocIds = Array.from(
    new Set(
      Array.from(projectIdsBySupplier.values()).flatMap((ids) =>
        Array.from(ids),
      ),
    ),
  );
  if (allProjectArchidocIds.length === 0) return;
  const localProjects = await tx
    .select({ id: projects.id, archidocId: projects.archidocId })
    .from(projects)
    .where(inArray(projects.archidocId, allProjectArchidocIds));
  const localProjectByArchidocId = new Map(
    localProjects
      .filter(
        (project): project is { id: number; archidocId: string } =>
          project.archidocId !== null,
      )
      .map((project) => [project.archidocId, project.id]),
  );
  const pairs: Array<{ projectId: number; contractorId: number }> = [];
  for (const canonical of canonicalRows) {
    if (!canonical.archidocId) continue;
    for (const projectArchidocId of Array.from(
      projectIdsBySupplier.get(canonical.archidocId) ?? [],
    )) {
      const projectId = localProjectByArchidocId.get(projectArchidocId);
      if (projectId !== undefined) {
        pairs.push({ projectId, contractorId: canonical.id });
      }
    }
  }
  pairs.sort(
    (a, b) =>
      a.projectId - b.projectId || a.contractorId - b.contractorId,
  );
  for (const pair of pairs) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${pair.projectId}, ${pair.contractorId})`,
    );
  }
}

export async function persistSupplierPaymentReadinessWindow(
  window: SupplierPaymentReadinessWindow,
  sourceBaseUrl: string,
): Promise<{ updated: number; deleted: number }> {
  return db.transaction(async (tx) => {
    const throughSequence = BigInt(window.throughSequenceInclusive);
    const minimumAvailableSequence = BigInt(
      window.minimumAvailableSequence,
    );
    const afterSequence =
      window.afterSequenceExclusive === null
        ? null
        : BigInt(window.afterSequenceExclusive);
    if (
      minimumAvailableSequence > throughSequence ||
      (
        window.mode === "incremental" &&
        (
          afterSequence === null ||
          throughSequence < afterSequence
        )
      )
    ) {
      throw new SupplierPaymentReadinessSyncError(
        "Supplier payment-readiness window sequence bounds are invalid.",
      );
    }
    const [storedCursor] = await tx
      .select()
      .from(archidocSupplierPaymentCursor)
      .where(eq(archidocSupplierPaymentCursor.singletonKey, 1))
      .limit(1)
      .for("update");
    if (storedCursor) {
      if (
        storedCursor.sourceBaseUrl !== sourceBaseUrl &&
        window.mode !== "bootstrap"
      ) {
        throw new SupplierPaymentReadinessSyncError(
          "A supplier payment-readiness source change requires bootstrap.",
        );
      }
      if (
        storedCursor.sourceBaseUrl === sourceBaseUrl &&
        throughSequence < BigInt(storedCursor.lastSequence)
      ) {
        throw new SupplierPaymentReadinessSyncError(
          "Supplier payment-readiness cursor regression was refused.",
        );
      }
    }
    const capturedAt = new Date();
    const existingRows = await tx
      .select()
      .from(archidocSupplierPaymentReadiness);
    const existingById = new Map(
      existingRows.map((row) => [row.supplierArchidocId, row]),
    );
    const incomingAssignments = new Map<string, string[]>();
    const touchedSupplierIds = new Set<string>();
    const seenBootstrapSupplierIds = new Set<string>();
    for (const change of window.changes) {
      const supplierId =
        change.operation === "upsert" ? change.supplier.id : change.supplierId;
      touchedSupplierIds.add(supplierId);
      if (change.operation === "upsert") {
        incomingAssignments.set(
          supplierId,
          change.supplier.projectPaymentAssignments.map(
            (assignment) => assignment.projectId,
          ),
        );
        if (window.mode === "bootstrap") {
          seenBootstrapSupplierIds.add(supplierId);
        }
      }
    }

    const bootstrapMissingRows =
      window.mode === "bootstrap"
        ? existingRows.filter(
            (row) =>
              !row.isDeleted &&
              row.sourceBaseUrl === sourceBaseUrl &&
              !seenBootstrapSupplierIds.has(row.supplierArchidocId),
          )
        : [];
    const bootstrapDifferentSourceRows =
      window.mode === "bootstrap"
        ? existingRows.filter(
            (row) =>
              !row.isDeleted &&
              row.sourceBaseUrl !== sourceBaseUrl &&
              !seenBootstrapSupplierIds.has(row.supplierArchidocId),
          )
        : [];
    const sameSourceActiveCount = existingRows.filter(
      (row) => !row.isDeleted && row.sourceBaseUrl === sourceBaseUrl,
    ).length;
    const warning =
      window.mode === "bootstrap"
        ? wipeGuardWarning(
            sameSourceActiveCount,
            bootstrapMissingRows.length,
            seenBootstrapSupplierIds.size,
          )
        : null;
    if (warning) throw new SupplierPaymentReadinessSyncError(warning);
    for (const row of [
      ...bootstrapMissingRows,
      ...bootstrapDifferentSourceRows,
    ]) {
      touchedSupplierIds.add(row.supplierArchidocId);
    }

    await acquireSealDomainLocks(
      tx,
      Array.from(touchedSupplierIds),
      incomingAssignments,
    );

    let updated = 0;
    let deleted = 0;
    for (const change of window.changes) {
      if (change.operation === "delete") {
        const existing = existingById.get(change.supplierId);
        const payloadSha256 = changePayloadHash(change);
        if (existing && existing.sourceBaseUrl === sourceBaseUrl) {
          const incomingSequence = BigInt(change.sequence);
          const existingSequence = BigInt(existing.sourceSequence);
          if (incomingSequence < existingSequence) continue;
          if (incomingSequence === existingSequence) {
            if (existing.payloadSha256 !== payloadSha256) {
              throw new SupplierPaymentReadinessSyncError(
                `Supplier ${change.supplierId} reused sequence ${change.sequence} with different content.`,
              );
            }
            continue;
          }
        }
        const deletionTime = new Date(change.changedAt);
        const [storedTombstone] = await tx
          .insert(archidocSupplierPaymentReadiness)
          .values({
            supplierArchidocId: change.supplierId,
            partnerType: "supplier",
            name: "[deleted]",
            siret: null,
            address1: null,
            address2: null,
            town: null,
            postcode: null,
            countryCode: null,
            isActive: false,
            primaryContact: null,
            banking: null,
            sourceSequence: change.sequence,
            payloadSha256,
            changedAt: deletionTime,
            supplierUpdatedAt: deletionTime,
            capturedAt,
            sourceBaseUrl,
            isDeleted: true,
            deletedAt: deletionTime,
          })
          .onConflictDoUpdate({
            target:
              archidocSupplierPaymentReadiness.supplierArchidocId,
            set: {
              sourceSequence: change.sequence,
              payloadSha256,
              changedAt: deletionTime,
              capturedAt,
              sourceBaseUrl,
              isDeleted: true,
              deletedAt: deletionTime,
            },
          })
          .returning();
        await tx
          .update(archidocContractors)
          .set({
            isDeleted: true,
            deletedAt: deletionTime,
            sourceBaseUrl,
            syncedAt: capturedAt,
          })
          .where(eq(archidocContractors.archidocId, change.supplierId));
        await tx
          .update(contractors)
          .set({ archidocOrphanedAt: deletionTime })
          .where(eq(contractors.archidocId, change.supplierId));
        existingById.set(change.supplierId, storedTombstone);
        deleted += 1;
        continue;
      }

      const supplier = change.supplier;
      const payloadSha256 = changePayloadHash(change);
      const existing = existingById.get(supplier.id);
      if (existing && existing.sourceBaseUrl === sourceBaseUrl) {
        const incomingSequence = BigInt(change.sequence);
        const existingSequence = BigInt(existing.sourceSequence);
        if (incomingSequence < existingSequence) continue;
        if (incomingSequence === existingSequence) {
          if (existing.payloadSha256 !== payloadSha256) {
            throw new SupplierPaymentReadinessSyncError(
              `Supplier ${supplier.id} reused sequence ${change.sequence} with different content.`,
            );
          }
          continue;
        }
      }

      const parentValues = {
        supplierArchidocId: supplier.id,
        partnerType: supplier.partnerType,
        name: supplier.name,
        siret: supplier.siret,
        address1: supplier.address1,
        address2: supplier.address2,
        town: supplier.town,
        postcode: supplier.postcode,
        countryCode: supplier.countryCode,
        isActive: supplier.isActive,
        primaryContact: supplier.primaryContact,
        banking: supplier.banking,
        sourceSequence: change.sequence,
        payloadSha256,
        changedAt: new Date(change.changedAt),
        supplierUpdatedAt: new Date(supplier.updatedAt),
        capturedAt,
        sourceBaseUrl,
        isDeleted: false,
        deletedAt: null,
      };
      const [storedParent] = await tx
        .insert(archidocSupplierPaymentReadiness)
        .values(parentValues)
        .onConflictDoUpdate({
          target:
            archidocSupplierPaymentReadiness.supplierArchidocId,
          set: parentValues,
        })
        .returning();
      existingById.set(supplier.id, storedParent);

      await tx
        .delete(archidocSupplierPaymentAssignments)
        .where(
          eq(
            archidocSupplierPaymentAssignments.supplierArchidocId,
            supplier.id,
          ),
        );
      if (supplier.projectPaymentAssignments.length > 0) {
        await tx.insert(archidocSupplierPaymentAssignments).values(
          supplier.projectPaymentAssignments.map((assignment) => ({
            supplierArchidocId: supplier.id,
            assignmentArchidocId: assignment.id,
            projectArchidocId: assignment.projectId,
            directPaymentStatus: assignment.directPaymentStatus,
            validFrom: assignment.validFrom,
            validUntil: assignment.validUntil,
            reason: assignment.reason,
            assignmentUpdatedAt: new Date(assignment.updatedAt),
            capturedAt,
          })),
        );
      }

      const contact = supplier.primaryContact;
      const banking = supplier.banking;
      const mirrorValues = {
        archidocId: supplier.id,
        partnerType: "supplier",
        name: supplier.name,
        siret: supplier.siret,
        address1: supplier.address1,
        address2: supplier.address2,
        town: supplier.town,
        postcode: supplier.postcode,
        officePhone: contact?.mobile ?? null,
        contacts: contact ? [contact] : [],
        accountHolderName: banking?.accountHolderName ?? null,
        iban: banking?.iban ?? null,
        bic: banking?.bic ?? null,
        bankName: banking?.bankName ?? null,
        ribDocumentUrl: null,
        ribDocumentName: banking?.ribDocument?.fileName ?? null,
        bankingVerifiedAt: banking?.bankingVerifiedAt
          ? new Date(banking.bankingVerifiedAt)
          : null,
        bankingVerifiedBy:
          banking?.bankingVerifiedBy?.displayName ?? null,
        bankingAiExtractedData: null,
        isDeleted: false,
        deletedAt: null,
        sourceBaseUrl,
        archidocUpdatedAt: new Date(supplier.updatedAt),
        syncedAt: capturedAt,
      };
      await tx
        .insert(archidocContractors)
        .values(mirrorValues)
        .onConflictDoUpdate({
          target: archidocContractors.archidocId,
          set: mirrorValues,
        });

      const canonicalValues = canonicalSupplierFields(supplier);
      const [canonical] = await tx
        .select({ id: contractors.id })
        .from(contractors)
        .where(eq(contractors.archidocId, supplier.id))
        .limit(1);
      if (canonical) {
        await tx
          .update(contractors)
          .set({ ...canonicalValues, archidocOrphanedAt: null })
          .where(eq(contractors.id, canonical.id));
      } else {
        await tx.insert(contractors).values({
          ...canonicalValues,
          notes: null,
          archidocOrphanedAt: null,
        });
      }
      updated += 1;
    }

    const reconciledRows = [
      ...bootstrapMissingRows,
      ...bootstrapDifferentSourceRows,
    ];
    if (reconciledRows.length > 0) {
      const ids = reconciledRows.map((row) => row.supplierArchidocId);
      await tx
        .update(archidocSupplierPaymentReadiness)
        .set({ isDeleted: true, deletedAt: capturedAt, capturedAt })
        .where(
          inArray(
            archidocSupplierPaymentReadiness.supplierArchidocId,
            ids,
          ),
        );
      await tx
        .update(archidocContractors)
        .set({ isDeleted: true, deletedAt: capturedAt, syncedAt: capturedAt })
        .where(inArray(archidocContractors.archidocId, ids));
      await tx
        .update(contractors)
        .set({ archidocOrphanedAt: capturedAt })
        .where(inArray(contractors.archidocId, ids));
      deleted += reconciledRows.length;
    }

    await tx
      .insert(archidocSupplierPaymentCursor)
      .values({
        singletonKey: 1,
        contractVersion:
          SUPPLIER_PAYMENT_READINESS_CONTRACT_VERSION,
        lastSequence: window.throughSequenceInclusive,
        minimumAvailableSequence: window.minimumAvailableSequence,
        sourceBaseUrl,
        updatedAt: capturedAt,
      })
      .onConflictDoUpdate({
        target: archidocSupplierPaymentCursor.singletonKey,
        set: {
          contractVersion:
            SUPPLIER_PAYMENT_READINESS_CONTRACT_VERSION,
          lastSequence: window.throughSequenceInclusive,
          minimumAvailableSequence: window.minimumAvailableSequence,
          sourceBaseUrl,
          updatedAt: capturedAt,
        },
      });
    return { updated, deleted };
  });
}

export async function syncSupplierPaymentReadinessWithinHeldLock(
  options: { forceBootstrap?: boolean } = {},
): Promise<SupplierPaymentReadinessSyncResult> {
  if (!isArchidocConfigured()) {
    return {
      updated: 0,
      deleted: 0,
      error: "ArchiDoc not configured",
    };
  }
  const [log] = await db
    .insert(archidocSyncLog)
    .values({
      syncType: "supplier_payment_readiness",
      status: "running",
    })
    .returning();
  try {
    const sourceBaseUrl = currentSourceBaseUrl();
    const [cursor] = await db
      .select()
      .from(archidocSupplierPaymentCursor)
      .where(eq(archidocSupplierPaymentCursor.singletonKey, 1))
      .limit(1);
    let mode: SupplierPaymentReadinessMode =
      options.forceBootstrap ||
      !cursor ||
      cursor.sourceBaseUrl !== sourceBaseUrl ||
      cursor.contractVersion !==
        SUPPLIER_PAYMENT_READINESS_CONTRACT_VERSION
        ? "bootstrap"
        : "incremental";
    let afterSequenceExclusive =
      mode === "incremental" ? cursor!.lastSequence : null;
    const fetched =
      await fetchSupplierPaymentReadinessWindowWithRecovery(
        mode,
        afterSequenceExclusive,
      );
    const recoveredExpiredCursor = fetched.recoveredExpiredCursor;
    const window = fetched.window;
    if (recoveredExpiredCursor) {
      mode = "bootstrap";
      afterSequenceExclusive = null;
    }
    const persisted = await persistSupplierPaymentReadinessWindow(
      window,
      sourceBaseUrl,
    );
    await db
      .update(archidocSyncLog)
      .set({
        status: "completed",
        completedAt: new Date(),
        recordsUpdated: persisted.updated + persisted.deleted,
        errorMessage: recoveredExpiredCursor
          ? "Recovered an expired incremental cursor through bootstrap."
          : null,
      })
      .where(eq(archidocSyncLog.id, log.id));
    return {
      ...persisted,
      mode,
      cursor: window.throughSequenceInclusive,
      recoveredExpiredCursor,
    };
  } catch (error) {
    const safeMessage =
      error instanceof SupplierPaymentReadinessSyncError
        ? error.message
        : "Supplier payment-readiness sync failed validation, fetch, or persistence; the cursor was not advanced.";
    await db
      .update(archidocSyncLog)
      .set({
        status: "failed",
        completedAt: new Date(),
        recordsUpdated: 0,
        errorMessage: safeMessage,
      })
      .where(eq(archidocSyncLog.id, log.id));
    console.error("[ArchiDoc Sync] Supplier payment readiness failed", {
      code:
        error instanceof SupplierPaymentReadinessSyncError
          ? "readiness_sync_invariant"
          : "readiness_sync_failed",
    });
    return { updated: 0, deleted: 0, error: safeMessage };
  }
}