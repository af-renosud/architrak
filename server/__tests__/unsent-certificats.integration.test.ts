import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import { sendCertificat } from "../communications/email-sender";
import { certificats, projects, contractors, projectCommunications } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";

/**
 * Task #539 — real-DB pin for the single authoritative "unsent certificat"
 * definition feeding the dashboard alert and the per-devis section:
 *
 *  - ready + no certificat_sent communication  → LISTED;
 *  - ready + queued/sent certificat_sent       → excluded;
 *  - ready + FAILED certificat_sent only       → LISTED (a failed send is
 *    still unsent);
 *  - draft / sent / paid / superseded statuses → excluded regardless;
 *  - a non-certificat_sent communication (e.g. contractor notice) does NOT
 *    hide a ready certificat.
 */

let projectId: number;
let contractorId: number;
const madeCertIds: number[] = [];

async function makeCert(status: string): Promise<number> {
  const [row] = await db
    .insert(certificats)
    .values({
      projectId,
      contractorId,
      certificateRef: `T539-${status}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      status,
      totalWorksHt: "1000.00",
      netToPayHt: "1000.00",
      netToPayTtc: "1200.00",
      tvaAmount: "200.00",
    })
    .returning();
  madeCertIds.push(row.id);
  return row.id;
}

async function makeComm(certId: number, type: string, status: string) {
  await db.insert(projectCommunications).values({
    projectId,
    type,
    recipientType: "client",
    recipientEmail: "client@example.test",
    subject: "T539",
    body: "T539",
    status,
    relatedCertificatId: certId,
    dedupeKey: `t539:${certId}:${type}:${status}:${Math.random()}`,
  });
}

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T539-${Date.now()}`, name: "Unsent certs test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: `Unsent Contractor ${Date.now()}` }).returning();
  contractorId = c.id;
});

afterAll(async () => {
  if (madeCertIds.length) {
    await db.delete(projectCommunications).where(inArray(projectCommunications.relatedCertificatId, madeCertIds));
    await db.delete(certificats).where(inArray(certificats.id, madeCertIds));
  }
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("getUnsentReadyCertificats (real DB)", () => {
  it("applies the ready-and-never-queued/sent definition", async () => {
    const readyBare = await makeCert("ready");
    const readyQueued = await makeCert("ready");
    await makeComm(readyQueued, "certificat_sent", "queued");
    const readySent = await makeCert("ready");
    await makeComm(readySent, "certificat_sent", "sent");
    const readyFailed = await makeCert("ready");
    await makeComm(readyFailed, "certificat_sent", "failed");
    const readyNoticeOnly = await makeCert("ready");
    await makeComm(readyNoticeOnly, "certificat_contractor_notice", "sent");
    const draft = await makeCert("draft");
    const sent = await makeCert("sent");
    const paid = await makeCert("paid");
    const superseded = await makeCert("superseded");

    const rows = await storage.getUnsentReadyCertificats();
    const ids = new Set(rows.map((r) => r.certificatId));

    expect(ids.has(readyBare)).toBe(true);
    expect(ids.has(readyFailed)).toBe(true);
    expect(ids.has(readyNoticeOnly)).toBe(true);
    expect(ids.has(readyQueued)).toBe(false);
    expect(ids.has(readySent)).toBe(false);
    expect(ids.has(draft)).toBe(false);
    expect(ids.has(sent)).toBe(false);
    expect(ids.has(paid)).toBe(false);
    expect(ids.has(superseded)).toBe(false);

    const row = rows.find((r) => r.certificatId === readyBare)!;
    expect(row.projectId).toBe(projectId);
    expect(row.projectName).toBe("Unsent certs test");
    expect(row.contractorId).toBe(contractorId);
    expect(row.netToPayTtc).toBe("1200.00");
  });

  it("excludes certificats on archived projects", async () => {
    const readyBare = await makeCert("ready");
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
    try {
      const rows = await storage.getUnsentReadyCertificats();
      expect(rows.some((r) => r.certificatId === readyBare)).toBe(false);
    } finally {
      await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, projectId));
    }
  });
});

/**
 * Task #540 — requeue behaviour: a FAILED certificat_sent communication must
 * flip back to queued (archivedAt cleared) when the architect clicks Send
 * again from the "Awaiting certificat send" alert.
 *
 * The test exercises `sendCertificat` directly to stay out of the route-level
 * devis-validation layer. It pre-seeds a pinned pdfStorageKey on the certificat
 * so `sealCertificat` returns immediately without running the PDF pipeline.
 * The stable dedupeKey (`certificat_sent:<certId>:<storageKey>`) means
 * createProjectCommunication returns the existing FAILED row, and the
 * requeue branch flips it to queued with archivedAt cleared.
 */
describe("sendCertificat — retry from FAILED state", () => {
  let retryProjectId: number;
  let retryContractorId: number;
  let retryCertId: number;

  beforeAll(async () => {
    const [p] = await db
      .insert(projects)
      .values({
        code: `T540-${Date.now()}`,
        name: "Retry Send Test",
        clientName: "Test Client",
        clientContactEmail: "client@example.test",
        status: "active",
      })
      .returning();
    retryProjectId = p.id;
    const [c] = await db
      .insert(contractors)
      .values({ name: `T540 Contractor ${Date.now()}` })
      .returning();
    retryContractorId = c.id;
  });

  afterAll(async () => {
    if (retryCertId) {
      await db
        .delete(projectCommunications)
        .where(eq(projectCommunications.relatedCertificatId, retryCertId));
      await db.delete(certificats).where(eq(certificats.id, retryCertId));
    }
    await db.delete(contractors).where(eq(contractors.id, retryContractorId));
    await db.delete(projects).where(eq(projects.id, retryProjectId));
  });

  it("flips the failed comm to queued (archivedAt cleared) and removes the cert from the unsent list", async () => {
    // Use a deterministic storage key so we can build the dedupeKey before
    // calling sendCertificat. A pre-pinned pdfStorageKey means sealCertificat
    // returns immediately (early-return branch) — no PDF pipeline needed.
    const storageKey = `test/cert-retry-t540-${Date.now()}.pdf`;

    const [cert] = await db
      .insert(certificats)
      .values({
        projectId: retryProjectId,
        contractorId: retryContractorId,
        certificateRef: `T540-${Date.now()}`,
        status: "ready",
        totalWorksHt: "1000.00",
        netToPayHt: "1000.00",
        netToPayTtc: "1200.00",
        tvaAmount: "200.00",
        pdfStorageKey: storageKey,
        pdfFileName: "CERT.pdf",
      })
      .returning();
    retryCertId = cert.id;

    // Seed the pre-existing FAILED send — archived to simulate a dismissed
    // failed notice so we can confirm archivedAt is cleared on requeue.
    const dedupeKey = `certificat_sent:${cert.id}:${storageKey}`;
    const [failedComm] = await db
      .insert(projectCommunications)
      .values({
        projectId: retryProjectId,
        type: "certificat_sent",
        recipientType: "client",
        recipientEmail: "client@example.test",
        subject: "Test certificat",
        body: "Test",
        status: "failed",
        relatedCertificatId: cert.id,
        dedupeKey,
        archivedAt: new Date(),
      })
      .returning();

    // Cert must appear in the unsent list before retry (failed send = still unsent).
    const before = await storage.getUnsentReadyCertificats();
    expect(before.some((r) => r.certificatId === cert.id)).toBe(true);

    // Trigger send — sealCertificat short-circuits on the pre-pinned key.
    const commId = await sendCertificat(cert.id);

    // Must return the SAME communication row (dedupe key matched).
    expect(commId).toBe(failedComm.id);

    // The row must now be queued with archivedAt cleared.
    const comm = await storage.getProjectCommunication(commId);
    expect(comm?.status).toBe("queued");
    expect(comm?.archivedAt).toBeNull();

    // The cert must no longer appear in the unsent list.
    const after = await storage.getUnsentReadyCertificats();
    expect(after.some((r) => r.certificatId === cert.id)).toBe(false);
  });
});
