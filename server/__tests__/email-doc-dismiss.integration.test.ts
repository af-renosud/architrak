/**
 * Task #421 — "not relevant" dismissal of email-queue documents.
 *
 *  - dismissal marks skipped + tombstoned, removes the intake mirror and its
 *    queue job, and nothing resurrects them afterwards;
 *  - a document promoted into a typed record (via mirror or direct link) is
 *    refused with DismissRefusedError;
 *  - dismissal is idempotent; skipped immutability (Task #322) is preserved.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { storage } from "../storage";
import { db } from "../db";
import { emailDocuments, projectIntakeDocuments, intakeJobs } from "@shared/schema";
import { eq, like } from "drizzle-orm";

vi.mock("../storage/object-storage", () => ({
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  uploadDocument: vi.fn(),
  getDocumentStream: vi.fn(),
}));

import { dismissEmailDocument, DismissRefusedError } from "../services/email-document-dismiss.service";
import { deleteDocument } from "../storage/object-storage";

const MSG_ID = "test-421-dismiss";

afterAll(async () => {
  // Mirror rows reference the email docs — remove them first (FK).
  const seeded = await db.select({ id: emailDocuments.id }).from(emailDocuments)
    .where(like(emailDocuments.emailMessageId, `${MSG_ID}%`));
  for (const { id } of seeded) {
    await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.sourceEmailDocumentId, id));
  }
  await db.delete(emailDocuments).where(like(emailDocuments.emailMessageId, `${MSG_ID}%`));
});

async function seedEmailDoc(suffix: string, overrides: Partial<typeof emailDocuments.$inferInsert> = {}) {
  const [row] = await db
    .insert(emailDocuments)
    .values({
      emailMessageId: `${MSG_ID}-${suffix}`,
      emailSubject: `Dismiss test ${suffix}`,
      attachmentFileName: `${suffix}.pdf`,
      storageKey: `.private/test-421-${suffix}.pdf`,
      extractionStatus: "needs_review",
      emailReceivedAt: new Date("2026-08-10T10:00:00Z"),
      ...overrides,
    } as typeof emailDocuments.$inferInsert)
    .returning();
  return row;
}

describe("email-document dismissal (Task #421)", () => {
  it("dismisses a queued doc: skipped + tombstone, mirror and job removed, storage cleaned, no resurrection", async () => {
    const projects = await storage.getProjects();
    const projectId = projects[0].id;
    const doc = await seedEmailDoc("full", { projectId });
    const [mirror] = await db
      .insert(projectIntakeDocuments)
      .values({
        projectId,
        fileName: "full.pdf",
        storageKey: doc.storageKey!,
        source: "gmail",
        sourceEmailDocumentId: doc.id,
      })
      .returning();
    await db.insert(intakeJobs).values({ intakeDocumentId: mirror.id });

    const result = await dismissEmailDocument(doc.id);
    expect(result.outcome).toBe("dismissed");

    const after = await storage.getEmailDocument(doc.id);
    expect(after?.extractionStatus).toBe("skipped");
    expect(after?.intakeDeletedAt).not.toBeNull();
    expect(
      await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.sourceEmailDocumentId, doc.id)),
    ).toHaveLength(0);
    expect(await db.select().from(intakeJobs).where(eq(intakeJobs.intakeDocumentId, mirror.id))).toHaveLength(0);
    expect(deleteDocument).toHaveBeenCalledWith(doc.storageKey);

    // No resurrection: project re-assignment must not recreate the mirror,
    // and the processor claim must refuse the skipped doc.
    await storage.updateEmailDocument(doc.id, { projectId } as never);
    expect(
      await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.sourceEmailDocumentId, doc.id)),
    ).toHaveLength(0);
    expect(await storage.claimEmailDocumentForProcessing(doc.id, new Date("2026-08-01T00:00:00Z"))).toBeUndefined();

    // Idempotent second dismissal.
    const again = await dismissEmailDocument(doc.id);
    expect(again.outcome).toBe("already_dismissed");
  });

  it("refuses when the intake mirror was promoted into a typed record", async () => {
    const projects = await storage.getProjects();
    const projectId = projects[0].id;
    const doc = await seedEmailDoc("promoted", { projectId });
    await db.insert(projectIntakeDocuments).values({
      projectId,
      fileName: "promoted.pdf",
      storageKey: doc.storageKey!,
      source: "gmail",
      sourceEmailDocumentId: doc.id,
      routingState: "routed",
      promotedKind: "devis",
      promotedId: 999999,
    });

    await expect(dismissEmailDocument(doc.id)).rejects.toThrow(DismissRefusedError);
    expect((await storage.getEmailDocument(doc.id))?.extractionStatus).toBe("needs_review");
    expect(
      await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.sourceEmailDocumentId, doc.id)),
    ).toHaveLength(1);
  });

  it("refuses when the email document is directly linked to a devis or facture", async () => {
    const anyDevis = await db.query.devis.findFirst();
    if (!anyDevis) return; // dev DB without devis — covered by the mirror guard test
    const doc = await seedEmailDoc("linked", { devisId: anyDevis.id });
    await expect(dismissEmailDocument(doc.id)).rejects.toThrow(DismissRefusedError);
    expect((await storage.getEmailDocument(doc.id))?.extractionStatus).toBe("needs_review");
  });

  it("keeps the storage object when another row still references the same key", async () => {
    const sharedKey = ".private/test-421-shared.pdf";
    const keeper = await seedEmailDoc("shared-keeper", { storageKey: sharedKey });
    const doomed = await seedEmailDoc("shared-doomed", { storageKey: sharedKey });
    vi.mocked(deleteDocument).mockClear();

    const result = await dismissEmailDocument(doomed.id);
    expect(result.outcome).toBe("dismissed");
    expect(deleteDocument).not.toHaveBeenCalled();
    expect((await storage.getEmailDocument(keeper.id))?.extractionStatus).toBe("needs_review");
  });

  it("refuses while the doc is mid-processing or its mirror is mid-analysis", async () => {
    const processing = await seedEmailDoc("processing", { extractionStatus: "processing" });
    await expect(dismissEmailDocument(processing.id)).rejects.toThrow(DismissRefusedError);

    const projects = await storage.getProjects();
    const projectId = projects[0].id;
    const analyzed = await seedEmailDoc("analyzing", { projectId });
    await db.insert(projectIntakeDocuments).values({
      projectId,
      fileName: "analyzing.pdf",
      storageKey: analyzed.storageKey!,
      source: "gmail",
      sourceEmailDocumentId: analyzed.id,
      analysisState: "analyzing",
    });
    await expect(dismissEmailDocument(analyzed.id)).rejects.toThrow(DismissRefusedError);
    expect(
      await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.sourceEmailDocumentId, analyzed.id)),
    ).toHaveLength(1);
  });

  it("returns not_found for a missing id", async () => {
    expect((await dismissEmailDocument(99999999)).outcome).toBe("not_found");
  });
});
