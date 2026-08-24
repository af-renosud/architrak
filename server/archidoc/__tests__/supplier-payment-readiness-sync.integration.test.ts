import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db";
import { env } from "../../env";
import { storage } from "../../storage";
import {
  archidocContractors,
  archidocSupplierPaymentAssignments,
  archidocSupplierPaymentCursor,
  archidocSupplierPaymentReadiness,
  contractors,
  projects,
} from "@shared/schema";
import {
  persistSupplierPaymentReadinessWindow,
  type SupplierPaymentReadinessWindow,
} from "../supplier-payment-readiness-sync";
import { upsertContractor } from "../sync-service";
import type {
  SupplierPaymentReadinessSupplier,
} from "../supplier-payment-readiness-wire";

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const supplierId = `supplier-readiness-${suffix}`;
const secondSupplierId = `supplier-readiness-second-${suffix}`;
const projectArchidocId = `project-readiness-${suffix}`;
let projectId: number;
let sourceBaseUrl: string;
let previousCursor:
  | typeof archidocSupplierPaymentCursor.$inferSelect
  | undefined;

function supplier(
  id: string,
  assignment = true,
): SupplierPaymentReadinessSupplier {
  return {
    id,
    partnerType: "supplier",
    name: `Supplier ${id}`,
    siret: "73282932000074",
    address1: "18 rue des Ateliers",
    address2: null,
    town: "Lyon",
    postcode: "69007",
    countryCode: "FR",
    isActive: true,
    primaryContact: {
      id: `contact-${id}`,
      name: "Claire Martin",
      jobTitle: null,
      email: "claire@example.test",
      mobile: "+33600000001",
    },
    banking: {
      accountHolderName: "SUPPLIER TEST",
      iban: "FR7630006000011234567890189",
      bic: "AGRIFRPPXXX",
      bankName: "Banque Test",
      bankingVerificationStatus: "verified",
      bankingVerifiedAt: "2026-08-20T14:32:00Z",
      bankingVerifiedBy: {
        id: "verifier-1",
        displayName: "Verifier",
      },
      bankingVerificationMethod: "manual_rib_review",
      ribDocument: {
        id: `rib-${id}`,
        fileName: "rib.pdf",
        mimeType: "application/pdf",
        sha256: "a".repeat(64),
        downloadPath:
          `/api/integrations/architrak/v1/suppliers/${id}/rib/rib-${id}`,
        updatedAt: "2026-08-20T14:32:00Z",
      },
    },
    projectPaymentAssignments: assignment
      ? [
          {
            id: `assignment-${id}`,
            projectId: projectArchidocId,
            directPaymentStatus: "eligible",
            validFrom: "2026-08-01",
            validUntil: null,
            reason: null,
            updatedAt: "2026-08-24T09:12:00Z",
          },
        ]
      : [],
    updatedAt: "2026-08-24T09:12:00Z",
  };
}

function upsertWindow(
  sequence: string,
  values: SupplierPaymentReadinessSupplier[],
  mode: "bootstrap" | "incremental" = "incremental",
): SupplierPaymentReadinessWindow {
  return {
    mode,
    afterSequenceExclusive:
      mode === "incremental" ? (BigInt(sequence) - 1n).toString() : null,
    throughSequenceInclusive: sequence,
    minimumAvailableSequence: "1",
    changes: values.map((value, index) => ({
      sequence: (BigInt(sequence) - BigInt(values.length - index - 1)).toString(),
      operation: "upsert" as const,
      changedAt: "2026-08-24T09:12:00Z",
      supplier: value,
    })),
  };
}

beforeAll(async () => {
  sourceBaseUrl = new URL(env.ARCHIDOC_BASE_URL!).origin.toLowerCase();
  [previousCursor] = await db
    .select()
    .from(archidocSupplierPaymentCursor)
    .where(eq(archidocSupplierPaymentCursor.singletonKey, 1));
  const [project] = await db
    .insert(projects)
    .values({
      name: `Readiness project ${suffix}`,
      code: `R-${suffix}`,
      clientName: "Readiness client",
      status: "active",
      archidocId: projectArchidocId,
    })
    .returning();
  projectId = project.id;
});

