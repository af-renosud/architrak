import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import { scanCertificatReplies } from "../services/certificat-payment-suggestions.service";
import {
  certificats,
  certificatPayments,
  certificatPaymentAudits,
  certificatPaymentSuggestions,
  projectCommunications,
  projects,
  contractors,
  users,
} from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { gmail_v1 } from "googleapis";

/**
 * Task #466 — mailbox-ownership pins for the payment-reply scanner:
 *
 *  - a communication sent via user A's mailbox is scanned ONLY by user A's
 *    client; user B's scan never even fetches the thread;
 *  - legacy connector sends (sent_via_user_id NULL) are probed by every
 *    linked inbox, and a threads.get 404 is a silent not-my-mailbox skip,
 *    not an error;
 *  - a client "paid" reply on an owned thread creates a pending suggestion
 *    defaulting to the outstanding balance; a reply from a different sender
 *    creates nothing; a non-payment client reply parks as ambiguous.
 */

let projectId: number;
let contractorId: number;
let userAId: number;
let userBId: number;
let seq = 0;

function fakeThread(messages: gmail_v1.Schema$Message[]): { data: gmail_v1.Schema$Thread } {
  return { data: { messages } };
}

function reply(id: string, from: string, text: string, internalDate = "1786700000000"): gmail_v1.Schema$Message {
  return {
    id,
    internalDate,
    payload: {
      headers: [{ name: "From", value: from }],
      parts: [{ mimeType: "text/plain", body: { data: Buffer.from(text, "utf-8").toString("base64url") } }],
    },
  };
}

