import { createHash } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import {
  archidocPaymentSupplierAssignments,
  archidocPaymentSuppliers,
  archidocPaymentSupplierSyncState,
} from "@shared/schema";
import { db } from "../db";
import { env } from "../env";
import {
  fetchAllPaymentSupplierWindows,
  fetchPaymentSupplierWindow,
  PaymentSupplierCursorExpiredError,
  type PaymentSupplierAssignment,
  type PaymentSupplierPageRequest,
  type SupplierChange,
  type SupplierWindow,
} from "./supplier-payment-readiness";
import { normalizeSupplierName } from "../services/payment-supplier-appointment";

export const PAYMENT_SUPPLIER_STREAM = "supplier-payment-readiness.v1";

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface PaymentSupplierMirrorTransaction {
  currentSequence(stream: string): Promise<bigint>;
  applyChange(change: SupplierChange): Promise<"applied" | "duplicate">;
  reconcileBootstrap(seenSupplierIds: readonly string[], throughSequence: bigint): Promise<void>;
  advanceSequence(stream: string, expected: bigint, sequence: bigint): Promise<void>;
}

export interface PaymentSupplierMirrorStore {
  transaction<T>(operation: (tx: PaymentSupplierMirrorTransaction) => Promise<T>): Promise<T>;
}

function flattenChanges(pages: readonly SupplierWindow[]): SupplierChange[] {
  return pages.flatMap(page => page.changes);
}

/**
 * Applies a fully downloaded and validated multi-page window atomically.
 * A bootstrap reconciliation is therefore impossible until the terminal page
 * has arrived. Sequence gaps are valid; event order is the only requirement.
 */
export async function applyPaymentSupplierWindows(
  store: PaymentSupplierMirrorStore,
  pages: readonly SupplierWindow[],
  stream = PAYMENT_SUPPLIER_STREAM,
): Promise<number> {
  if (pages.length === 0) throw new Error("Supplier readiness batch is empty");
  const window = pages[0].syncWindow;
  const changes = flattenChanges(pages);
  let previous: bigint | null = null;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (page.syncWindow.mode !== window.mode ||
        page.syncWindow.afterSequenceExclusive !== window.afterSequenceExclusive ||
        page.syncWindow.throughSequenceInclusive !== window.throughSequenceInclusive ||
        page.syncWindow.minimumAvailableSequence !== window.minimumAvailableSequence) {
      throw new Error("Supplier readiness sync-window drift across pages");
    }
    if ((index < pages.length - 1) !== (page.nextPageToken !== null)) {
      throw new Error("Supplier readiness batch is not a complete page chain");
    }
    for (const change of page.changes) {
      if (previous !== null && change.sequence <= previous) {
        throw new Error("Supplier readiness changes are not ordered across pages");
      }
      previous = change.sequence;
    }
  }
  return store.transaction(async tx => {
    const current = await tx.currentSequence(stream);
    // Bootstrap is also the cursor-expiry recovery path. It replaces the
    // mirror snapshot from any durable high-water, not only a fresh sequence
    // of zero. The durable cursor still must not be ahead of the snapshot.
    const expected = window.mode === "bootstrap"
      ? current
      : window.afterSequenceExclusive!;
    if ((window.mode === "bootstrap" && current > window.throughSequenceInclusive) ||
        (window.mode === "incremental" &&
          current !== expected &&
          current !== window.throughSequenceInclusive)) {
      throw new Error(`Supplier readiness cursor/window drift: durable=${current}, expected=${expected}`);
    }
    let applied = 0;
    for (const change of changes) {
      const result = await tx.applyChange(change);
      if (result === "applied") applied++;
    }
    if (current === window.throughSequenceInclusive && applied !== 0) {
      throw new Error("Supplier readiness retry conflicts with already advanced sequence");
    }
    if (window.mode === "bootstrap") {
      const seen = changes
        .filter((change): change is Extract<SupplierChange, { operation: "upsert" }> => change.operation === "upsert")
        .map(change => change.supplier.id);
      await tx.reconcileBootstrap(seen, window.throughSequenceInclusive);
    }
    if (current !== window.throughSequenceInclusive) {
      await tx.advanceSequence(stream, expected, window.throughSequenceInclusive);
    }
    return applied;
  });
}

