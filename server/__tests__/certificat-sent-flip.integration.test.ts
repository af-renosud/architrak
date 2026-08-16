import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import { projects, contractors, certificats, projectCommunications } from "@shared/schema";
import { eq, inArray, sql } from "drizzle-orm";

// Task #554 — a successful email dispatch must advance the linked certificat
// from ready to sent atomically (one-way), and the 0094 backfill must repair
// certificats emailed before the fix. Runs against the dev database.

let projectId: number;
let contractorId: number;
const certIds: number[] = [];
const commIds: number[] = [];

async function insertCert(status: string): Promise<number> {
  const [c] = await db.insert(certificats).values({
    projectId,
    contractorId,
    certificateRef: `T554-${Math.random().toString(36).slice(2, 8)}`,
    totalWorksHt: "1000.00",
    netToPayHt: "1000.00",
    tvaAmount: "200.00",
    netToPayTtc: "1200.00",
    status,
  }).returning({ id: certificats.id });
  certIds.push(c.id);
  return c.id;
}

async function insertComm(certId: number | null, type: string, status: string): Promise<number> {
  const [row] = await db.insert(projectCommunications).values({
    projectId,
    type,
    recipientType: "client",
    recipientEmail: "t554@test.local",
    subject: "T554",
    status,
    relatedCertificatId: certId,
  }).returning({ id: projectCommunications.id });
  commIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const [p] = await db.insert(projects).values({
    name: "T554 Project", code: `T554-${Date.now()}`, clientName: "T554 Client",
  }).returning();
  projectId = p.id;
  const [ct] = await db.insert(contractors).values({ name: "T554 Contractor" }).returning();
  contractorId = ct.id;
});

afterAll(async () => {
  if (commIds.length) await db.delete(projectCommunications).where(inArray(projectCommunications.id, commIds));
  if (certIds.length) await db.delete(certificats).where(inArray(certificats.id, certIds));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
});

describe("markProjectCommunicationSent", () => {
  it("flips a ready certificat to sent alongside the communication", async () => {
    const certId = await insertCert("ready");
    const commId = await insertComm(certId, "certificat_sent", "sending");
    const comm = await storage.markProjectCommunicationSent(commId, { sentAt: new Date() }, certId);
    expect(comm?.status).toBe("sent");
    const [cert] = await db.select().from(certificats).where(eq(certificats.id, certId));
    expect(cert.status).toBe("sent");
    expect(cert.version).toBe(2); // optimistic-concurrency version bumped
  });

  it("never downgrades a paid certificat", async () => {
    const certId = await insertCert("paid");
    const commId = await insertComm(certId, "certificat_sent", "sending");
    await storage.markProjectCommunicationSent(commId, { sentAt: new Date() }, certId);
    const [cert] = await db.select().from(certificats).where(eq(certificats.id, certId));
    expect(cert.status).toBe("paid");
  });

  it("does not touch the certificat when no id is passed (contractor notice)", async () => {
    const certId = await insertCert("ready");
    const commId = await insertComm(certId, "contractor_payment_notice", "sending");
    await storage.markProjectCommunicationSent(commId, { sentAt: new Date() }, null);
    const [cert] = await db.select().from(certificats).where(eq(certificats.id, certId));
    expect(cert.status).toBe("ready");
  });

  it("a failed dispatch leaves the certificat untouched (no success update runs)", async () => {
    const certId = await insertCert("ready");
    const commId = await insertComm(certId, "certificat_sent", "sending");
    await storage.updateProjectCommunication(commId, { status: "failed" });
    const [cert] = await db.select().from(certificats).where(eq(certificats.id, certId));
    expect(cert.status).toBe("ready");
  });
});

describe("0094 backfill", () => {
  it("repairs ready certificats with an already-sent certificat email, and only those", async () => {
    const staleId = await insertCert("ready");
    await insertComm(staleId, "certificat_sent", "sent");
    const unsentId = await insertCert("ready");
    await insertComm(unsentId, "certificat_sent", "failed");
    const noticeOnlyId = await insertCert("ready");
    await insertComm(noticeOnlyId, "contractor_payment_notice", "sent");

    // Same statement as migrations/0094_backfill_certificat_sent_status.sql,
    // scoped to this test's rows.
    await db.execute(sql`
      UPDATE certificats c
      SET status = 'sent', version = c.version + 1
      WHERE c.status IN ('draft', 'ready')
        AND c.project_id = ${projectId}
        AND EXISTS (
          SELECT 1 FROM project_communications pc
          WHERE pc.related_certificat_id = c.id
            AND pc.type = 'certificat_sent'
            AND pc.status = 'sent'
        )`);

    const rows = await db.select().from(certificats).where(inArray(certificats.id, [staleId, unsentId, noticeOnlyId]));
    const byId = Object.fromEntries(rows.map(r => [r.id, r.status]));
    expect(byId[staleId]).toBe("sent");
    expect(byId[unsentId]).toBe("ready");
    expect(byId[noticeOnlyId]).toBe("ready");
  });
});
