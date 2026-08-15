// Task #503 — retention policy per parked status, against the real dev DB:
// 'low_relevance' and 'unmatched_sender' auto-expire to terminal 'skipped'
// with an audit note after the retention window; 'archived_project_candidate'
// is kept indefinitely (a late invoice for a closed project must not vanish).
import { describe, it, expect, afterAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import { emailDocuments, gmailProcessedMessages } from "@shared/schema";
import { eq, inArray, like } from "drizzle-orm";

const MARK = `test-503-retention-${Date.now()}`;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function seed(status: string, ageMs: number): Promise<number> {
  const [row] = await db
    .insert(emailDocuments)
    .values({
      emailMessageId: `${MARK}-${status}-${ageMs}`,
      emailSubject: "retention test",
      attachmentFileName: "t.pdf",
      storageKey: `.private/${MARK}.pdf`,
      extractionStatus: status,
      notes: "Motif initial.",
      emailReceivedAt: new Date(Date.now() - ageMs),
      createdAt: new Date(Date.now() - ageMs),
    } as typeof emailDocuments.$inferInsert)
    .returning();
  return row.id;
}

const CURSOR_USER = 999_503;

afterAll(async () => {
  await db.delete(emailDocuments).where(like(emailDocuments.emailMessageId, `${MARK}%`));
  await db.delete(gmailProcessedMessages).where(eq(gmailProcessedMessages.userId, CURSOR_USER));
});

describe("getGmailBackfillCursor watermark clamp (Task #503)", () => {
  it("pre-watermark processed rows never collapse the cursor below the cutoff", async () => {
    const cutoff = new Date("2026-08-10T07:00:00Z");
    const preWatermark = new Date("2025-06-01T00:00:00Z");
    const oldestValid = new Date("2026-08-11T09:00:00Z");
    const newer = new Date("2026-08-14T12:00:00Z");
    await storage.recordGmailMessageProcessed(CURSOR_USER, `${MARK}-pre`, preWatermark);
    await storage.recordGmailMessageProcessed(CURSOR_USER, `${MARK}-valid`, oldestValid);
    await storage.recordGmailMessageProcessed(CURSOR_USER, `${MARK}-new`, newer);
    await storage.recordGmailMessageProcessed(CURSOR_USER, `${MARK}-nodate`, null);

    // Unclamped: the pre-watermark row wins (this is the failure mode).
    expect((await storage.getGmailBackfillCursor(CURSOR_USER))?.getTime()).toBe(preWatermark.getTime());
    // Clamped to the cutoff: the oldest POST-cutoff row wins, so the
    // backfill query still runs and drains valid backlog behind it.
    const clamped = await storage.getGmailBackfillCursor(CURSOR_USER, cutoff);
    expect(clamped?.getTime()).toBe(oldestValid.getTime());
    expect(clamped!.getTime()).toBeGreaterThan(cutoff.getTime());
  });
});

describe("expireStaleParkedEmailDocuments (Task #503)", () => {
  it("expires only stale low_relevance/unmatched_sender, keeps archived candidates and fresh docs", async () => {
    const OLD = THIRTY_DAYS_MS + 24 * 60 * 60 * 1000;
    const FRESH = 24 * 60 * 60 * 1000;
    const ids = {
      lowOld: await seed("low_relevance", OLD),
      unmatchedOld: await seed("unmatched_sender", OLD),
      archivedOld: await seed("archived_project_candidate", OLD),
      lowFresh: await seed("low_relevance", FRESH),
      pendingOld: await seed("pending", OLD),
    };

    const count = await storage.expireStaleParkedEmailDocuments(THIRTY_DAYS_MS);
    expect(count).toBeGreaterThanOrEqual(2);

    const rows = await db
      .select()
      .from(emailDocuments)
      .where(inArray(emailDocuments.id, Object.values(ids)));
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Expired: status flip + prepended audit note, original reason retained.
    for (const id of [ids.lowOld, ids.unmatchedOld]) {
      expect(byId.get(id)?.extractionStatus).toBe("skipped");
      expect(byId.get(id)?.notes).toContain("Auto-expiré");
      expect(byId.get(id)?.notes).toContain("Motif initial.");
    }
    // Kept: archived candidate (indefinite), fresh parked doc, pending doc.
    expect(byId.get(ids.archivedOld)?.extractionStatus).toBe("archived_project_candidate");
    expect(byId.get(ids.lowFresh)?.extractionStatus).toBe("low_relevance");
    expect(byId.get(ids.pendingOld)?.extractionStatus).toBe("pending");
  });
});
