import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import {
  projectCommunications,
  certificats,
  certificatPaymentSuggestions,
  projects,
  contractors,
} from "@shared/schema";
import { eq, inArray } from "drizzle-orm";

/**
 * Task #529 — communications-hub archive ("fresh start") pins:
 *
 *  - archive is a visibility flag: getAllCommunications() defaults to
 *    active-only, "archived"/"all" views expose the rest, nothing is deleted;
 *  - a QUEUED communication cannot be archived (in-flight send);
 *  - only reviewed (confirmed/dismissed) suggestions can be archived;
 *  - fresh-start preview counts exactly what the run archives, and the run
 *    only touches sent comms + reviewed suggestions older than the cutoff.
 */

let projectId: number;
let contractorId: number;
let certId: number;
const commIds: number[] = [];
const suggestionIds: number[] = [];
let seq = 0;

async function makeComm(status: string, sentAt: Date | null): Promise<number> {
  const [row] = await db
    .insert(projectCommunications)
    .values({
      projectId,
      type: "certificat_sent",
      recipientType: "client",
      recipientEmail: "client@example.com",
      subject: `T529 comm ${seq++}`,
      status,
      sentAt,
      dedupeKey: `t529-${Date.now()}-${seq}-${Math.floor(Math.random() * 1e6)}`,
    })
    .returning();
  commIds.push(row.id);
  return row.id;
}

async function makeSuggestion(status: string, reviewedAt: Date | null): Promise<number> {
  const [row] = await db
    .insert(certificatPaymentSuggestions)
    .values({
      certificatId: certId,
      projectId,
      communicationId: 999999,
      emailMessageId: `t529-msg-${Date.now()}-${seq++}-${Math.floor(Math.random() * 1e6)}`,
      emailThreadId: "thread-t529",
      senderEmail: "client@example.com",
      emailDate: new Date("2026-01-10T09:00:00Z"),
      suggestedAmount: "100.00",
      suggestedDate: "2026-01-10",
      status,
      reviewedAt,
    })
    .returning();
  suggestionIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const [proj] = await db
    .insert(projects)
    .values({ name: "T529 Archive Test", code: `T529-${Date.now()}`, clientName: "Client T529" })
    .returning();
  projectId = proj.id;
  const [contractor] = await db.insert(contractors).values({ name: "T529 Contractor" }).returning();
  contractorId = contractor.id;
  const [cert] = await db
    .insert(certificats)
    .values({
      projectId,
      contractorId,
      certificateRef: `T529-${Date.now()}`,
      status: "sent",
      totalWorksHt: "100.00",
      netToPayHt: "100.00",
      netToPayTtc: "100.00",
      tvaAmount: "0.00",
    })
    .returning();
  certId = cert.id;
});

