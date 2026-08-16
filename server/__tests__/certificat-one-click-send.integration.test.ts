import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

/**
 * Task #543 — one-click certificat send.
 *
 * POST /api/projects/:projectId/certificats/:certId/send must never leave the
 * client email sitting "queued": the route now dispatches it immediately via
 * sendCommunication. Pins:
 *   1. success → response is the communication with status "sent", and the
 *      queued sibling contractor notice is chained and sent too;
 *   2. Gmail failure → 502 CERTIFICAT_SEND_FAILED and the communication row
 *      is a visible, retryable "failed" — never an indefinitely queued row.
 */

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
      messages: { send: fakeSend, list: async () => ({ data: { messages: [] } }), get: async () => ({ data: {} }) },
      threads: { get: async () => ({ data: {} }) },
      labels: { list: async () => ({ data: { labels: [] } }) },
    },
  }),
}));

// Stub out attachment/storage side-effects irrelevant to dispatch behaviour.
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

import { db } from "../db";
import { projectCommunications, certificats, projects, contractors } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import certificatsRouter from "../routes/certificats";

let server: http.Server;
let base: string;
let projectId: number;
let contractorId: number;
const madeCertIds: number[] = [];

async function makeReadyCert(): Promise<number> {
  const storageKey = `test/t543-${Date.now()}-${Math.floor(Math.random() * 1e6)}.pdf`;
  const [cert] = await db
    .insert(certificats)
    .values({
      projectId,
      contractorId,
      certificateRef: `T543-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      status: "ready",
      totalWorksHt: "1000.00",
      netToPayHt: "1000.00",
      netToPayTtc: "1200.00",
      tvaAmount: "200.00",
      // Pre-pinned key → sealCertificat early-returns, no PDF pipeline.
      pdfStorageKey: storageKey,
      pdfFileName: "CERT.pdf",
    })
    .returning();
  madeCertIds.push(cert.id);
  return cert.id;
}

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({
      code: `T543-${Date.now()}`,
      name: "One-click send test",
      clientName: "Test Client",
      clientContactEmail: "client@example.test",
      status: "active",
    })
    .returning();
  projectId = p.id;
  const [c] = await db
    .insert(contractors)
    .values({ name: `T543 Contractor ${Date.now()}`, email: "contractor@example.test" })
    .returning();
  contractorId = c.id;

  const app = express();
  app.use(express.json());
  // Session shim: the route reads req.session.userId for sender attribution.
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number | null } }).session = { userId: null };
    next();
  });
  app.use(certificatsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (madeCertIds.length) {
    await db.delete(projectCommunications).where(inArray(projectCommunications.relatedCertificatId, madeCertIds));
    await db.delete(certificats).where(inArray(certificats.id, madeCertIds));
  }
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

async function commsForCert(certId: number) {
  return db.select().from(projectCommunications).where(eq(projectCommunications.relatedCertificatId, certId));
}

describe("POST /api/projects/:projectId/certificats/:certId/send — one-click dispatch", () => {
  it("sends the client email immediately and chains the contractor notice — nothing left queued", async () => {
    const certId = await makeReadyCert();
    fakeSend.mockClear();

    const res = await fetch(`${base}/api/projects/${projectId}/certificats/${certId}/send`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; status: string; type: string };
    expect(body.type).toBe("certificat_sent");
    expect(body.status).toBe("sent");

    const comms = await commsForCert(certId);
    const client = comms.find((c) => c.type === "certificat_sent")!;
    const notice = comms.find((c) => c.type === "certificat_contractor_notice")!;
    expect(client.status).toBe("sent");
    expect(notice.status).toBe("sent");
    // Two Gmail sends: client email + chained contractor notice.
    expect(fakeSend).toHaveBeenCalledTimes(2);
    // Absolutely nothing stuck queued.
    expect(comms.some((c) => c.status === "queued")).toBe(false);
  });

  it("concurrent send requests dispatch exactly ONE client email and ONE contractor notice", async () => {
    const certId = await makeReadyCert();
    fakeSend.mockClear();
    // Slow the fake Gmail down so the two requests genuinely overlap at the
    // dispatch claim instead of serializing by accident.
    fakeSend.mockImplementation(async (_args: unknown) => {
      await new Promise((r) => setTimeout(r, 150));
      fakeMessageCounter++;
      return { data: { id: `fake-msg-${fakeMessageCounter}`, threadId: `fake-thread-${fakeMessageCounter}` } };
    });

    const url = `${base}/api/projects/${projectId}/certificats/${certId}/send`;
    const [a, b] = await Promise.all([fetch(url, { method: "POST" }), fetch(url, { method: "POST" })]);
    const statuses = [a.status, b.status].sort();
    // One winner (200); the loser reports in-progress (409) or, if it raced
    // in after completion, the idempotent 200 with the sent row.
    expect(statuses.some((s) => s === 200)).toBe(true);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);

    const comms = await commsForCert(certId);
    expect(comms.find((c) => c.type === "certificat_sent")!.status).toBe("sent");
    expect(comms.find((c) => c.type === "certificat_contractor_notice")!.status).toBe("sent");
    // Exactly one client email + one chained contractor notice — never duplicates.
    expect(fakeSend).toHaveBeenCalledTimes(2);
    fakeSend.mockReset();
    fakeSend.mockImplementation(async (_args: unknown) => {
      fakeMessageCounter++;
      return { data: { id: `fake-msg-${fakeMessageCounter}`, threadId: `fake-thread-${fakeMessageCounter}` } };
    });
  });

  it("concurrent RETRIES of a previously failed send dispatch exactly one client email and one notice", async () => {
    // Pins the failed-retry race: the failed→queued requeue in sendCertificat
    // is a conditional CAS, so the loser cannot stomp a row already claimed
    // into 'sending' back to 'queued' and trigger a second dispatch.
    const certId = await makeReadyCert();
    fakeSend.mockClear();
    fakeSend.mockRejectedValueOnce(new Error("gmail exploded"));

    const url = `${base}/api/projects/${projectId}/certificats/${certId}/send`;
    const first = await fetch(url, { method: "POST" });
    expect(first.status).toBe(502);
    expect((await commsForCert(certId)).find((c) => c.type === "certificat_sent")!.status).toBe("failed");

    // Slow sends so the two retries genuinely overlap at the claim.
    fakeSend.mockClear();
    fakeSend.mockImplementation(async (_args: unknown) => {
      await new Promise((r) => setTimeout(r, 150));
      fakeMessageCounter++;
      return { data: { id: `fake-msg-${fakeMessageCounter}`, threadId: `fake-thread-${fakeMessageCounter}` } };
    });
    const [a, b] = await Promise.all([fetch(url, { method: "POST" }), fetch(url, { method: "POST" })]);
    expect([a.status, b.status].some((s) => s === 200)).toBe(true);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);

    const comms = await commsForCert(certId);
    expect(comms.find((c) => c.type === "certificat_sent")!.status).toBe("sent");
    expect(comms.find((c) => c.type === "certificat_contractor_notice")!.status).toBe("sent");
    // Exactly one client email + one contractor notice across both retries.
    expect(fakeSend).toHaveBeenCalledTimes(2);
    fakeSend.mockReset();
    fakeSend.mockImplementation(async (_args: unknown) => {
      fakeMessageCounter++;
      return { data: { id: `fake-msg-${fakeMessageCounter}`, threadId: `fake-thread-${fakeMessageCounter}` } };
    });
  });

  it("surfaces a Gmail failure as 502 with a visible retryable FAILED row — never a silent queued one", async () => {
    const certId = await makeReadyCert();
    fakeSend.mockClear();
    fakeSend.mockRejectedValueOnce(new Error("gmail exploded"));

    const res = await fetch(`${base}/api/projects/${projectId}/certificats/${certId}/send`, { method: "POST" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; message: string; communication: { status: string } };
    expect(body.code).toBe("CERTIFICAT_SEND_FAILED");
    expect(body.communication.status).toBe("failed");

    const comms = await commsForCert(certId);
    const client = comms.find((c) => c.type === "certificat_sent")!;
    expect(client.status).toBe("failed");
    // No indefinitely-queued client row; the contractor notice stays queued
    // and is chained on the successful retry.
    expect(client.status).not.toBe("queued");

    // Retry succeeds: requeue + dispatch through the same route.
    const retry = await fetch(`${base}/api/projects/${projectId}/certificats/${certId}/send`, { method: "POST" });
    expect(retry.status).toBe(200);
    const after = await commsForCert(certId);
    expect(after.find((c) => c.type === "certificat_sent")!.status).toBe("sent");
    expect(after.find((c) => c.type === "certificat_contractor_notice")!.status).toBe("sent");
    expect(after.some((c) => c.status === "queued")).toBe(false);
  });
});
