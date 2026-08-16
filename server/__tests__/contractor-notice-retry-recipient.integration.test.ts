import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

/**
 * Task #520/521 — pins for the "always re-resolve contractor email" guarantee
 * in sendCommunication for `certificat_contractor_notice`.
 *
 * The fix (task #521 security patch) ensures:
 *   (a) a notice stored with a valid-but-stale address is retried to the
 *       CURRENT contractor email, not the old one;
 *   (b) if the contractor's current email is blank, the retry fails closed
 *       rather than disclosing payment content to the stale address;
 *   (c) if the contractor's current email is syntactically invalid, the retry
 *       also fails closed.
 *
 * vi.mock is hoisted above all imports, so the Gmail boundary is patched
 * before server/env.ts freezes the E2E_FAKE_GMAIL value — the module-level
 * env freeze is irrelevant because we replace the entire gmail/client module.
 */

// --- mock declarations (hoisted by Vitest before any import) ---------------

let fakeMessageCounter = 0;
const fakeSend = vi.fn(async (_args: unknown) => {
  fakeMessageCounter++;
  return { data: { id: `fake-msg-${fakeMessageCounter}`, threadId: `fake-thread-${fakeMessageCounter}` } };
});

vi.mock("../gmail/client", () => ({
  isFakeGmailMode: () => true,
  isGmailConfigured: () => true,
  getUncachableGmailClient: async () => ({
    users: {
      messages: {
        send: fakeSend,
        list: async () => ({ data: { messages: [] } }),
        get: async () => ({ data: {} }),
      },
      threads: { get: async () => ({ data: {} }) },
      labels: { list: async () => ({ data: { labels: [] } }) },
    },
  }),
}));

// Stub out attachment/storage side-effects irrelevant to recipient resolution.
vi.mock("../storage/object-storage", () => ({
  getDocumentBuffer: async () => Buffer.from(""),
  uploadDocument: async () => "fake-key",
}));
vi.mock("../communications/certificat-generator", () => ({
  buildCertificatEmailBody: async () => "<p>test</p>",
}));
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueUpload: async () => {},
}));

// ---------------------------------------------------------------------------

import { db } from "../db";
import { sendCommunication } from "../communications/email-sender";
import {
  projectCommunications,
  certificats,
  projects,
  contractors,
} from "@shared/schema";
import { eq } from "drizzle-orm";

const OLD_EMAIL = "old-contractor@stale.example";
const NEW_EMAIL = "new-contractor@current.example";
const INVALID_EMAIL = "not-an-email@@broken";

let projectId: number;
let contractorId: number;
let certId: number;
let commId: number;

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T520-${Date.now()}`, name: "Retry recipient test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;

  const [c] = await db
    .insert(contractors)
    .values({ name: `Retry Contractor ${Date.now()}`, email: OLD_EMAIL })
    .returning();
  contractorId = c.id;

  const [cert] = await db
    .insert(certificats)
    .values({
      projectId,
      contractorId,
      certificateRef: `T520-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      status: "sent",
      totalWorksHt: "1000.00",
      netToPayHt: "1000.00",
      netToPayTtc: "1000.00",
      tvaAmount: "0.00",
    })
    .returning();
  certId = cert.id;
});

afterAll(async () => {
  if (commId) await db.delete(projectCommunications).where(eq(projectCommunications.id, commId));
  await db.delete(certificats).where(eq(certificats.id, certId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
});

/** Seed a fresh failed contractor notice with recipientEmail=OLD_EMAIL. */
async function seedFailedNotice(): Promise<number> {
  if (commId) {
    await db.delete(projectCommunications).where(eq(projectCommunications.id, commId));
  }
  const [comm] = await db
    .insert(projectCommunications)
    .values({
      projectId,
      type: "certificat_contractor_notice",
      recipientType: "contractor",
      recipientEmail: OLD_EMAIL,
      subject: "Avis de paiement — test T520",
      body: "Test body.",
      status: "failed",
      relatedCertificatId: certId,
      dedupeKey: `t520-retry-${Date.now()}-${Math.random()}`,
    })
    .returning();
  commId = comm.id;
  return comm.id;
}

describe("contractor notice retry — recipient always re-resolved from current contractor record", () => {
  beforeEach(async () => {
    // Reset contractor to OLD_EMAIL before each case.
    await db.update(contractors).set({ email: OLD_EMAIL }).where(eq(contractors.id, contractorId));
    fakeSend.mockClear();
  });

  it("(a) uses the current contractor email when it differs from the stored stale address", async () => {
    const id = await seedFailedNotice();

    // Contractor email corrected to a new valid address.
    await db.update(contractors).set({ email: NEW_EMAIL }).where(eq(contractors.id, contractorId));

    await sendCommunication(id);

    const [updated] = await db.select().from(projectCommunications).where(eq(projectCommunications.id, id));
    expect(updated.status).toBe("sent");
    // Row must reflect the current address, not the stale one.
    expect(updated.recipientEmail).toBe(NEW_EMAIL);
    // Gmail was called exactly once — the notice was sent.
    expect(fakeSend).toHaveBeenCalledTimes(1);
  });

  it("(b) fails closed when contractor email is blank — does not send to the stale address", async () => {
    const id = await seedFailedNotice();

    await db.update(contractors).set({ email: "" }).where(eq(contractors.id, contractorId));

    await expect(sendCommunication(id)).rejects.toThrow(/Recipient email missing or invalid/i);

    const [updated] = await db.select().from(projectCommunications).where(eq(projectCommunications.id, id));
    expect(updated.status).toBe("failed");
    // Stale address must NOT remain — the row was updated to the blank fresh value.
    expect(updated.recipientEmail ?? "").toBe("");
    expect(fakeSend).not.toHaveBeenCalled();
  });

  it("(d) fails closed when relatedCertificatId is null — does not send to the stale stored address", async () => {
    // A contractor-notice row with no cert link cannot resolve a trusted
    // recipient; the send must fail closed, never use the stale stored email.
    const [orphanComm] = await db
      .insert(projectCommunications)
      .values({
        projectId,
        type: "certificat_contractor_notice",
        recipientType: "contractor",
        recipientEmail: OLD_EMAIL,
        subject: "Avis de paiement — orphan T520",
        body: "Test body.",
        status: "failed",
        relatedCertificatId: null,
        dedupeKey: `t520-orphan-${Date.now()}-${Math.random()}`,
      })
      .returning();

    try {
      await expect(sendCommunication(orphanComm.id)).rejects.toThrow(
        /no linked certificat/i,
      );

      const [updated] = await db
        .select()
        .from(projectCommunications)
        .where(eq(projectCommunications.id, orphanComm.id));
      expect(updated.status).toBe("failed");
      expect(fakeSend).not.toHaveBeenCalled();
    } finally {
      await db.delete(projectCommunications).where(eq(projectCommunications.id, orphanComm.id));
    }
  });

  it("(c) fails closed when contractor email is syntactically invalid — does not send to the stale address", async () => {
    const id = await seedFailedNotice();

    await db.update(contractors).set({ email: INVALID_EMAIL }).where(eq(contractors.id, contractorId));

    await expect(sendCommunication(id)).rejects.toThrow(/Recipient email missing or invalid/i);

    const [updated] = await db.select().from(projectCommunications).where(eq(projectCommunications.id, id));
    expect(updated.status).toBe("failed");
    // Stored recipient should be the invalid fresh value, not the old valid one.
    expect(updated.recipientEmail).toBe(INVALID_EMAIL);
    expect(fakeSend).not.toHaveBeenCalled();
  });
});