afterAll(async () => {
  if (suggestionIds.length) await db.delete(certificatPaymentSuggestions).where(inArray(certificatPaymentSuggestions.id, suggestionIds));
  if (commIds.length) await db.delete(projectCommunications).where(inArray(projectCommunications.id, commIds));
  await db.delete(certificats).where(eq(certificats.id, certId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("communication archive flag", () => {
  it("archives and unarchives a sent communication; views filter accordingly", async () => {
    const id = await makeComm("sent", new Date("2026-01-01T10:00:00Z"));

    const archived = await storage.setCommunicationArchived(id, true);
    expect(archived?.archivedAt).toBeTruthy();

    const active = await storage.getAllCommunications("active");
    expect(active.some(c => c.id === id)).toBe(false);
    const archivedView = await storage.getAllCommunications("archived");
    expect(archivedView.some(c => c.id === id)).toBe(true);
    const all = await storage.getAllCommunications("all");
    expect(all.some(c => c.id === id)).toBe(true);

    const restored = await storage.setCommunicationArchived(id, false);
    expect(restored?.archivedAt).toBeNull();
    const activeAgain = await storage.getAllCommunications("active");
    expect(activeAgain.some(c => c.id === id)).toBe(true);
  });

  it("refuses to archive a queued communication", async () => {
    const id = await makeComm("queued", null);
    const result = await storage.setCommunicationArchived(id, true);
    expect(result).toBeNull();
    const [row] = await db.select().from(projectCommunications).where(eq(projectCommunications.id, id));
    expect(row.archivedAt).toBeNull();
  });

  it("re-queueing an archived communication clears the archive flag (in-flight sends are never hidden)", async () => {
    const id = await makeComm("failed", new Date("2026-01-01T10:00:00Z"));
    const archived = await storage.setCommunicationArchived(id, true);
    expect(archived?.archivedAt).toBeTruthy();
    const requeued = await storage.updateProjectCommunication(id, { status: "queued" });
    expect(requeued?.archivedAt).toBeNull();
  });
});

describe("suggestion archive flag", () => {
  it("archives a dismissed suggestion but refuses an open one", async () => {
    const dismissedId = await makeSuggestion("dismissed", new Date("2026-01-05T10:00:00Z"));
    const openId = await makeSuggestion("pending_review", null);

    const archived = await storage.setPaymentSuggestionArchived(dismissedId, true);
    expect(archived?.archivedAt).toBeTruthy();

    const refused = await storage.setPaymentSuggestionArchived(openId, true);
    expect(refused).toBeNull();

    // open suggestion stays visible in the review queue regardless
    const openRows = await storage.getOpenPaymentSuggestionsWithContext();
    expect(openRows.some(r => r.suggestion.id === openId)).toBe(true);

    const restored = await storage.setPaymentSuggestionArchived(dismissedId, false);
    expect(restored?.archivedAt).toBeNull();
    // clean up the open one so the fresh-start test below is deterministic
    await db.delete(certificatPaymentSuggestions).where(eq(certificatPaymentSuggestions.id, openId));
    suggestionIds.splice(suggestionIds.indexOf(openId), 1);
  });
});

describe("fresh start bulk archive", () => {
  it("preview matches the run, and only sent comms + reviewed suggestions before the cutoff are archived", async () => {
    const cutoff = new Date("2026-02-01T00:00:00Z");

    const oldSent = await makeComm("sent", new Date("2026-01-15T10:00:00Z"));
    const newSent = await makeComm("sent", new Date("2026-03-15T10:00:00Z"));
    const oldFailed = await makeComm("failed", new Date("2026-01-15T10:00:00Z"));
    const oldQueued = await makeComm("queued", null);
    const oldConfirmed = await makeSuggestion("confirmed", new Date("2026-01-20T10:00:00Z"));
    const newDismissed = await makeSuggestion("dismissed", new Date("2026-03-20T10:00:00Z"));

    // Set drift where a previewed member LEAVES eligibility (equal counts
    // don't save it): the run bound to that preview must archive NOTHING.
    const swappedOut = await makeComm("sent", new Date("2026-01-10T10:00:00Z"));
    const withSwap = await storage.getFreshStartPreview(cutoff); // operator saw THIS set
    await storage.setCommunicationArchived(swappedOut, true); // one member leaves…
    const swappedIn = await makeComm("sent", new Date("2026-01-11T10:00:00Z")); // …while another becomes eligible (counts equal)
    const drifted = await storage.getFreshStartPreview(cutoff);
    expect(drifted.sentCommunications).toBe(withSwap.sentCommunications); // counts equal — count checks would miss this

    const staleResult = await storage.runFreshStartArchive(cutoff, withSwap.token);
    expect(staleResult.outcome).toBe("stale_preview");
    const [untouched] = await db.select().from(projectCommunications).where(eq(projectCommunications.id, oldSent));
    expect(untouched.archivedAt).toBeNull();
    const [swappedInRow] = await db.select().from(projectCommunications).where(eq(projectCommunications.id, swappedIn));
    expect(swappedInRow.archivedAt).toBeNull();
    // put the manually archived fixture back so it doesn't skew counts
    await storage.setCommunicationArchived(swappedOut, false);

    // Unknown token → stale_preview, nothing archived
    const bogus = await storage.runFreshStartArchive(cutoff, "not-a-real-token");
    expect(bogus.outcome).toBe("stale_preview");

    // A row that becomes eligible AFTER the preview (the phantom case) is
    // intentionally NOT archived — the run touches exactly the previewed set.
    const before = await storage.getFreshStartPreview(cutoff);
    const phantom = await makeComm("sent", new Date("2026-01-12T10:00:00Z"));
    const result = await storage.runFreshStartArchive(cutoff, before.token);
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("expected ok");
    expect(result.archivedCommunications).toBe(before.sentCommunications);
    expect(result.archivedSuggestions).toBe(before.reviewedSuggestions);
    expect(result.archivedCommunications).toBeGreaterThanOrEqual(1);
    expect(result.archivedSuggestions).toBeGreaterThanOrEqual(1);
    const [phantomRow] = await db.select().from(projectCommunications).where(eq(projectCommunications.id, phantom));
    expect(phantomRow.archivedAt).toBeNull(); // untouched — was never shown to the operator

    // one-shot token: replay must be refused
    const replay = await storage.runFreshStartArchive(cutoff, before.token);
    expect(replay.outcome).toBe("stale_preview");

    const comms = await db.select().from(projectCommunications).where(inArray(projectCommunications.id, [oldSent, newSent, oldFailed, oldQueued]));
    const byId = new Map(comms.map(c => [c.id, c]));
    expect(byId.get(oldSent)?.archivedAt).toBeTruthy();
    expect(byId.get(newSent)?.archivedAt).toBeNull();
    expect(byId.get(oldFailed)?.archivedAt).toBeNull();
    expect(byId.get(oldQueued)?.archivedAt).toBeNull();

    const suggs = await db.select().from(certificatPaymentSuggestions).where(inArray(certificatPaymentSuggestions.id, [oldConfirmed, newDismissed]));
    const sById = new Map(suggs.map(s => [s.id, s]));
    expect(sById.get(oldConfirmed)?.archivedAt).toBeTruthy();
    expect(sById.get(newDismissed)?.archivedAt).toBeNull();

    // idempotent: a second run archives nothing new from our fixtures
    const after = await storage.getFreshStartPreview(cutoff);
    expect(after.sentCommunications).toBeLessThanOrEqual(before.sentCommunications - 1);
  });
});
