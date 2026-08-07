/**
 * Task #322 — terminal 'skipped' guarantee (real database).
 *
 * The dumped beta backlog must be un-revivable:
 *  - the generic PATCH schema physically cannot carry extractionStatus;
 *  - the storage layer refuses status writes on a skipped doc even if a
 *    caller bypasses the route schema;
 *  - assigning a project to a skipped doc must NOT mirror it into intake.
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { insertEmailDocumentSchema } from "@shared/schema";
import { storage } from "../storage";
import { db } from "../db";
import { emailDocuments, projectIntakeDocuments, intakeJobs } from "@shared/schema";
import { eq, like } from "drizzle-orm";
import { sql } from "drizzle-orm";

const MSG_ID = "test-322-skipped-immutable";

afterAll(async () => {
  await db.delete(emailDocuments).where(like(emailDocuments.emailMessageId, `${MSG_ID}%`));
});

describe("skipped email documents are terminal (Task #322)", () => {
  it("generic PATCH schema strips extractionStatus", () => {
    const schema = insertEmailDocumentSchema.partial().omit({ extractionStatus: true });
    const parsed = schema.safeParse({ extractionStatus: "pending", notes: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("extractionStatus" in parsed.data).toBe(false);
      expect(parsed.data.notes).toBe("x");
    }
  });

  it("storage refuses to revive a skipped doc and never mirrors it into intake", async () => {
    const [row] = await db
      .insert(emailDocuments)
      .values({
        emailMessageId: MSG_ID,
        emailSubject: "Dumped backlog doc",
        attachmentFileName: "old.pdf",
        storageKey: ".private/test-322-old.pdf",
        extractionStatus: "skipped",
        emailReceivedAt: new Date("2026-08-05T10:00:00Z"),
      } as typeof emailDocuments.$inferInsert)
      .returning();

    // Attempted revival: status write is dropped, project assignment kept.
    const updated = await storage.updateEmailDocument(row.id, {
      extractionStatus: "pending",
      projectId: null,
      notes: "revival attempt",
    } as never);
    expect(updated?.extractionStatus).toBe("skipped");
    expect(updated?.notes).toBe("revival attempt");

    // Assigning a project must not mirror a skipped doc into intake.
    const projects = await storage.getProjects();
    expect(projects.length).toBeGreaterThan(0);
    await storage.updateEmailDocument(row.id, { projectId: projects[0].id } as never);
    const mirrored = await db
      .select()
      .from(projectIntakeDocuments)
      .where(eq(projectIntakeDocuments.sourceEmailDocumentId, row.id));
    expect(mirrored).toHaveLength(0);

    const final = await storage.getEmailDocument(row.id);
    expect(final?.extractionStatus).toBe("skipped");
  });

  it("atomic claim and retry-state writes cannot revive a skipped doc (Task #322)", async () => {
    const [row] = await db
      .insert(emailDocuments)
      .values({
        emailMessageId: `${MSG_ID}-claim`,
        emailSubject: "Dumped doc — claim attempts",
        attachmentFileName: "old2.pdf",
        storageKey: ".private/test-322-old2.pdf",
        extractionStatus: "skipped",
        // Even a post-watermark received-at must not make a skipped doc claimable.
        emailReceivedAt: new Date("2026-08-12T10:00:00Z"),
      } as typeof emailDocuments.$inferInsert)
      .returning();

    // Direct claim: predicate rejects skipped regardless of watermark.
    const claimed = await storage.claimEmailDocumentForProcessing(row.id, new Date("2026-08-10T07:00:00Z"));
    expect(claimed).toBeUndefined();

    // Direct retry bookkeeping: only applies to a row currently 'processing'.
    await storage.setEmailDocumentRetryState(row.id, {
      extractionStatus: "pending",
      processingAttempts: 0,
      nextProcessAttemptAt: null,
    });
    expect((await storage.getEmailDocument(row.id))?.extractionStatus).toBe("skipped");

    // Pre-watermark pending doc is equally unclaimable at the SQL level.
    const [oldPending] = await db
      .insert(emailDocuments)
      .values({
        emailMessageId: `${MSG_ID}-prewm`,
        emailSubject: "Pre-watermark pending",
        attachmentFileName: "old3.pdf",
        storageKey: ".private/test-322-old3.pdf",
        extractionStatus: "pending",
        emailReceivedAt: new Date("2026-08-01T10:00:00Z"),
      } as typeof emailDocuments.$inferInsert)
      .returning();
    expect(await storage.claimEmailDocumentForProcessing(oldPending.id, new Date("2026-08-10T07:00:00Z"))).toBeUndefined();
    expect((await storage.getEmailDocument(oldPending.id))?.extractionStatus).toBe("pending");
  });

  it("migrations 0057+0058 dump a queued pre-watermark doc AND remove its intake mirror/job", async () => {
    const projects = await storage.getProjects();
    const projectId = projects[0].id;

    // Seed: pre-watermark pending email doc already assigned a project,
    // with an existing intake mirror and a queued intake job.
    const [emailDoc] = await db
      .insert(emailDocuments)
      .values({
        emailMessageId: `${MSG_ID}-migration`,
        emailSubject: "Backlog doc with intake mirror",
        attachmentFileName: "backlog.pdf",
        storageKey: ".private/test-322-backlog.pdf",
        extractionStatus: "pending",
        emailReceivedAt: new Date("2026-08-01T10:00:00Z"),
        projectId,
      } as typeof emailDocuments.$inferInsert)
      .returning();
    const [mirror] = await db
      .insert(projectIntakeDocuments)
      .values({
        projectId,
        fileName: "backlog.pdf",
        storageKey: ".private/test-322-backlog.pdf",
        source: "email",
        sourceEmailDocumentId: emailDoc.id,
      })
      .returning();
    await db.insert(intakeJobs).values({ intakeDocumentId: mirror.id });

    // Re-apply the (idempotent) data migrations.
    for (const file of ["0057_email_backlog_dump.sql", "0058_email_backlog_intake_cleanup.sql"]) {
      for (const stmt of readFileSync(`migrations/${file}`, "utf8").split("--> statement-breakpoint")) {
        await db.execute(sql.raw(stmt));
      }
    }

    // Dumped, tombstoned, mirror + queue row gone.
    const after = await storage.getEmailDocument(emailDoc.id);
    expect(after?.extractionStatus).toBe("skipped");
    expect(after?.intakeDeletedAt).not.toBeNull();
    expect(
      await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.sourceEmailDocumentId, emailDoc.id)),
    ).toHaveLength(0);
    expect(await db.select().from(intakeJobs).where(eq(intakeJobs.intakeDocumentId, mirror.id))).toHaveLength(0);

    // And no path recreates the mirror afterwards (tombstone + skipped guards).
    await storage.updateEmailDocument(emailDoc.id, { projectId } as never);
    expect(
      await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.sourceEmailDocumentId, emailDoc.id)),
    ).toHaveLength(0);
    await expect(
      (await import("../gmail/document-parser")).processEmailDocument(emailDoc.id),
    ).rejects.toThrow(/abandonné/);
  });
});
