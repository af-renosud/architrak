import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import { emailDocuments, projectIntakeDocuments, projects, architectFeeInvoices, projectDocuments, situations, marcheDocuments, devis, contractors } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";

// Task #550 — permanent purge of skipped email documents + bulk dismissal
// guards. Runs against the dev database.

const createdDocIds: number[] = [];
let projectId: number;

const OLD = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
const FRESH = new Date();

async function insertDoc(over: Partial<typeof emailDocuments.$inferInsert> = {}): Promise<number> {
  const [row] = await db.insert(emailDocuments).values({
    emailMessageId: `t550-${Math.random().toString(36).slice(2)}`,
    emailFrom: "t550@test.local",
    emailSubject: "T550",
    attachmentFileName: "t550.pdf",
    storageKey: null,
    documentType: "unknown",
    extractionStatus: "skipped",
    updatedAt: OLD,
    ...over,
  }).returning({ id: emailDocuments.id });
  createdDocIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const [p] = await db.insert(projects).values({ name: "T550 Project", code: `T550-${Date.now()}`, clientName: "T550 Client" }).returning();
  projectId = p.id;
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(projectIntakeDocuments).where(inArray(projectIntakeDocuments.sourceEmailDocumentId, createdDocIds));
    await db.delete(emailDocuments).where(inArray(emailDocuments.id, createdDocIds));
  }
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("purgeExpiredSkippedEmailDocuments", () => {
  it("purges old skipped rows but keeps fresh ones", async () => {
    const oldId = await insertDoc();
    const freshId = await insertDoc({ updatedAt: FRESH });
    const purged = await storage.purgeExpiredSkippedEmailDocuments(30 * 24 * 60 * 60 * 1000, 500);
    const purgedIds = purged.map(r => r.id);
    expect(purgedIds).toContain(oldId);
    expect(purgedIds).not.toContain(freshId);
    const [gone] = await db.select().from(emailDocuments).where(eq(emailDocuments.id, oldId));
    expect(gone).toBeUndefined();
    const [kept] = await db.select().from(emailDocuments).where(eq(emailDocuments.id, freshId));
    expect(kept).toBeDefined();
  });

  it("never purges a doc linked to a devis/facture or non-skipped rows", async () => {
    const activeId = await insertDoc({ extractionStatus: "pending" });
    const purged = await storage.purgeExpiredSkippedEmailDocuments(30 * 24 * 60 * 60 * 1000, 500);
    expect(purged.map(r => r.id)).not.toContain(activeId);
    const [kept] = await db.select().from(emailDocuments).where(eq(emailDocuments.id, activeId));
    expect(kept).toBeDefined();
  });

  it("never purges a doc whose intake mirror was promoted", async () => {
    const id = await insertDoc();
    await db.insert(projectIntakeDocuments).values({
      projectId,
      sourceEmailDocumentId: id,
      storageKey: `t550-mirror-${id}`,
      fileName: "t550.pdf",
      promotedKind: "devis",
      promotedId: 999999,
    });
    const purged = await storage.purgeExpiredSkippedEmailDocuments(30 * 24 * 60 * 60 * 1000, 500);
    expect(purged.map(r => r.id)).not.toContain(id);
    const [kept] = await db.select().from(emailDocuments).where(eq(emailDocuments.id, id));
    expect(kept).toBeDefined();
  });

  it("on-demand purge deletes a single skipped row regardless of age", async () => {
    const id = await insertDoc({ updatedAt: FRESH });
    const row = await storage.purgeSkippedEmailDocumentAtomically(id);
    expect(row?.id).toBe(id);
    const [gone] = await db.select().from(emailDocuments).where(eq(emailDocuments.id, id));
    expect(gone).toBeUndefined();
  });

  it("never purges a doc referenced by an architect fee invoice (provenance)", async () => {
    const id = await insertDoc();
    const [fee] = await db.insert(architectFeeInvoices).values({
      emailDocumentId: id,
      projectId,
      amountHt: "100.00",
    } as any).returning({ id: architectFeeInvoices.id });
    try {
      const row = await storage.purgeSkippedEmailDocumentAtomically(id);
      expect(row).toBeNull();
      const [kept] = await db.select().from(emailDocuments).where(eq(emailDocuments.id, id));
      expect(kept).toBeDefined();
    } finally {
      await db.delete(architectFeeInvoices).where(eq(architectFeeInvoices.id, fee.id));
    }
  });

  it("never purges when a fee invoice references the intake mirror (provenance)", async () => {
    const id = await insertDoc();
    const [mirror] = await db.insert(projectIntakeDocuments).values({
      projectId,
      sourceEmailDocumentId: id,
      storageKey: `t550-mirror-fee-${id}`,
      fileName: "t550.pdf",
    }).returning({ id: projectIntakeDocuments.id });
    const [fee] = await db.insert(architectFeeInvoices).values({
      projectId,
      amountHt: "100.00",
      intakeDocumentId: mirror.id,
    } as any).returning({ id: architectFeeInvoices.id });
    try {
      const row = await storage.purgeSkippedEmailDocumentAtomically(id);
      expect(row).toBeNull();
      const [keptDoc] = await db.select().from(emailDocuments).where(eq(emailDocuments.id, id));
      expect(keptDoc).toBeDefined();
      const [keptMirror] = await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, mirror.id));
      expect(keptMirror).toBeDefined();
    } finally {
      await db.delete(architectFeeInvoices).where(eq(architectFeeInvoices.id, fee.id));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, mirror.id));
    }
  });

  it("never purges when a marché document references the intake mirror (provenance)", async () => {
    const id = await insertDoc();
    const [mirror] = await db.insert(projectIntakeDocuments).values({
      projectId,
      sourceEmailDocumentId: id,
      storageKey: `t550-mirror-md-${id}`,
      fileName: "t550.pdf",
    }).returning({ id: projectIntakeDocuments.id });
    const [md] = await db.insert(marcheDocuments).values({
      projectId,
      fileName: "t550-md.pdf",
      storageKey: `t550-md-${id}`,
      sourceIntakeDocumentId: mirror.id,
    } as any).returning({ id: marcheDocuments.id });
    try {
      const row = await storage.purgeSkippedEmailDocumentAtomically(id);
      expect(row).toBeNull();
      const [keptMirror] = await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, mirror.id));
      expect(keptMirror).toBeDefined();
    } finally {
      await db.delete(marcheDocuments).where(eq(marcheDocuments.id, md.id));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, mirror.id));
    }
  });

  it("soft dismissal refuses when the mirror backs a fee invoice", async () => {
    const id = await insertDoc({ extractionStatus: "needs_review", updatedAt: FRESH });
    const [mirror] = await db.insert(projectIntakeDocuments).values({
      projectId,
      sourceEmailDocumentId: id,
      storageKey: `t550-mirror-soft-${id}`,
      fileName: "t550.pdf",
    }).returning({ id: projectIntakeDocuments.id });
    const [fee] = await db.insert(architectFeeInvoices).values({
      projectId,
      amountHt: "100.00",
      intakeDocumentId: mirror.id,
    } as any).returning({ id: architectFeeInvoices.id });
    try {
      const result = await storage.dismissEmailDocumentAtomically(id);
      expect(result.outcome).toBe("refused");
      const [keptMirror] = await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, mirror.id));
      expect(keptMirror).toBeDefined();
      const [keptDoc] = await db.select().from(emailDocuments).where(eq(emailDocuments.id, id));
      expect(keptDoc?.extractionStatus).toBe("needs_review");
    } finally {
      await db.delete(architectFeeInvoices).where(eq(architectFeeInvoices.id, fee.id));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, mirror.id));
    }
  });

  it("never purges a doc referenced by a project document (provenance)", async () => {
    const id = await insertDoc();
    const [pd] = await db.insert(projectDocuments).values({
      projectId,
      fileName: "t550-pd.pdf",
      storageKey: `t550-pd-${id}`,
      sourceEmailDocumentId: id,
    }).returning({ id: projectDocuments.id });
    try {
      const row = await storage.purgeSkippedEmailDocumentAtomically(id);
      expect(row).toBeNull();
      const [kept] = await db.select().from(emailDocuments).where(eq(emailDocuments.id, id));
      expect(kept).toBeDefined();
    } finally {
      await db.delete(projectDocuments).where(eq(projectDocuments.id, pd.id));
    }
  });

  it("storage-key reference check covers architect fee invoices", async () => {
    const key = `t550-shared-${Date.now()}`;
    const id = await insertDoc({ storageKey: key });
    const [fee] = await db.insert(architectFeeInvoices).values({
      projectId,
      amountHt: "100.00",
      storageKey: key,
    } as any).returning({ id: architectFeeInvoices.id });
    try {
      expect(await storage.isStorageKeyReferencedElsewhere(key, id)).toBe(true);
    } finally {
      await db.delete(architectFeeInvoices).where(eq(architectFeeInvoices.id, fee.id));
    }
  });

  it("on-demand purge refuses non-skipped rows", async () => {
    const id = await insertDoc({ extractionStatus: "needs_review", updatedAt: FRESH });
    const row = await storage.purgeSkippedEmailDocumentAtomically(id);
    expect(row).toBeNull();
  });
});

describe("app settings", () => {
  it("get/set round-trips and upserts", async () => {
    await storage.setAppSetting("t550_test_key", "42");
    expect(await storage.getAppSetting("t550_test_key")).toBe("42");
    await storage.setAppSetting("t550_test_key", "7");
    expect(await storage.getAppSetting("t550_test_key")).toBe("7");
    await db.execute(`DELETE FROM app_settings WHERE key = 't550_test_key'` as any);
  });

  it("missing key returns null", async () => {
    expect(await storage.getAppSetting("t550_never_set")).toBeNull();
  });
});