/** Gmail stub: threads by id; records which ids were fetched; unknown id → 404. */
function stubGmail(threads: Record<string, gmail_v1.Schema$Message[]>) {
  const fetched: string[] = [];
  const gmail = {
    users: {
      threads: {
        get: async ({ id }: { id: string }) => {
          fetched.push(id);
          if (!threads[id]) {
            const err: any = new Error("Not Found");
            err.status = 404;
            throw err;
          }
          return fakeThread(threads[id]);
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
  return { gmail, fetched };
}

async function makeCertWithComm(threadId: string, sentViaUserId: number | null, opts?: { ttc?: string }) {
  const [cert] = await db
    .insert(certificats)
    .values({
      projectId,
      contractorId,
      certificateRef: `T466S-${Date.now()}-${seq++}`,
      status: "sent",
      totalWorksHt: opts?.ttc ?? "1000.00",
      netToPayHt: opts?.ttc ?? "1000.00",
      netToPayTtc: opts?.ttc ?? "1000.00",
      tvaAmount: "0.00",
    })
    .returning();
  const [comm] = await db
    .insert(projectCommunications)
    .values({
      projectId,
      type: "certificat_sent",
      recipientType: "client",
      recipientEmail: "client@example.com",
      subject: `Certificat ${cert.certificateRef}`,
      status: "sent",
      emailMessageId: `sent-${threadId}`,
      emailThreadId: threadId,
      sentViaUserId,
      relatedCertificatId: cert.id,
      dedupeKey: `test-t466-${threadId}-${seq}`,
    })
    .returning();
  return { cert, comm };
}

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T466S-${Date.now()}`, name: "Reply scan test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: `Scan Contractor ${Date.now()}` }).returning();
  contractorId = c.id;
  const [ua] = await db.insert(users).values({ email: `t466-scan-a-${Date.now()}@renosud.com`, googleId: `t466-scan-a-${Date.now()}` }).returning();
  const [ub] = await db.insert(users).values({ email: `t466-scan-b-${Date.now()}@renosud.com`, googleId: `t466-scan-b-${Date.now()}` }).returning();
  userAId = ua.id;
  userBId = ub.id;
});

afterAll(async () => {
  const certIds = (await db.select({ id: certificats.id }).from(certificats).where(eq(certificats.projectId, projectId))).map((r) => r.id);
  if (certIds.length) {
    await db.delete(certificatPaymentSuggestions).where(inArray(certificatPaymentSuggestions.certificatId, certIds));
    await db.delete(certificatPaymentAudits).where(inArray(certificatPaymentAudits.certificatId, certIds));
    await db.delete(certificatPayments).where(inArray(certificatPayments.certificatId, certIds));
  }
  await db.delete(projectCommunications).where(eq(projectCommunications.projectId, projectId));
  if (certIds.length) await db.delete(certificats).where(inArray(certificats.id, certIds));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(users).where(inArray(users.id, [userAId, userBId]));
});

describe("payment-reply scan mailbox ownership (real DB + Gmail stub)", () => {
  it("scans owned threads only with the owner's client; other users never fetch them", async () => {
    const threadId = `own-${Date.now()}`;
    const { cert } = await makeCertWithComm(threadId, userAId);
    const threads = { [threadId]: [reply(`r1-${threadId}`, "Jean Client <client@example.com>", "Bonjour, virement effectué ce jour.")] };

    // User B scans first: the thread is owned by A, so B must not fetch it.
    const b = stubGmail(threads);
    const rb = await scanCertificatReplies(b.gmail, userBId);
    expect(b.fetched).not.toContain(threadId);
    expect(rb.suggestionsCreated).toBe(0);

    // User A scans: fetches the thread, creates a pending suggestion for
    // the full outstanding balance.
    const a = stubGmail(threads);
    const ra = await scanCertificatReplies(a.gmail, userAId);
    expect(a.fetched).toContain(threadId);
    expect(ra.suggestionsCreated).toBe(1);
    const [s] = await storage.getCertificatPaymentSuggestions(cert.id);
    expect(s.status).toBe("pending_review");
    expect(s.suggestedAmount).toBe("1000.00");
    expect(s.senderEmail).toBe("client@example.com");
    expect(s.matchedExcerpt).toContain("virement effectué");
  });

  it("probes legacy (NULL-owner) threads in every inbox and treats 404 as a silent skip", async () => {
    const threadId = `legacy-${Date.now()}`;
    const { cert } = await makeCertWithComm(threadId, null);

    // User B's mailbox does not contain the thread — 404, no error, nothing created.
    const b = stubGmail({});
    const rb = await scanCertificatReplies(b.gmail, userBId);
    expect(b.fetched).toContain(threadId);
    expect(rb.errors).toBe(0);
    expect((await storage.getCertificatPaymentSuggestions(cert.id)).length).toBe(0);

    // User A's mailbox owns it (e.g. connector account == A's account).
    const a = stubGmail({ [threadId]: [reply(`r1-${threadId}`, "client@example.com", "Facture réglée hier.")] });
    const ra = await scanCertificatReplies(a.gmail, userAId);
    expect(ra.suggestionsCreated).toBe(1);
  });

  it("connector pass (\"unowned\") discovers replies to connector-sent certificats and never touches owned threads", async () => {
    const legacyThread = `conn-${Date.now()}`;
    const ownedThread = `conn-owned-${Date.now()}`;
    const { cert } = await makeCertWithComm(legacyThread, null);
    await makeCertWithComm(ownedThread, userAId);
    const g = stubGmail({
      [legacyThread]: [reply(`r1-${legacyThread}`, "client@example.com", "Nous avons payé la facture ce matin.")],
    });
    // Works with zero linked users involved — this is the connector-only case.
    const r = await scanCertificatReplies(g.gmail, "unowned");
    expect(g.fetched).toContain(legacyThread);
    expect(g.fetched).not.toContain(ownedThread);
    expect(r.suggestionsCreated).toBe(1);
    const [s] = await storage.getCertificatPaymentSuggestions(cert.id);
    expect(s.status).toBe("pending_review");
  });

  it("aborts the pass with scopeDenied when the mailbox refuses reads (403 send-only connector)", async () => {
    const threadId = `deny-${Date.now()}`;
    const { cert } = await makeCertWithComm(threadId, null);
    const gmail = {
      users: {
        threads: {
          get: async () => {
            const err: any = new Error("Missing access token for authorization");
            err.status = 403;
            throw err;
          },
        },
      },
    } as unknown as gmail_v1.Gmail;
    const r = await scanCertificatReplies(gmail, "unowned");
    expect(r.scopeDenied).toBe(true);
    expect(r.errors).toBe(1);
    expect((await storage.getCertificatPaymentSuggestions(cert.id)).length).toBe(0);
  });

  it("ignores non-client senders and parks non-payment client replies as ambiguous", async () => {
    const threadId = `mix-${Date.now()}`;
    const { cert } = await makeCertWithComm(threadId, userAId);
    const g = stubGmail({
      [threadId]: [
        reply(`stranger-${threadId}`, "intruder@elsewhere.com", "payé payé payé"),
        reply(`vague-${threadId}`, "client@example.com", "Bien reçu, nous allons vérifier les montants."),
      ],
    });
    const r = await scanCertificatReplies(g.gmail, userAId);
    expect(r.suggestionsCreated).toBe(0);
    expect(r.ambiguousCreated).toBe(1);
    const suggestions = await storage.getCertificatPaymentSuggestions(cert.id);
    expect(suggestions.length).toBe(1);
    expect(suggestions[0].status).toBe("ambiguous");
    expect(suggestions[0].senderEmail).toBe("client@example.com");
  });
});