/** Fetches every page before opening the write transaction. */
export async function syncPaymentSupplierReadiness(
  store: PaymentSupplierMirrorStore,
  request: Exclude<PaymentSupplierPageRequest, { pageToken: string }>,
  fetchPage: (request: PaymentSupplierPageRequest) => Promise<SupplierWindow> = page => fetchPaymentSupplierWindow(page),
): Promise<number> {
  let isFirstRequest = true;
  let expiredOnFirstRequest = false;
  const fetchInitialWindow = async (page: PaymentSupplierPageRequest): Promise<SupplierWindow> => {
    try {
      return await fetchPage(page);
    } catch (error) {
      expiredOnFirstRequest = isFirstRequest && error instanceof PaymentSupplierCursorExpiredError;
      throw error;
    } finally {
      isFirstRequest = false;
    }
  };
  try {
    const pages = await fetchAllPaymentSupplierWindows(request, fetchInitialWindow);
    return applyPaymentSupplierWindows(store, pages);
  } catch (error) {
    if (!(error instanceof PaymentSupplierCursorExpiredError) || request.mode !== "incremental" || !expiredOnFirstRequest) throw error;
    const bootstrap = await fetchAllPaymentSupplierWindows({ mode: "bootstrap" }, fetchPage);
    const appliedBootstrap = await applyPaymentSupplierWindows(store, bootstrap);
    const afterSequence = bootstrap[0].syncWindow.throughSequenceInclusive;
    const catchup = await fetchAllPaymentSupplierWindows({ mode: "incremental", afterSequence }, fetchPage);
    return appliedBootstrap + await applyPaymentSupplierWindows(store, catchup);
  }
}

type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function existingSupplier(tx: DrizzleTransaction, id: string) {
  return (await tx.select({
    sequence: archidocPaymentSuppliers.sourceSequence,
    sourceHash: archidocPaymentSuppliers.sourceHash,
    isDeleted: archidocPaymentSuppliers.isDeleted,
  }).from(archidocPaymentSuppliers).where(eq(archidocPaymentSuppliers.paymentSupplierId, id)).limit(1))[0];
}

async function replaceAssignments(
  tx: DrizzleTransaction,
  supplierId: string,
  assignments: PaymentSupplierAssignment[],
  sequence: bigint,
  now: Date,
): Promise<void> {
  // The wire array is the complete assignment set, not a delta. Tombstone the
  // old set first (including an assignment whose projectId changed), then
  // revive/upsert exactly the rows published by this event.
  await tx.update(archidocPaymentSupplierAssignments).set({
    isDeleted: true, deletedAt: now, sourceSequence: sequence, syncedAt: now,
  }).where(and(
    eq(archidocPaymentSupplierAssignments.paymentSupplierId, supplierId),
    eq(archidocPaymentSupplierAssignments.isDeleted, false),
  ));
  for (const assignment of assignments) {
    const sourceHash = hash(assignment);
    await tx.insert(archidocPaymentSupplierAssignments).values({
      paymentSupplierId: supplierId,
      archidocProjectId: assignment.projectId,
      assignmentId: assignment.id,
      directPaymentStatus: assignment.directPaymentStatus,
      validFrom: assignment.validFrom,
      validUntil: assignment.validUntil,
      reason: assignment.reason,
      sourceHash,
      sourceSequence: sequence,
      isDeleted: false,
      deletedAt: null,
      updatedAt: new Date(assignment.updatedAt),
      syncedAt: now,
    }).onConflictDoUpdate({
      target: [
        archidocPaymentSupplierAssignments.paymentSupplierId,
        archidocPaymentSupplierAssignments.archidocProjectId,
        archidocPaymentSupplierAssignments.assignmentId,
      ],
      set: {
        directPaymentStatus: assignment.directPaymentStatus,
        validFrom: assignment.validFrom,
        validUntil: assignment.validUntil,
        reason: assignment.reason,
        sourceHash,
        sourceSequence: sequence,
        isDeleted: false,
        deletedAt: null,
        updatedAt: new Date(assignment.updatedAt),
        syncedAt: now,
      },
    });
  }
}

class DrizzlePaymentSupplierTransaction implements PaymentSupplierMirrorTransaction {
  constructor(private readonly tx: DrizzleTransaction) {}

  async currentSequence(stream: string): Promise<bigint> {
    await this.tx.insert(archidocPaymentSupplierSyncState).values({ stream, sequence: BigInt(0) })
      .onConflictDoNothing();
    const row = (await this.tx.select({ sequence: archidocPaymentSupplierSyncState.sequence })
      .from(archidocPaymentSupplierSyncState)
      .where(eq(archidocPaymentSupplierSyncState.stream, stream))
      .for("update"))[0];
    return row.sequence;
  }

