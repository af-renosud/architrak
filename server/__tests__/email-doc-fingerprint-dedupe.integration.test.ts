/**
 * Task #531 — attachment content-hash dedupe against the real database:
 *  - createEmailDocument stores the fingerprint;
 *  - getEmailDocumentByFingerprint finds the row;
 *  - a second insert with the same fingerprint violates the UNIQUE index
 *    (the capture path turns that into an additional-source append);
 *  - appendEmailDocumentSource is idempotent on emailMessageId;
 *  - appending a source to a SKIPPED doc leaves it skipped (Task #322).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../db";
import { emailDocuments } from "@shared/schema";
import { like } from "drizzle-orm";
import { storage } from "../storage";

const FP = "test531fingerprint-".padEnd(64, "a");
const MSG_PREFIX = "test-531-dedupe";

async function cleanup() {
  await db.delete(emailDocuments).where(like(emailDocuments.emailMessageId, `${MSG_PREFIX}%`));
}

beforeEach(cleanup);
afterAll(cleanup);

function baseDoc(suffix: string) {
  return {
    emailMessageId: `${MSG_PREFIX}-${suffix}`,
    emailSubject: "Devis",
    emailReceivedAt: new Date("2026-08-14T10:00:00Z"),
    attachmentFileName: "devis.pdf",
    storageKey: `.private/test-531-${suffix}.pdf`,
    extractionStatus: "pending" as const,
  };
}

describe("email document fingerprint dedupe (Task #531)", () => {
  it("stores the fingerprint, finds it, and rejects a duplicate insert", async () => {
    const doc = await storage.createEmailDocument({ ...baseDoc("a"), contentFingerprint: FP });
    expect(doc.contentFingerprint).toBe(FP);

    const found = await storage.getEmailDocumentByFingerprint(FP);
    expect(found?.id).toBe(doc.id);

    await expect(
      storage.createEmailDocument({ ...baseDoc("b"), contentFingerprint: FP }),
    ).rejects.toThrow();
  });

  it("appends sources idempotently and never revives a skipped doc", async () => {
    const doc = await storage.createEmailDocument({
      ...baseDoc("c"),
      extractionStatus: "skipped",
      contentFingerprint: FP,
    });

    const source = {
      emailMessageId: `${MSG_PREFIX}-copy`,
      emailFrom: "help@renosud.com",
      emailSubject: "Fwd: Devis",
      emailReceivedAt: "2026-08-14T11:00:00.000Z",
      emailLink: null,
    };
    await storage.appendEmailDocumentSource(doc.id, source);
    await storage.appendEmailDocumentSource(doc.id, source); // idempotent

    const [after] = await db.select().from(emailDocuments).where(like(emailDocuments.emailMessageId, `${MSG_PREFIX}-c`));
    expect(after.additionalSources).toHaveLength(1);
    expect(after.extractionStatus).toBe("skipped");
  });
});
