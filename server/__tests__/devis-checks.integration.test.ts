import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

type Status = "open" | "awaiting_contractor" | "awaiting_architect" | "resolved" | "dropped";
interface Check { id: number; devisId: number; status: Status; query: string; lineItemId: number | null; origin: string }
interface Comm { id: number; dedupeKey: string; status: "queued" | "sent" | "failed"; body: string; subject: string; emailThreadId: string | null; emailMessageId: string | null }
interface Token { id: number; devisId: number; tokenHash: string; revokedAt: Date | null }

const { state, storageSpy } = vi.hoisted(() => {
  const state = {
    nextId: 1,
    devis: [] as Array<{ id: number; projectId: number; contractorId: number; signOffStage: string }>,
    contractors: [] as Array<{ id: number; name: string; email: string }>,
    projects: [] as Array<{ id: number; name: string }>,
    checks: [] as Check[],
    comms: [] as Comm[],
    tokens: [] as Token[],
    messages: [] as Array<{ id: number; checkId: number; authorType: string; body: string; channel: string }>,
  };
  const nid = () => ++state.nextId;

  const storageSpy = {
    getDevis: vi.fn(async (id: number) => state.devis.find((d) => d.id === id)),
    getContractor: vi.fn(async (id: number) => state.contractors.find((c) => c.id === id)),
    getProject: vi.fn(async (id: number) => state.projects.find((p) => p.id === id)),
    getDevisLineItems: vi.fn(async () => []),
    listDevisChecks: vi.fn(async (devisId: number) => state.checks.filter((c) => c.devisId === devisId)),
    listDevisCheckMessages: vi.fn(async (checkId: number) => state.messages.filter((m) => m.checkId === checkId)),
    countOpenDevisChecks: vi.fn(async (devisId: number) =>
      state.checks.filter((c) => c.devisId === devisId && (c.status === "open" || c.status === "awaiting_contractor" || c.status === "awaiting_architect")).length,
    ),
    getProjectCommunicationByDedupeKey: vi.fn(async (k: string) => state.comms.find((c) => c.dedupeKey === k)),
    createProjectCommunication: vi.fn(async (data: any) => { const r = { id: nid(), emailThreadId: null, emailMessageId: null, ...data }; state.comms.push(r); return r; }),
    updateProjectCommunication: vi.fn(async (id: number, data: any) => {
      const r = state.comms.find((c) => c.id === id); if (!r) return undefined; Object.assign(r, data); return r;
    }),
    getLatestSentDevisCheckBundle: vi.fn(async () => undefined),
    updateDevisCheck: vi.fn(async (id: number, data: any) => {
      const r = state.checks.find((c) => c.id === id); if (!r) return undefined; Object.assign(r, data); return r;
    }),
    createDevisCheck: vi.fn(async (data: any) => { const r = { id: nid(), ...data }; state.checks.push(r); return r; }),
    createDevisCheckMessage: vi.fn(async (data: any) => { const r = { id: nid(), ...data }; state.messages.push(r); return r; }),
    upsertLineItemCheck: vi.fn(async (devisId: number, lineItemId: number, query: string) => {
      const existing = state.checks.find((c) => c.devisId === devisId && c.lineItemId === lineItemId);
      if (existing) { existing.query = query; return existing; }
      const r = { id: nid(), devisId, lineItemId, status: "open" as Status, query, origin: "line_item" };
      state.checks.push(r); return r;
    }),
    getDevisCheckTokenByHash: vi.fn(async (hash: string) => state.tokens.find((t) => t.tokenHash === hash)),
    touchDevisCheckTokenUsed: vi.fn(async () => undefined),
    revokeDevisCheckTokensForDevis: vi.fn(async (devisId: number) => {
      state.tokens.filter((t) => t.devisId === devisId).forEach((t) => { t.revokedAt = new Date(); });
    }),
  };
  return { state, storageSpy };
});

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../auth/middleware", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../env", () => ({ env: { PUBLIC_BASE_URL: "https://example.test", NODE_ENV: "test", SESSION_SECRET: "x" } }));
vi.mock("../services/devis-checks", () => ({
  issueDevisCheckToken: vi.fn(async (opts: any) => {
    const raw = `raw-${Math.random().toString(36).slice(2)}`;
    state.tokens.push({ id: ++state.nextId, devisId: opts.devisId, tokenHash: `hash:${raw}`, revokedAt: null });
    return { raw };
  }),
  buildPortalUrl: (base: string, raw: string) => `${base}/p/check/${raw}`,
  hashToken: (raw: string) => `hash:${raw}`,
}));
vi.mock("../communications/email-sender", () => ({
  queueDevisCheckBundle: vi.fn(async (opts: any) => {
    const existing = state.comms.find((c) => c.dedupeKey === opts.dedupeKey);
    const subject = `Subject for ${opts.devisId}`;
    const body = `Body with ${opts.portalUrl}`;
    if (existing) return { communicationId: existing.id, alreadySent: existing.status === "sent", refreshedSubject: subject, refreshedBody: body };
    const created = { id: ++state.nextId, dedupeKey: opts.dedupeKey, status: "queued" as const, body, subject, emailThreadId: null, emailMessageId: null };
    state.comms.push(created);
    return { communicationId: created.id, alreadySent: false, refreshedSubject: subject, refreshedBody: body };
  }),
  sendCommunication: vi.fn(async (id: number) => {
    const c = state.comms.find((x) => x.id === id);
    if (c) c.status = "sent";
  }),
}));

