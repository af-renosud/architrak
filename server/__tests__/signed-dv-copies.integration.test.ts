import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray } from "drizzle-orm";

const gmail = vi.hoisted(() => ({
  fakeMode: true,
  counter: 0,
  accepted: new Map<string, { id: string; threadId?: string; sentAt: Date }>(),
  send: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
}));

const documents = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../gmail/client", () => ({
  isFakeGmailMode: () => gmail.fakeMode,
  isGmailConfigured: () => true,
  rememberSharedGmailAcceptedSend: (
    messageId: string,
    accepted: { id: string; threadId?: string; sentAt: Date },
  ) => gmail.accepted.set(messageId, accepted),
  findSharedGmailAcceptedSend: (messageId: string) =>
    gmail.accepted.get(messageId) ?? null,
  getUncachableGmailClient: async () => ({
    users: {
      messages: {
        send: gmail.send,
        list: gmail.list,
        get: gmail.get,
      },
      threads: { get: async () => ({ data: {} }) },
      labels: { list: async () => ({ data: { labels: [] } }) },
    },
  }),
}));

vi.mock("../storage/object-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/object-storage")>();
  return {
    ...actual,
    getDocumentBuffer: async (key: string) => {
      const bytes = documents.get(key);
      if (!bytes) throw new Error(`test object missing: ${key}`);
      return bytes;
    },
  };
});

import { db } from "../db";
import { storage } from "../storage";
import {
  appSettings,
  contractors,
  devis,
  projectCommunications,
  projects,
  signedDevisCopyNotices,
  type Devis,
} from "@shared/schema";
import signedCopiesRouter from "../routes/signed-devis-contractor-copies";
import {
  SIGNED_COPY_SETTING_KEY,
  dispatchSignedCopyNotice,
  materializeSignedCopyOutbox,
  recordEligibleSignedCopyIntent,
  sweepSignedCopyNotices,
} from "../services/signed-devis-contractor-copy.service";
import { errorHandler } from "../middleware/error-handler";
import { MAX_SIGNED_PDF_RETRY_ATTEMPTS } from "../services/signed-pdf-retry-policy";

const PREFIX = `T-SIGNED-DV-${Date.now()}`;
const projectIds: number[] = [];
const contractorIds: number[] = [];
let previousSetting: string | null = null;
let server: http.Server;
let baseUrl: string;

type FixtureOptions = {
  email?: string | null;
  archived?: boolean;
  envelope?: string;
  signedPdfStorageKey?: string | null;
  signedPdfArchisignEnvelopeId?: string | null;
  signedOffVia?: string;
};

async function fixture(options: FixtureOptions = {}): Promise<{
  projectId: number;
  contractorId: number;
  row: Devis;
}> {
  const token = `${PREFIX}-${projectIds.length + 1}`;
  const [project] = await db.insert(projects).values({
    code: token,
    name: `Signed copy project ${token}`,
    clientName: "Integration Client",
    status: "active",
  }).returning();
  projectIds.push(project.id);

  const [contractor] = await db.insert(contractors).values({
    name: `Signed copy contractor ${token}`,
    email: options.email === undefined ? `${token.toLowerCase()}@example.test` : options.email,
  }).returning();
  contractorIds.push(contractor.id);

  const envelope = options.envelope ?? `env-${token}`;
  const [row] = await db.insert(devis).values({
    projectId: project.id,
    contractorId: contractor.id,
    devisCode: `DV-${token}`,
    devisNumber: `2026-${project.id}`,
    descriptionFr: "Travaux de test copie signée",
    amountHt: "1000.00",
    amountTtc: "1200.00",
    signOffStage: "client_signed_off",
    signedOffVia: options.signedOffVia ?? "archisign",
    archisignEnvelopeId: envelope,
    archisignEnvelopeStatus: "signed",
    signedPdfStorageKey: options.signedPdfStorageKey ?? null,
    signedPdfArchisignEnvelopeId: options.signedPdfArchisignEnvelopeId ?? null,
  }).returning();
  // Production DB triggers correctly reject inserting financial records into
  // an already archived project. Archive only after the complete fixture
  // exists to model a project archived between completion and dispatch.
  if (options.archived) {
    await db.update(projects).set({ archivedAt: new Date() })
      .where(eq(projects.id, project.id));
  }
  return { projectId: project.id, contractorId: contractor.id, row };
}