afterAll(async () => {
  await db
    .delete(archidocSupplierPaymentAssignments)
    .where(eq(
      archidocSupplierPaymentAssignments.supplierArchidocId,
      supplierId,
    ));
  await db
    .delete(archidocSupplierPaymentAssignments)
    .where(eq(
      archidocSupplierPaymentAssignments.supplierArchidocId,
      secondSupplierId,
    ));
  await db
    .delete(archidocSupplierPaymentReadiness)
    .where(eq(
      archidocSupplierPaymentReadiness.supplierArchidocId,
      supplierId,
    ));
  await db
    .delete(archidocSupplierPaymentReadiness)
    .where(eq(
      archidocSupplierPaymentReadiness.supplierArchidocId,
      secondSupplierId,
    ));
  await db
    .delete(archidocContractors)
    .where(eq(archidocContractors.archidocId, supplierId));
  await db
    .delete(archidocContractors)
    .where(eq(archidocContractors.archidocId, secondSupplierId));
  await db
    .delete(contractors)
    .where(eq(contractors.archidocId, supplierId));
  await db
    .delete(contractors)
    .where(eq(contractors.archidocId, secondSupplierId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db
    .delete(archidocSupplierPaymentCursor)
    .where(eq(archidocSupplierPaymentCursor.singletonKey, 1));
  if (previousCursor) {
    await db.insert(archidocSupplierPaymentCursor).values(previousCursor);
  }
});

describe("supplier payment-readiness mirror publication", () => {
  it("bootstraps, promotes canonical fields, and exposes a payment-safe snapshot", async () => {
    const sequence = "10000000000000000001";
    const result = await persistSupplierPaymentReadinessWindow(
      upsertWindow(sequence, [supplier(supplierId)], "bootstrap"),
      sourceBaseUrl,
    );
    expect(result).toEqual({ updated: 1, deleted: 0 });

    const snapshot = await storage.getSupplierPaymentReadinessSnapshot({
      supplierArchidocId: supplierId,
      projectArchidocId,
    });
    expect(snapshot).toMatchObject({
      provenance: {
        schemaVersion: "archidoc_supplier_payment_readiness_v1",
        sourceSequence: sequence,
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      supplier: {
        id: supplierId,
        isActive: true,
        banking: {
          bankingVerificationStatus: "verified",
          iban: "FR7630006000011234567890189",
        },
      },
      assignment: {
        projectId: projectArchidocId,
        directPaymentStatus: "eligible",
      },
    });
    const [canonical] = await db
      .select()
      .from(contractors)
      .where(eq(contractors.archidocId, supplierId));
    expect(canonical).toMatchObject({
      archidocPartnerType: "supplier",
      siret: "73282932000074",
      iban: "FR7630006000011234567890189",
      archidocOrphanedAt: null,
    });
  });

  it("replays the same sequence idempotently and replaces assignments atomically", async () => {
    const sequence = "10000000000000000001";
    const replay = await persistSupplierPaymentReadinessWindow(
      upsertWindow(sequence, [supplier(supplierId)]),
      sourceBaseUrl,
    );
    expect(replay).toEqual({ updated: 0, deleted: 0 });

    await persistSupplierPaymentReadinessWindow(
      upsertWindow("10000000000000000002", [
        supplier(supplierId, false),
      ]),
      sourceBaseUrl,
    );
    const assignments = await db
      .select()
      .from(archidocSupplierPaymentAssignments)
      .where(eq(
        archidocSupplierPaymentAssignments.supplierArchidocId,
        supplierId,
      ));
    expect(assignments).toEqual([]);
    const snapshot = await storage.getSupplierPaymentReadinessSnapshot({
      supplierArchidocId: supplierId,
      projectArchidocId,
    });
    expect(snapshot?.assignment).toBeNull();
  });

  it("rejects changed content that reuses an existing supplier sequence", async () => {
    const changed = supplier(supplierId, false);
    changed.name = "Conflicting replay";
    await expect(
      persistSupplierPaymentReadinessWindow(
        upsertWindow("10000000000000000002", [changed]),
        sourceBaseUrl,
      ),
    ).rejects.toThrow(/reused sequence .* with different content/);
    const [cursor] = await db
      .select()
      .from(archidocSupplierPaymentCursor)
      .where(eq(archidocSupplierPaymentCursor.singletonKey, 1));
    expect(cursor.lastSequence).toBe("10000000000000000002");
  });

  it("soft-deletes explicit tombstones and permits a later higher-sequence resurrection", async () => {
    await persistSupplierPaymentReadinessWindow(
      {
        mode: "incremental",
        afterSequenceExclusive: "10000000000000000002",
        throughSequenceInclusive: "10000000000000000003",
        minimumAvailableSequence: "1",
        changes: [
          {
            sequence: "10000000000000000003",
            operation: "delete",
            changedAt: "2026-08-24T10:00:00Z",
            supplierId,
          },
        ],
      },
      sourceBaseUrl,
    );
    expect(
      await storage.getSupplierPaymentReadinessSnapshot({
        supplierArchidocId: supplierId,
        projectArchidocId,
      }),
    ).toBeUndefined();
    const [orphaned] = await db
      .select()
      .from(contractors)
      .where(eq(contractors.archidocId, supplierId));
    expect(orphaned.archidocOrphanedAt).not.toBeNull();

    await persistSupplierPaymentReadinessWindow(
      upsertWindow("10000000000000000004", [supplier(supplierId)]),
      sourceBaseUrl,
    );
    const [restored] = await db
      .select()
      .from(contractors)
      .where(eq(contractors.archidocId, supplierId));
    expect(restored.archidocOrphanedAt).toBeNull();
  });

  it("reconciles bootstrap absence but refuses a suspicious total wipe", async () => {
    await persistSupplierPaymentReadinessWindow(
      upsertWindow("10000000000000000005", [
        supplier(secondSupplierId),
      ]),
      sourceBaseUrl,
    );
    await persistSupplierPaymentReadinessWindow(
      upsertWindow(
        "10000000000000000006",
        [supplier(supplierId)],
        "bootstrap",
      ),
      sourceBaseUrl,
    );
    const [second] = await db
      .select()
      .from(archidocSupplierPaymentReadiness)
      .where(eq(
        archidocSupplierPaymentReadiness.supplierArchidocId,
        secondSupplierId,
      ));
    expect(second.isDeleted).toBe(true);

    await expect(
      persistSupplierPaymentReadinessWindow(
        {
          mode: "bootstrap",
          afterSequenceExclusive: null,
          throughSequenceInclusive: "10000000000000000007",
          minimumAvailableSequence: "1",
          changes: [],
        },
        sourceBaseUrl,
      ),
    ).rejects.toThrow(/Refused supplier payment-readiness bootstrap/);
    const [cursor] = await db
      .select()
      .from(archidocSupplierPaymentCursor)
      .where(eq(archidocSupplierPaymentCursor.singletonKey, 1));
    expect(cursor.lastSequence).toBe("10000000000000000006");
  });

  it("waits on the exact project/supplier seal advisory-lock pair before publishing", async () => {
    const [canonical] = await db
      .select({ id: contractors.id })
      .from(contractors)
      .where(eq(contractors.archidocId, supplierId));
    const client = await pool.connect();
    let released = false;
    try {
      await client.query(
        "select pg_advisory_lock($1::integer, $2::integer)",
        [projectId, canonical.id],
      );
      const changed = supplier(supplierId);
      changed.name = "Published after seal lock";
      let settled = false;
      const publication =
        persistSupplierPaymentReadinessWindow(
          upsertWindow("10000000000000000007", [changed]),
          sourceBaseUrl,
        ).finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      await client.query(
        "select pg_advisory_unlock($1::integer, $2::integer)",
        [projectId, canonical.id],
      );
      released = true;
      await expect(publication).resolves.toEqual({
        updated: 1,
        deleted: 0,
      });
    } finally {
      if (!released) {
        await client.query(
          "select pg_advisory_unlock($1::integer, $2::integer)",
          [projectId, canonical.id],
        );
      }
      client.release();
    }
  });

  it("refuses cursor regression inside the publication transaction", async () => {
    await expect(
      persistSupplierPaymentReadinessWindow(
        {
          mode: "incremental",
          afterSequenceExclusive: "10000000000000000005",
          throughSequenceInclusive: "10000000000000000006",
          minimumAvailableSequence: "1",
          changes: [],
        },
        sourceBaseUrl,
      ),
    ).rejects.toThrow(/cursor regression was refused/);
    const [cursor] = await db
      .select()
      .from(archidocSupplierPaymentCursor)
      .where(eq(archidocSupplierPaymentCursor.singletonKey, 1));
    expect(cursor.lastSequence).toBe("10000000000000000007");
  });

  it("blocks legacy overwrites by readiness ownership even when partnerType is missing or wrong", async () => {
    await upsertContractor({
      id: supplierId,
      name: "Legacy overwrite without discriminator",
    });
    await upsertContractor({
      id: supplierId,
      name: "Legacy overwrite misclassified",
      partnerType: "contractor",
    });
    const [canonical] = await db
      .select()
      .from(contractors)
      .where(eq(contractors.archidocId, supplierId));
    const [mirror] = await db
      .select()
      .from(archidocContractors)
      .where(eq(archidocContractors.archidocId, supplierId));
    expect(canonical.name).toBe("Published after seal lock");
    expect(mirror.name).toBe("Published after seal lock");
  });

  it("keeps an overlapping supplier active when a new source bootstrap claims the same ID", async () => {
    const previousSource = "https://previous-archidoc.example.test";
    await db
      .update(archidocSupplierPaymentReadiness)
      .set({ sourceBaseUrl: previousSource })
      .where(eq(
        archidocSupplierPaymentReadiness.supplierArchidocId,
        supplierId,
      ));
    await db
      .update(archidocSupplierPaymentCursor)
      .set({ sourceBaseUrl: previousSource })
      .where(eq(archidocSupplierPaymentCursor.singletonKey, 1));

    const repointed = supplier(supplierId);
    repointed.name = "Supplier from current source";
    await expect(
      persistSupplierPaymentReadinessWindow(
        upsertWindow(
          "10000000000000000008",
          [repointed],
          "bootstrap",
        ),
        sourceBaseUrl,
      ),
    ).resolves.toEqual({ updated: 1, deleted: 0 });

    const [readiness] = await db
      .select()
      .from(archidocSupplierPaymentReadiness)
      .where(eq(
        archidocSupplierPaymentReadiness.supplierArchidocId,
        supplierId,
      ));
    const [canonical] = await db
      .select()
      .from(contractors)
      .where(eq(contractors.archidocId, supplierId));
    const assignments = await db
      .select()
      .from(archidocSupplierPaymentAssignments)
      .where(eq(
        archidocSupplierPaymentAssignments.supplierArchidocId,
        supplierId,
      ));
    const snapshot = await storage.getSupplierPaymentReadinessSnapshot({
      supplierArchidocId: supplierId,
      projectArchidocId,
    });
    expect(readiness).toMatchObject({
      sourceBaseUrl,
      isDeleted: false,
      deletedAt: null,
    });
    expect(canonical).toMatchObject({
      name: "Supplier from current source",
      archidocOrphanedAt: null,
    });
    expect(assignments).toHaveLength(1);
    expect(snapshot?.assignment?.projectId).toBe(projectArchidocId);
  });
});