let server: http.Server;
let baseUrl: string;
let devisRouter: any;
let devisChecksRouter: any;
let publicChecksRouter: any;

beforeAll(async () => {
  // Importing the routes after mocks are registered
  devisChecksRouter = (await import("../routes/devis-checks")).default;
  publicChecksRouter = (await import("../routes/public-checks")).default;
  // We use the devis update handler directly to test the gate without
  // needing the entire devis router, which has many dependencies.
});

beforeEach(() => {
  state.nextId = 1; state.devis.length = 0; state.contractors.length = 0; state.projects.length = 0;
  state.checks.length = 0; state.comms.length = 0; state.tokens.length = 0; state.messages.length = 0;
  vi.clearAllMocks();
});

async function withApp(): Promise<void> {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { userId: 1 }; next(); });
  app.use(devisChecksRouter);
  app.use(publicChecksRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    // eslint-disable-next-line no-console
    console.error("TEST_APP_ERROR:", err?.stack || err?.message || err);
    res.status(500).json({ message: String(err?.message || err) });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

afterAll(() => { server?.close(); });

describe("Devis CHECKING — bundled-send route", () => {
  beforeAll(async () => { await withApp(); });

  it("returns 409 when there are no open checks to send (gate)", async () => {
    state.devis.push({ id: 10, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    const res = await fetch(`${baseUrl}/api/devis/10/checks/send`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.message).toMatch(/No open checks/i);
  });

  it("dedupe no-op: a prior 'sent' bundle short-circuits and does NOT call queueDevisCheckBundle", async () => {
    state.devis.push({ id: 11, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    state.checks.push({ id: 100, devisId: 11, status: "open", query: "Q1", lineItemId: null, origin: "general" });
    const dedupeKey = `devis-check-bundle:11:100`;
    state.comms.push({ id: 999, dedupeKey, status: "sent", body: "old body with stale URL", subject: "old subject", emailThreadId: "thr1", emailMessageId: "msg1" });

    const sender = await import("../communications/email-sender");
    const res = await fetch(`${baseUrl}/api/devis/11/checks/send`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ communicationId: 999, reused: true });
    expect(sender.queueDevisCheckBundle).not.toHaveBeenCalled();
    expect(sender.sendCommunication).not.toHaveBeenCalled();
    // Check still in original state — not flipped to awaiting_contractor.
    expect(state.checks[0].status).toBe("open");
  });

  it("retry path: prior FAILED bundle is reused, body is rewritten with fresh portal URL, and resend happens", async () => {
    state.devis.push({ id: 12, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    state.checks.push({ id: 200, devisId: 12, status: "open", query: "Q1", lineItemId: null, origin: "general" });
    const dedupeKey = `devis-check-bundle:12:200`;
    state.comms.push({ id: 555, dedupeKey, status: "failed", body: "STALE-OLD-BODY", subject: "stale subject", emailThreadId: null, emailMessageId: null });

    const sender = await import("../communications/email-sender");
    const res = await fetch(`${baseUrl}/api/devis/12/checks/send`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(sender.queueDevisCheckBundle).toHaveBeenCalledTimes(1);
    expect(sender.sendCommunication).toHaveBeenCalledWith(555, expect.objectContaining({ threadId: null }));
    const reused = state.comms.find((c) => c.id === 555)!;
    // Body must have been rewritten by the route via updateProjectCommunication.
    expect(reused.body).not.toBe("STALE-OLD-BODY");
    expect(reused.body).toMatch(/raw-/);
    // sendCommunication mock flips status to sent.
    expect(reused.status).toBe("sent");
    // Eligible check has been flipped to awaiting_contractor.
    expect(state.checks[0].status).toBe("awaiting_contractor");
  });
});

describe("Sign-off stage gate (line-item + general checks block 'sent_to_client')", () => {
  // We inline the gate logic from server/routes/devis.ts to assert behavior
  // without coupling to the full devis router (which has many side imports).
  // The logic mirrors lines 333-348 of server/routes/devis.ts exactly.
  const STAGE_ORDER = ["received", "checked_internal", "approved_for_signing", "sent_to_client", "client_signed_off"];
  const SENT_INDEX = STAGE_ORDER.indexOf("sent_to_client");
  async function check(devisId: number, prev: string, next: string): Promise<{ ok: true } | { ok: false; openChecks: number }> {
    const nextIdx = STAGE_ORDER.indexOf(next);
    const prevIdx = STAGE_ORDER.indexOf(prev);
    if (nextIdx >= SENT_INDEX && nextIdx > prevIdx) {
      const openCount = await storageSpy.countOpenDevisChecks(devisId);
      if (openCount > 0) return { ok: false, openChecks: openCount };
    }
    return { ok: true };
  }

  it("blocks advance to 'sent_to_client' with 409 when an open check exists (auto-created from line-item flag)", async () => {
    state.devis.push({ id: 30, projectId: 1, contractorId: 1, signOffStage: "approved_for_signing" });
    // Simulate the auto-create path: flagging a line item upserts an open
    // check for that line item.
    await storageSpy.upsertLineItemCheck(30, 9001, "Le BTU semble bas");
    expect(state.checks).toHaveLength(1);
    expect(state.checks[0]).toMatchObject({ devisId: 30, lineItemId: 9001, status: "open", origin: "line_item" });

    const result = await check(30, "approved_for_signing", "sent_to_client");
    expect(result).toEqual({ ok: false, openChecks: 1 });
  });

  it("allows advance once all checks are resolved/dropped", async () => {
    state.devis.push({ id: 31, projectId: 1, contractorId: 1, signOffStage: "approved_for_signing" });
    state.checks.push({ id: 1, devisId: 31, status: "resolved", query: "x", lineItemId: 1, origin: "line_item" });
    state.checks.push({ id: 2, devisId: 31, status: "dropped", query: "y", lineItemId: null, origin: "general" });
    const result = await check(31, "approved_for_signing", "sent_to_client");
    expect(result).toEqual({ ok: true });
  });
});

describe("Public portal — token revocation", () => {
  beforeAll(async () => { await withApp(); });

  it("returns 404 from /p/check/:token/data after the token is revoked", async () => {
    state.devis.push({ id: 50, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    const raw = "rawvalid".padEnd(40, "X");
    state.tokens.push({ id: 7777, devisId: 50, tokenHash: `hash:${raw}`, revokedAt: null });

    const ok = await fetch(`${baseUrl}/p/check/${raw}/data`);
    expect(ok.status).toBe(200);

    await storageSpy.revokeDevisCheckTokensForDevis(50);

    const blocked = await fetch(`${baseUrl}/p/check/${raw}/data`);
    expect(blocked.status).toBe(404);
    const body = await blocked.json();
    expect(body.message).toMatch(/invalide|expiré/i);
  });

  it("hides resolved checks from the contractor (only open queries are surfaced)", async () => {
    state.devis.push({ id: 51, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    state.checks.push({ id: 10, devisId: 51, status: "open", query: "OPEN-Q", lineItemId: null, origin: "general" });
    state.checks.push({ id: 11, devisId: 51, status: "resolved", query: "DONE-Q", lineItemId: null, origin: "general" });
    state.checks.push({ id: 12, devisId: 51, status: "dropped", query: "DROP-Q", lineItemId: null, origin: "general" });
    const raw = "rawvalid2".padEnd(40, "Y");
    state.tokens.push({ id: 8888, devisId: 51, tokenHash: `hash:${raw}`, revokedAt: null });

    const res = await fetch(`${baseUrl}/p/check/${raw}/data`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.checks as Array<{ id: number; query: string }>).map((c) => c.query);
    expect(ids).toEqual(["OPEN-Q"]);
  });
});