async function putSetting(enabled: boolean) {
  const response = await fetch(`${baseUrl}/api/settings/signed-dv-copies`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ enabled: boolean; activatedAt: string | null }>;
}

async function enable(): Promise<string> {
  const setting = await putSetting(true);
  expect(setting.enabled).toBe(true);
  expect(setting.activatedAt).toEqual(expect.any(String));
  return setting.activatedAt!;
}

async function intent(row: Devis, signedAt = new Date()) {
  return recordEligibleSignedCopyIntent(row, row.archisignEnvelopeId!, signedAt);
}

function rawMessages(): string[] {
  return gmail.send.mock.calls.map(([args]) =>
    Buffer.from(args.requestBody.raw, "base64url").toString("utf8"),
  );
}

beforeAll(async () => {
  previousSetting = await storage.getAppSetting(SIGNED_COPY_SETTING_KEY);
  await storage.setAppSetting(
    SIGNED_COPY_SETTING_KEY,
    JSON.stringify({ enabled: false, activatedAt: null }),
  );

  gmail.send.mockImplementation(async () => {
    gmail.counter += 1;
    return { data: { id: `signed-dv-msg-${gmail.counter}`, threadId: `signed-dv-thread-${gmail.counter}` } };
  });
  gmail.list.mockResolvedValue({ data: { messages: [] } });
  gmail.get.mockResolvedValue({ data: {} });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use(signedCopiesRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  gmail.fakeMode = true;
  gmail.send.mockClear();
  gmail.list.mockClear();
  gmail.get.mockClear();
  gmail.accepted.clear();
  gmail.list.mockResolvedValue({ data: { messages: [] } });
  documents.clear();
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (projectIds.length) {
    await db.delete(projects).where(inArray(projects.id, projectIds));
  }
  if (contractorIds.length) {
    await db.delete(contractors).where(inArray(contractors.id, contractorIds));
  }
  if (previousSetting === null) {
    await db.delete(appSettings).where(eq(appSettings.key, SIGNED_COPY_SETTING_KEY));
  } else {
    await storage.setAppSetting(SIGNED_COPY_SETTING_KEY, previousSetting);
  }
});

describe("automatic signed devis contractor copies (real DB)", () => {
  it("uses the locked settings API and applies each activation forward only", async () => {
    const { row } = await fixture();
    const beforeActivation = new Date(Date.now() - 60_000);

    expect(await intent(row, beforeActivation)).toBeNull();
    const firstActivation = await enable();

    const get = await fetch(`${baseUrl}/api/settings/signed-dv-copies`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ enabled: true, activatedAt: firstActivation });

    // A historic completion remains excluded even after the feature is on.
    expect(await intent(row, beforeActivation)).toBeNull();
    const included = await intent(row, new Date(Date.now() + 1_000));
    expect(included?.archisignEnvelopeId).toBe(row.archisignEnvelopeId);

    await putSetting(false);
    const { row: duringDisabled } = await fixture();
    const completionWhileDisabled = new Date(Date.now() - 1_000);
    expect(await intent(duringDisabled, completionWhileDisabled)).toBeNull();

    const secondActivation = await enable();
    expect(new Date(secondActivation).getTime()).toBeGreaterThanOrEqual(
      new Date(firstActivation).getTime(),
    );
    // The event that happened while disabled is still historical after
    // reactivation; enabling must not backfill it.
    expect(await intent(duringDisabled, completionWhileDisabled)).toBeNull();
  });

  it("persists one completion intent under duplicate and concurrent callbacks", async () => {
    await enable();
    const { row } = await fixture();
    const signedAt = new Date(Date.now() + 1_000);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => intent(row, signedAt)),
    );
    expect(results.every((result) => result?.id === results[0]?.id)).toBe(true);
    const rows = await db.select().from(signedDevisCopyNotices).where(and(
      eq(signedDevisCopyNotices.devisId, row.id),
      eq(signedDevisCopyNotices.archisignEnvelopeId, row.archisignEnvelopeId!),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].signedAt).toEqual(signedAt);
    expect(rows[0].intendedContractorId).toBe(row.contractorId);
  });

  it("never sends manual-upload bytes during a later Archisign upgrade", async () => {
    await enable();
    const manualKey = `${PREFIX}/manual-copy.pdf`;
    const archisignKey = `${PREFIX}/archisign-envelope-copy.pdf`;
    documents.set(manualKey, Buffer.from("MANUAL-BYTES-MUST-NOT-SEND"));
    documents.set(archisignKey, Buffer.from("AUTHENTIC-ARCHISIGN-SIGNED-PDF"));
    const { row } = await fixture({
      signedOffVia: "manual_upload",
      signedPdfStorageKey: manualKey,
      signedPdfArchisignEnvelopeId: null,
    });
    const notice = await intent(row, new Date(Date.now() + 1_000));
    expect(notice).not.toBeNull();

    // The webhook records intent before its CAS transition. It atomically
    // clears manual provenance while upgrading to Archisign; no worker is
    // invoked in between those operations.
    expect(gmail.send).not.toHaveBeenCalled();
    await storage.updateDevis(row.id, {
      signedOffVia: "archisign",
      signedPdfStorageKey: null,
      signedPdfArchisignEnvelopeId: null,
    });
    await materializeSignedCopyOutbox(row.id);
    expect((await storage.getProjectCommunication(notice!.communicationId ?? -1))).toBeUndefined();
    expect((await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id)))[0].status).toBe("pending_pdf");

    await storage.updateDevis(row.id, {
      signedPdfStorageKey: archisignKey,
      signedPdfArchisignEnvelopeId: row.archisignEnvelopeId,
    });
    await db.update(signedDevisCopyNotices).set({ nextAttemptAt: new Date(0) })
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    await sweepSignedCopyNotices();

    expect(gmail.send).toHaveBeenCalledTimes(1);
    const raw = rawMessages()[0];
    expect(raw).toContain("Content-Disposition: attachment;");
    expect(raw).toContain(Buffer.from("AUTHENTIC-ARCHISIGN-SIGNED-PDF").toString("base64"));
    expect(raw).not.toContain(Buffer.from("MANUAL-BYTES-MUST-NOT-SEND").toString("base64"));
  });

  it("recovers the durable-intent to outbox worker restart gap", async () => {
    await enable();
    const key = `${PREFIX}/restart-gap.pdf`;
    documents.set(key, Buffer.from("RESTART-GAP-PDF"));
    const { row } = await fixture({
      signedPdfStorageKey: key,
      signedPdfArchisignEnvelopeId: undefined,
    });
    await storage.updateDevis(row.id, { signedPdfArchisignEnvelopeId: row.archisignEnvelopeId });
    const notice = await intent(row, new Date(Date.now() + 1_000));
    expect(notice?.status).toBe("pending_pdf");
    expect(notice?.communicationId).toBeNull();

    await sweepSignedCopyNotices();
    const [recovered] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(recovered.status).toBe("sent");
    expect(recovered.communicationId).not.toBeNull();
    expect(gmail.send).toHaveBeenCalledTimes(1);
  });

  it("allows a missing contractor email to be corrected and explicitly retried", async () => {
    await enable();
    const key = `${PREFIX}/corrected-email.pdf`;
    documents.set(key, Buffer.from("CORRECTED-EMAIL-PDF"));
    const { row, contractorId } = await fixture({
      email: null,
      signedPdfStorageKey: key,
    });
    await storage.updateDevis(row.id, { signedPdfArchisignEnvelopeId: row.archisignEnvelopeId });
    const notice = await intent(row, new Date(Date.now() + 1_000));
    await materializeSignedCopyOutbox(row.id);
    let [failed] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toMatch(/email is missing or invalid/i);
    expect(gmail.send).not.toHaveBeenCalled();

    await db.update(contractors).set({ email: "corrected.contractor@example.test" })
      .where(eq(contractors.id, contractorId));
    const retries = await Promise.all(Array.from({ length: 6 }, () =>
      fetch(`${baseUrl}/api/devis/${row.id}/signed-copy-notice/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ));
    expect(retries.some((retry) => retry.status === 200)).toBe(true);
    expect(retries.every((retry) => retry.status === 200 || retry.status === 409)).toBe(true);
    const successfulRetry = retries.find((retry) => retry.status === 200)!;
    expect((await successfulRetry.json()).notice).toMatchObject({
      status: "queued",
      recipientEmail: "corrected.contractor@example.test",
      canRetry: false,
    });
    const communications = await db.select().from(projectCommunications)
      .where(eq(projectCommunications.relatedDevisId, row.id));
    expect(communications).toHaveLength(1);
    await sweepSignedCopyNotices();
    [failed] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(failed.status).toBe("sent");
    expect(rawMessages()[0]).toContain("To: corrected.contractor@example.test");
  });

  it("leaves queued work inert while disabled and resumes it without duplication", async () => {
    await enable();
    const key = `${PREFIX}/disabled-after-queue.pdf`;
    documents.set(key, Buffer.from("DISABLED-AFTER-QUEUE"));
    const { row } = await fixture({ signedPdfStorageKey: key });
    await storage.updateDevis(row.id, { signedPdfArchisignEnvelopeId: row.archisignEnvelopeId });
    const notice = await intent(row, new Date(Date.now() + 1_000));
    await materializeSignedCopyOutbox(row.id);

    await putSetting(false);
    await dispatchSignedCopyNotice(notice!.id);
    let [saved] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(saved.status).toBe("queued");
    expect(gmail.send).not.toHaveBeenCalled();

    await enable();
    await Promise.all([
      dispatchSignedCopyNotice(notice!.id),
      dispatchSignedCopyNotice(notice!.id),
    ]);
    [saved] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(saved.status).toBe("sent");
    expect(gmail.send).toHaveBeenCalledTimes(1);
  });

  it("keeps pending-PDF intent durable without creating a body-only outbox", async () => {
    await enable();
    const { row } = await fixture();
    const notice = await intent(row, new Date(Date.now() + 1_000));
    await sweepSignedCopyNotices();

    const [waiting] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(waiting).toMatchObject({
      status: "pending_pdf",
      communicationId: null,
    });
    expect(waiting.lastError).toMatch(/waiting for verified archisign signed pdf/i);
    expect(waiting.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await db.select().from(projectCommunications)
      .where(eq(projectCommunications.relatedDevisId, row.id))).toHaveLength(0);
    expect(gmail.send).not.toHaveBeenCalled();
  });

  it("re-arms a terminal missing-PDF notice without creating an attachment-less communication", async () => {
    await enable();
    const { row } = await fixture();
    const notice = await intent(row, new Date(Date.now() + 1_000));
    await db.update(devis).set({
      signedPdfRetryAttempts: MAX_SIGNED_PDF_RETRY_ATTEMPTS,
      signedPdfNextAttemptAt: null,
      signedPdfLastError: "terminal test download failure",
    }).where(eq(devis.id, row.id));

    await materializeSignedCopyOutbox(row.id);
    let [saved] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(saved).toMatchObject({ status: "failed", communicationId: null });
    expect(await db.select().from(projectCommunications)
      .where(eq(projectCommunications.relatedDevisId, row.id))).toHaveLength(0);

    const retry = await fetch(`${baseUrl}/api/devis/${row.id}/signed-copy-notice/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).notice).toMatchObject({
      status: "pending_pdf",
      communicationId: null,
    });
    const rearmed = await storage.getDevis(row.id);
    expect(rearmed).toMatchObject({
      signedPdfRetryAttempts: 0,
      signedPdfLastError: null,
    });
    expect(rearmed!.signedPdfNextAttemptAt).toBeInstanceOf(Date);

    const recoveredKey = `${PREFIX}/terminal-recovered.pdf`;
    documents.set(recoveredKey, Buffer.from("TERMINAL-RECOVERED-PDF"));
    await storage.updateDevis(row.id, {
      signedPdfStorageKey: recoveredKey,
      signedPdfArchisignEnvelopeId: row.archisignEnvelopeId,
    });
    await materializeSignedCopyOutbox(row.id);
    [saved] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(saved.status).toBe("queued");
    expect(saved.communicationId).not.toBeNull();
    expect((await storage.getProjectCommunication(saved.communicationId!))?.attachmentStorageKeys)
      .toEqual([recoveredKey]);
    await dispatchSignedCopyNotice(saved.id);
    [saved] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(saved.status).toBe("sent");
    expect(gmail.send).toHaveBeenCalledTimes(1);
  });

  it("fails closed for archived projects and contractor reassignment", async () => {
    await enable();
    const archivedKey = `${PREFIX}/archived.pdf`;
    const reassignedKey = `${PREFIX}/reassigned.pdf`;
    documents.set(archivedKey, Buffer.from("ARCHIVED"));
    documents.set(reassignedKey, Buffer.from("REASSIGNED"));

    const archived = await fixture({ archived: true, signedPdfStorageKey: archivedKey });
    await storage.updateDevis(archived.row.id, {
      signedPdfArchisignEnvelopeId: archived.row.archisignEnvelopeId,
    });
    const archivedNotice = await intent(archived.row, new Date(Date.now() + 1_000));
    await materializeSignedCopyOutbox(archived.row.id);

    const reassigned = await fixture({ signedPdfStorageKey: reassignedKey });
    await storage.updateDevis(reassigned.row.id, {
      signedPdfArchisignEnvelopeId: reassigned.row.archisignEnvelopeId,
    });
    const reassignedNotice = await intent(reassigned.row, new Date(Date.now() + 1_000));
    const replacement = await fixture();
    await db.update(devis).set({ contractorId: replacement.contractorId })
      .where(eq(devis.id, reassigned.row.id));
    await materializeSignedCopyOutbox(reassigned.row.id);

    const blocked = await db.select().from(signedDevisCopyNotices).where(inArray(
      signedDevisCopyNotices.id,
      [archivedNotice!.id, reassignedNotice!.id],
    ));
    expect(blocked).toHaveLength(2);
    expect(blocked.every((row) => row.status === "failed")).toBe(true);
    expect(blocked.map((row) => row.lastError).join(" ")).toMatch(/archived/i);
    expect(blocked.map((row) => row.lastError).join(" ")).toMatch(/assignment changed/i);
    expect(gmail.send).not.toHaveBeenCalled();
  });

  it("pins the completion recipient and signed date while sending the expected MIME attachment", async () => {
    await enable();
    const key = `${PREFIX}/recipient-and-date.pdf`;
    const bytes = Buffer.from("%PDF-1.7\nSIGNED RECIPIENT DATE\n%%EOF");
    documents.set(key, bytes);
    const { row, contractorId } = await fixture({ signedPdfStorageKey: key });
    await storage.updateDevis(row.id, { signedPdfArchisignEnvelopeId: row.archisignEnvelopeId });
    const signedAt = new Date("2031-04-05T12:34:56.000Z");
    const notice = await intent(row, signedAt);
    await materializeSignedCopyOutbox(row.id);
    await Promise.all([
      dispatchSignedCopyNotice(notice!.id),
      dispatchSignedCopyNotice(notice!.id),
      dispatchSignedCopyNotice(notice!.id),
    ]);

    const [saved] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    const communication = await storage.getProjectCommunication(saved.communicationId!);
    expect(saved.signedAt).toEqual(signedAt);
    expect(saved.intendedContractorId).toBe(contractorId);
    expect(saved.sentAt).toBeInstanceOf(Date);
    expect(communication).toMatchObject({
      recipientType: "contractor",
      recipientEmail: `${PREFIX.toLowerCase()}-${projectIds.length}@example.test`,
      relatedDevisId: row.id,
      status: "sent",
      attachmentStorageKeys: [key],
    });
    expect(gmail.send).toHaveBeenCalledTimes(1);
    expect(rawMessages()[0]).toContain("Content-Type: multipart/mixed;");
    expect(rawMessages()[0]).toContain("Content-Type: application/pdf;");
    expect(rawMessages()[0]).toContain(bytes.toString("base64"));
  });

  it("fails before Gmail rather than degrading to a body-only email when PDF bytes are missing", async () => {
    await enable();
    const missingKey = `${PREFIX}/object-does-not-exist.pdf`;
    const { row } = await fixture({ signedPdfStorageKey: missingKey });
    await storage.updateDevis(row.id, { signedPdfArchisignEnvelopeId: row.archisignEnvelopeId });
    const notice = await intent(row, new Date(Date.now() + 1_000));
    await materializeSignedCopyOutbox(row.id);
    await dispatchSignedCopyNotice(notice!.id);

    const [saved] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    const communication = await storage.getProjectCommunication(saved.communicationId!);
    expect(gmail.send).not.toHaveBeenCalled();
    expect(communication?.status).toBe("failed");
    expect(saved.status).toBe("queued");
    expect(saved.lastError).toMatch(/attachment unavailable|object missing/i);
  });

  it("does not blindly repeat a provider-attempted ambiguous send", async () => {
    await enable();
    gmail.fakeMode = false;
    const key = `${PREFIX}/ambiguous-provider.pdf`;
    documents.set(key, Buffer.from("AMBIGUOUS-PROVIDER-PDF"));
    const { row } = await fixture({ signedPdfStorageKey: key });
    await storage.updateDevis(row.id, { signedPdfArchisignEnvelopeId: row.archisignEnvelopeId });
    const notice = await intent(row, new Date(Date.now() + 1_000));
    await materializeSignedCopyOutbox(row.id);
    gmail.send.mockRejectedValueOnce(new Error("connection closed after provider request"));

    await dispatchSignedCopyNotice(notice!.id);
    let [saved] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(saved.status).toBe("reconciling");
    expect((await storage.getProjectCommunication(saved.communicationId!))?.status).toBe("sending");
    expect(gmail.send).toHaveBeenCalledTimes(1);

    // Simulate the next worker process. Sent lookup is inconclusive, so the
    // deterministic Message-ID is reconciled but Gmail send is not called.
    await db.update(signedDevisCopyNotices).set({ nextAttemptAt: new Date(0) })
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    await sweepSignedCopyNotices();
    [saved] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(saved.status).toBe("reconciling");
    expect(gmail.list).toHaveBeenCalled();
    expect(gmail.send).toHaveBeenCalledTimes(1);

    // On a later pass Gmail proves that the first attempt was accepted.
    // Reconciliation completes the same rows without another provider call.
    gmail.list
      .mockResolvedValueOnce({ data: { messages: [] } })
      .mockResolvedValueOnce({
        data: { messages: [{ id: "accepted-original", threadId: "accepted-thread" }] },
      });
    gmail.get.mockResolvedValue({
      data: {
        id: "accepted-original",
        threadId: "accepted-thread",
        internalDate: String(new Date("2032-01-02T03:04:05.000Z").getTime()),
      },
    });
    await db.update(signedDevisCopyNotices).set({ nextAttemptAt: new Date(0) })
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    await sweepSignedCopyNotices();
    [saved] = await db.select().from(signedDevisCopyNotices)
      .where(eq(signedDevisCopyNotices.id, notice!.id));
    expect(saved.status).toBe("sent");
    expect((await storage.getProjectCommunication(saved.communicationId!))).toMatchObject({
      status: "sent",
      emailMessageId: "accepted-original",
      emailThreadId: "accepted-thread",
    });
    expect(gmail.list.mock.calls.at(-1)?.[0]?.q).toMatch(/AT-DV-[a-f0-9]+/);
    expect(gmail.send).toHaveBeenCalledTimes(1);
  });
});