  async applyChange(change: SupplierChange): Promise<"applied" | "duplicate"> {
    const supplierId = change.operation === "upsert" ? change.supplier.id : change.supplierId;
    const sourceHash = hash(change);
    const existing = await existingSupplier(this.tx, supplierId);
    if (existing && existing.sequence >= change.sequence) {
      if (existing.sequence === change.sequence && existing.sourceHash === sourceHash) return "duplicate";
      throw new Error(`Conflicting old supplier event ${supplierId} at sequence ${change.sequence}`);
    }
    const now = new Date();
    if (change.operation === "delete") {
      if (!existing) throw new Error(`Cannot delete unknown payment supplier ${supplierId}`);
      await this.tx.update(archidocPaymentSuppliers).set({
        sourceHash,
        sourceSequence: change.sequence,
        isDeleted: true,
        deletedAt: new Date(change.changedAt),
        syncedAt: now,
      }).where(eq(archidocPaymentSuppliers.paymentSupplierId, supplierId));
      await this.tx.update(archidocPaymentSupplierAssignments).set({
        isDeleted: true, deletedAt: new Date(change.changedAt), sourceSequence: change.sequence, syncedAt: now,
      }).where(and(
        eq(archidocPaymentSupplierAssignments.paymentSupplierId, supplierId),
        eq(archidocPaymentSupplierAssignments.isDeleted, false),
      ));
      return "applied";
    }
    const supplier = change.supplier;
    const banking = supplier.banking;
    const sourceBaseUrl = env.ARCHIDOC_BASE_URL;
    if (!sourceBaseUrl) throw new Error("ArchiDoc source base URL is not configured");
    await this.tx.insert(archidocPaymentSuppliers).values({
      paymentSupplierId: supplier.id,
      name: supplier.name,
      normalizedName: normalizeSupplierName(supplier.name),
      siret: supplier.siret,
      iban: banking?.iban ?? null,
      bic: banking?.bic ?? null,
      accountHolderName: banking?.accountHolderName ?? null,
      bankingVerificationStatus: banking?.bankingVerificationStatus ?? null,
      ribMetadata: banking ?? {},
      sourceHash,
      sourceSequence: change.sequence,
      isActive: supplier.isActive,
      isDeleted: false,
      deletedAt: null,
      sourceBaseUrl,
      archidocUpdatedAt: new Date(supplier.updatedAt),
      syncedAt: now,
    }).onConflictDoUpdate({
      target: archidocPaymentSuppliers.paymentSupplierId,
      set: {
        name: supplier.name,
        normalizedName: normalizeSupplierName(supplier.name),
        siret: supplier.siret,
        iban: banking?.iban ?? null,
        bic: banking?.bic ?? null,
        accountHolderName: banking?.accountHolderName ?? null,
        bankingVerificationStatus: banking?.bankingVerificationStatus ?? null,
        ribMetadata: banking ?? {},
        sourceHash,
        sourceSequence: change.sequence,
        isActive: supplier.isActive,
        isDeleted: false,
        deletedAt: null,
        sourceBaseUrl,
        archidocUpdatedAt: new Date(supplier.updatedAt),
        syncedAt: now,
      },
    });
    await replaceAssignments(this.tx, supplier.id, supplier.projectPaymentAssignments, change.sequence, now);
    return "applied";
  }

  async reconcileBootstrap(seenSupplierIds: readonly string[], throughSequence: bigint): Promise<void> {
    const now = new Date();
    const predicate = seenSupplierIds.length
      ? and(eq(archidocPaymentSuppliers.isDeleted, false), notInArray(archidocPaymentSuppliers.paymentSupplierId, [...seenSupplierIds]))
      : eq(archidocPaymentSuppliers.isDeleted, false);
    await this.tx.update(archidocPaymentSuppliers).set({
      isDeleted: true, deletedAt: now, sourceSequence: throughSequence, syncedAt: now,
    }).where(predicate);
    const assignmentPredicate = seenSupplierIds.length
      ? and(eq(archidocPaymentSupplierAssignments.isDeleted, false), notInArray(archidocPaymentSupplierAssignments.paymentSupplierId, [...seenSupplierIds]))
      : eq(archidocPaymentSupplierAssignments.isDeleted, false);
    await this.tx.update(archidocPaymentSupplierAssignments).set({
      isDeleted: true, deletedAt: now, sourceSequence: throughSequence, syncedAt: now,
    }).where(assignmentPredicate);
  }

  async advanceSequence(stream: string, expected: bigint, sequence: bigint): Promise<void> {
    const updated = await this.tx.update(archidocPaymentSupplierSyncState)
      .set({ sequence, updatedAt: new Date() })
      .where(and(
        eq(archidocPaymentSupplierSyncState.stream, stream),
        eq(archidocPaymentSupplierSyncState.sequence, expected),
      ))
      .returning({ stream: archidocPaymentSupplierSyncState.stream });
    if (updated.length !== 1) throw new Error("Supplier readiness high-water sequence changed concurrently");
  }
}

export class DrizzlePaymentSupplierMirrorStore implements PaymentSupplierMirrorStore {
  async transaction<T>(operation: (tx: PaymentSupplierMirrorTransaction) => Promise<T>): Promise<T> {
    return db.transaction(tx => operation(new DrizzlePaymentSupplierTransaction(tx)));
  }
}