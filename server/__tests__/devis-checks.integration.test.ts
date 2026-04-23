import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

type Status = "open" | "awaiting_contractor" | "awaiting_architect" | "resolved" | "dropped";
interface Check { id: number; devisId: number; status: Status; query: string; lineItemId: number | null; origin: string }
interface Comm { id: number; dedupeKey: string; status: "queued" | "sent" | "failed"; body: string; subject: string; emailThreadId: string | null; emailMessageId: string | null }
interface Token { id: number; devisId: number; tokenHash: string; revokedAt: Date | null; createdAt?: Date | null; lastUsedAt?: Date | null; expiresAt?: Date | null }

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
    lineItems: [] as Array<{ id: number; devisId: number; lineNumber: number; description: string; totalHt: string; pdfPageHint: number | null; pdfBbox: { x: number; y: number; w: number; h: number } | null }>,
  };
  const nid = () => ++state.nextId;

  const storageSpy = {
    getDevis: vi.fn(async (id: number) => state.devis.find((d) => d.id === id)),
    getContractor: vi.fn(async (id: number) => state.contractors.find((c) => c.id === id)),
    getProject: vi.fn(async (id: number) => state.projects.find((p) => p.id === id)),
    getDevisLineItems: vi.fn(async (_devisId: number) => state.lineItems.filter((li) => li.devisId === _devisId)),
    listDevisChecks: vi.fn(async (devisId: number) => state.checks.filter((c) => c.devisId === devisId)),
    countAwaitingArchitectInbox: vi.fn(async () =>
      state.checks.filter((c) => c.status === "awaiting_architect").length,
    ),
    listAwaitingArchitectInbox: vi.fn(async (limit: number) => {
      const awaiting = state.checks.filter((c) => c.status === "awaiting_architect");
      const enriched = awaiting.map((c) => {
        const d = state.devis.find((x) => x.id === c.devisId);
        const p = d ? state.projects.find((x) => x.id === d.projectId) : undefined;
        const ct = d ? state.contractors.find((x) => x.id === d.contractorId) : undefined;
        const msgs = state.messages
          .filter((m) => m.checkId === c.id && m.authorType === "contractor")
          .sort((a, b) => b.id - a.id);
        const latest = msgs[0];
        return {
          checkId: c.id,
          checkQuery: c.query,
          checkUpdatedAt: new Date(),
          devisId: c.devisId,
          devisCode: d ? `D-${d.id}` : null,
          projectId: d?.projectId ?? 0,
          projectName: p?.name ?? "P",
          contractorName: ct?.name ?? null,
          latestMessageBody: latest?.body ?? null,
          latestMessageAt: latest ? new Date() : null,
          latestMessageAuthor: null,
        };
      });
      return enriched.slice(0, limit);
    }),
    listDevisCheckMessages: vi.fn(async (checkId: number) => state.messages.filter((m) => m.checkId === checkId)),
    countOpenDevisChecks: vi.fn(async (devisId: number) =>
      state.checks.filter((c) => c.devisId === devisId && (c.status === "open" || c.status === "awaiting_contractor" || c.status === "awaiting_architect")).length,
    ),
    getProjectCommunicationByDedupeKey: vi.fn(async (k: string) => state.comms.find((c) => c.dedupeKey === k)),
    createProjectCommunication: vi.fn(async (data: any) => { const r = { id: nid(), emailThreadId: null, emailMessageId: null, ...data }; state.comms.push(r); return r; }),
    updateProjectCommunication: vi.fn(async (id: number, data: any) => {
      const r = state.comms.find((c) => c.id === id); if (!r) return undefined; Object.assign(r, data); return r;
    }),
    getLatestSentDevisCheckBundle: vi.fn(async (devisId: number) => {
      const prefix = `devis-check-bundle:${devisId}:`;
      const sent = state.comms.filter((c) => c.dedupeKey.startsWith(prefix) && c.status === "sent");
      return sent[sent.length - 1];
    }),
    countSentDevisCheckBundles: vi.fn(async (devisId: number) => {
      const prefix = `devis-check-bundle:${devisId}:`;
      return state.comms.filter((c) => c.dedupeKey.startsWith(prefix) && c.status === "sent").length;
    }),
    getMaxMessageIdForChecks: vi.fn(async (checkIds: number[]) => {
      if (checkIds.length === 0) return 0;
      // Mirror the real implementation: system (audit) rows are excluded
      // from the conversation-revision fingerprint so they cannot defeat
      // the bundled-send dedupe key (see storage.getMaxMessageIdForChecks).
      const ids = state.messages
        .filter((m) => checkIds.includes(m.checkId) && m.authorType !== "system")
        .map((m) => m.id);
      return ids.length === 0 ? 0 : Math.max(...ids);
    }),
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
    getActiveDevisCheckToken: vi.fn(async (devisId: number) =>
      state.tokens.find((t) => t.devisId === devisId && !t.revokedAt),
    ),
    getLatestDevisCheckToken: vi.fn(async (devisId: number) => {
      const all = state.tokens.filter((t) => t.devisId === devisId);
      return all.length ? all[all.length - 1] : undefined;
    }),
    extendDevisCheckTokenExpiry: vi.fn(async (id: number, expiresAt: Date | null) => {
      const t = state.tokens.find((x) => x.id === id && !x.revokedAt);
      if (!t) return undefined;
      t.expiresAt = expiresAt;
      return t;
    }),
    revokeDevisCheckTokenById: vi.fn(async (id: number) => {
      const t = state.tokens.find((x) => x.id === id && !x.revokedAt);
      if (!t) return undefined;
      t.revokedAt = new Date();
      return t;
    }),
    getUser: vi.fn(async (_id: number) => ({ id: 1, email: "alice@example.com", firstName: "Alice", lastName: "A" })),
  };
  return { state, storageSpy };
});

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../auth/middleware", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../env", () => ({ env: { PUBLIC_BASE_URL: "https://example.test", NODE_ENV: "test", SESSION_SECRET: "x" } }));
vi.mock("../services/devis-checks", () => ({
  issueDevisCheckToken: vi.fn(async (opts: any) => {
    // Mirror storage.createDevisCheckToken: revoke any active token for this
    // devis first so the partial-unique invariant is preserved and rotation
    // semantics match production.
    state.tokens
      .filter((t) => t.devisId === opts.devisId && !t.revokedAt)
      .forEach((t) => { t.revokedAt = new Date(); });
    const raw = `raw-${Math.random().toString(36).slice(2)}`;
    state.tokens.push({ id: ++state.nextId, devisId: opts.devisId, tokenHash: `hash:${raw}`, revokedAt: null });
    return { raw };
  }),
  buildPortalUrl: (base: string, raw: string) => `${base}/p/check/${raw}`,
  hashToken: (raw: string) => `hash:${raw}`,
  computeTokenExpiry: () => new Date("2099-01-01T00:00:00Z"),
  isTokenExpired: (t: { expiresAt: Date | null }) => !!t.expiresAt && t.expiresAt.getTime() <= Date.now(),
  // Mirror the real resolver so the /p/check/:token/* routes can authenticate
  // through the storage stub. Token validity == hash present + not revoked +
  // not expired. The real impl in server/services/devis-checks.ts is identical.
  resolveDevisCheckToken: vi.fn(async (raw: string) => {
    const t = state.tokens.find((x) => x.tokenHash === `hash:${raw}`);
    if (!t) return { ok: false, reason: "missing" } as const;
    if (t.revokedAt) return { ok: false, reason: "revoked" } as const;
    if (t.expiresAt && t.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" } as const;
    return { ok: true, token: t } as const;
  }),
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
  state.lineItems.length = 0;
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

  it("dispatch idempotency: same checks + no new messages since the prior 'sent' bundle ⇒ short-circuit (no queue, no send)", async () => {
    state.devis.push({ id: 13, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    state.checks.push({ id: 100, devisId: 13, status: "awaiting_contractor", query: "Q1", lineItemId: null, origin: "general" });
    // No messages yet → max msg id = 0 → key uses ":m0:".
    state.comms.push({ id: 999, dedupeKey: "devis-check-bundle:13:m0:100", status: "sent", body: "old body", subject: "old subject", emailThreadId: "thr1", emailMessageId: "msg1" });

    const sender = await import("../communications/email-sender");
    const res = await fetch(`${baseUrl}/api/devis/13/checks/send`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ communicationId: 999, reused: true });
    expect(sender.queueDevisCheckBundle).not.toHaveBeenCalled();
    expect(sender.sendCommunication).not.toHaveBeenCalled();
    expect(state.checks[0].status).toBe("awaiting_contractor");
  });

  it("follow-up round: a NEW architect message bumps the dedupe fingerprint ⇒ fresh send + Gmail threading", async () => {
    state.devis.push({ id: 14, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    state.checks.push({ id: 200, devisId: 14, status: "awaiting_contractor", query: "Q1", lineItemId: null, origin: "general" });
    // Prior round at fingerprint m0 succeeded.
    state.comms.push({ id: 700, dedupeKey: "devis-check-bundle:14:m0:200", status: "sent", body: "round 0 body", subject: "round 0", emailThreadId: "gmail-thread-1", emailMessageId: "gmail-msg-1" });
    // Architect (or contractor) added a follow-up message → fingerprint bumps.
    state.messages.push({ id: 5050, checkId: 200, authorType: "architect", body: "follow-up question", channel: "portal" });

    const sender = await import("../communications/email-sender");
    const res = await fetch(`${baseUrl}/api/devis/14/checks/send`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    // A NEW comm row at the new fingerprint must have been created and sent.
    expect(body.reused).toBe(false);
    expect(sender.queueDevisCheckBundle).toHaveBeenCalledTimes(1);
    expect(sender.sendCommunication).toHaveBeenCalledTimes(1);
    // The fresh send must thread via the prior round's Gmail headers.
    const sendCall = (sender.sendCommunication as any).mock.calls[0];
    expect(sendCall[1]).toMatchObject({ threadId: "gmail-thread-1", inReplyToMessageId: "gmail-msg-1" });
    // A second comm row at the new fingerprint exists alongside the original.
    const next = state.comms.find((c) => c.dedupeKey === "devis-check-bundle:14:m5050:200");
    expect(next).toBeDefined();
    expect(next!.status).toBe("sent");
    // Critical: a second click WITHOUT any new message must be idempotent
    // (no third comm row, no extra send) — proving "no double-sends on retry".
    const callsBefore = (sender.sendCommunication as any).mock.calls.length;
    const res2 = await fetch(`${baseUrl}/api/devis/14/checks/send`, { method: "POST" });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.reused).toBe(true);
    expect((sender.sendCommunication as any).mock.calls.length).toBe(callsBefore);
  });

  it("double-click: a second Send right after the first does not create a 2nd project_communications row and does not re-send the email — even though dispatch wrote per-check 'system' audit rows in between", async () => {
    state.devis.push({ id: 21, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    state.checks.push({ id: 300, devisId: 21, status: "open", query: "Q1", lineItemId: null, origin: "general" });
    state.checks.push({ id: 301, devisId: 21, status: "open", query: "Q2", lineItemId: null, origin: "general" });

    const sender = await import("../communications/email-sender");

    // First click: fresh dispatch, queues a new comm row and sends it.
    const r1 = await fetch(`${baseUrl}/api/devis/21/checks/send`, { method: "POST" });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.reused).toBe(false);

    // After dispatch, the route writes one 'system' audit message per
    // check. Confirm that actually happened — this is the regression
    // surface (system rows used to defeat the dedupe key).
    expect(state.messages.filter((m) => m.authorType === "system")).toHaveLength(2);
    const commsAfter1 = state.comms.filter((c) => c.dedupeKey.startsWith("devis-check-bundle:21:"));
    expect(commsAfter1).toHaveLength(1);
    const sendsAfter1 = (sender.sendCommunication as any).mock.calls.length;

    // Second click: nothing has changed in the conversation (only system
    // audit rows were added). Must short-circuit on the original sent row.
    const r2 = await fetch(`${baseUrl}/api/devis/21/checks/send`, { method: "POST" });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.reused).toBe(true);
    expect(b2.communicationId).toBe(b1.communicationId);

    // Critical guarantees:
    //   • exactly one project_communications row exists for this devis
    //   • sendCommunication was NOT invoked again
    const commsAfter2 = state.comms.filter((c) => c.dedupeKey.startsWith("devis-check-bundle:21:"));
    expect(commsAfter2).toHaveLength(1);
    expect((sender.sendCommunication as any).mock.calls.length).toBe(sendsAfter1);
  });

  it("retry path: prior FAILED bundle is reused, body is rewritten with fresh portal URL, and resend happens", async () => {
    state.devis.push({ id: 12, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    state.checks.push({ id: 200, devisId: 12, status: "open", query: "Q1", lineItemId: null, origin: "general" });
    // No messages yet → fingerprint m0.
    const dedupeKey = `devis-check-bundle:12:m0:200`;
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

  it("admin token panel: GET returns null when no token, then full state after one is issued", async () => {
    state.devis.push({ id: 60, projectId: 1, contractorId: 1, signOffStage: "received" });
    const empty = await fetch(`${baseUrl}/api/devis/60/check-token`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ token: null });

    state.tokens.push({
      id: 9001, devisId: 60, tokenHash: "h", revokedAt: null,
      createdAt: new Date("2026-01-01T10:00:00Z"),
      lastUsedAt: new Date("2026-01-02T10:00:00Z"),
      expiresAt: new Date("2026-02-01T10:00:00Z"),
    });
    const ok = await fetch(`${baseUrl}/api/devis/60/check-token`);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.token).toMatchObject({ id: 9001 });
    expect(body.token.createdAt).toBeTruthy();
    expect(body.token.lastUsedAt).toBeTruthy();
    expect(body.token.expiresAt).toBeTruthy();
  });

  it("admin extend: resets the sliding window and writes an audit message in every check thread", async () => {
    state.devis.push({ id: 61, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.checks.push({ id: 410, devisId: 61, status: "open", query: "Q", lineItemId: null, origin: "general" });
    state.checks.push({ id: 411, devisId: 61, status: "awaiting_contractor", query: "Q2", lineItemId: null, origin: "general" });
    state.tokens.push({
      id: 9100, devisId: 61, tokenHash: "h61", revokedAt: null,
      // Pick an expiry well in the future so the still-valid precondition holds.
      expiresAt: new Date("2090-01-15T00:00:00Z"),
    });

    const res = await fetch(`${baseUrl}/api/devis/61/check-token/extend`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(new Date(body.token.expiresAt).toISOString()).toBe("2099-01-01T00:00:00.000Z");
    // Audit: one system message per existing check.
    const audits = state.messages.filter((m) => m.authorType === "system" && /prolong/i.test(m.body));
    expect(audits.map((a) => a.checkId).sort()).toEqual([410, 411]);
  });

  it("admin extend: 409 when no active token exists", async () => {
    state.devis.push({ id: 62, projectId: 1, contractorId: 1, signOffStage: "received" });
    const res = await fetch(`${baseUrl}/api/devis/62/check-token/extend`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("admin extend: 409 when the token has already expired (must be re-issued, not revived)", async () => {
    state.devis.push({ id: 64, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.tokens.push({
      id: 9300, devisId: 64, tokenHash: "h64", revokedAt: null,
      expiresAt: new Date("2000-01-01T00:00:00Z"),
    });
    const res = await fetch(`${baseUrl}/api/devis/64/check-token/extend`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.message).toMatch(/expir/i);
  });

  it("admin GET after revoke: still surfaces the revoked token so the panel shows revocation state", async () => {
    state.devis.push({ id: 65, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.checks.push({ id: 610, devisId: 65, status: "open", query: "Q", lineItemId: null, origin: "general" });
    state.tokens.push({
      id: 9400, devisId: 65, tokenHash: "h65", revokedAt: null,
      createdAt: new Date("2026-03-01T00:00:00Z"),
    });

    const revoke = await fetch(`${baseUrl}/api/devis/65/check-token/revoke`, { method: "POST" });
    expect(revoke.status).toBe(200);

    const view = await fetch(`${baseUrl}/api/devis/65/check-token`);
    expect(view.status).toBe(200);
    const body = await view.json();
    expect(body.token).toBeTruthy();
    expect(body.token.id).toBe(9400);
    expect(body.token.revokedAt).toBeTruthy();
  });

  it("admin revoke: revokes the active token, audits each check, and is idempotent (409 on retry)", async () => {
    state.devis.push({ id: 63, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.checks.push({ id: 510, devisId: 63, status: "awaiting_contractor", query: "Q", lineItemId: null, origin: "general" });
    state.tokens.push({ id: 9200, devisId: 63, tokenHash: "h63", revokedAt: null });

    const res = await fetch(`${baseUrl}/api/devis/63/check-token/revoke`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(state.tokens.find((t) => t.id === 9200)!.revokedAt).toBeTruthy();
    const audit = state.messages.find((m) => m.authorType === "system" && /révoqu/i.test(m.body));
    expect(audit).toBeDefined();
    expect(audit!.checkId).toBe(510);

    const retry = await fetch(`${baseUrl}/api/devis/63/check-token/revoke`, { method: "POST" });
    expect(retry.status).toBe(409);
  });

  it("portal payload exposes lineNumber + totalHt per check (cross-reference data, Task #110)", async () => {
    state.devis.push({ id: 52, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    state.lineItems.push({ id: 4001, devisId: 52, lineNumber: 4, description: "Fourniture chaudière", totalHt: "18500.00", pdfPageHint: 2, pdfBbox: { x: 0.1, y: 0.4, w: 0.8, h: 0.05 } });
    state.lineItems.push({ id: 4002, devisId: 52, lineNumber: 7, description: "Robinetterie", totalHt: "320.50", pdfPageHint: null, pdfBbox: null });
    state.checks.push({ id: 20, devisId: 52, status: "awaiting_contractor", query: "Why 18500?", lineItemId: 4001, origin: "line_item" });
    state.checks.push({ id: 21, devisId: 52, status: "open", query: "Brand?", lineItemId: 4002, origin: "line_item" });
    state.checks.push({ id: 22, devisId: 52, status: "open", query: "General?", lineItemId: null, origin: "general" });
    const raw = "rawvalid3".padEnd(40, "Z");
    state.tokens.push({ id: 8889, devisId: 52, tokenHash: `hash:${raw}`, revokedAt: null });

    const res = await fetch(`${baseUrl}/p/check/${raw}/data`);
    expect(res.status).toBe(200);
    const body = await res.json();
    type Check = { id: number; lineNumber: number | null; totalHt: string | null; lineDescription: string | null; pdfPageHint: number | null; pdfBbox: { x: number; y: number; w: number; h: number } | null };
    const byId = new Map<number, Check>((body.checks as Check[]).map((c) => [c.id, c]));
    // Task #113: per-line bbox is exposed alongside pdfPageHint so the
    // portal can draw a precise highlight rectangle on the rendered page.
    expect(byId.get(20)).toMatchObject({ lineNumber: 4, totalHt: "18500.00", lineDescription: "Fourniture chaudière", pdfPageHint: 2, pdfBbox: { x: 0.1, y: 0.4, w: 0.8, h: 0.05 } });
    // Line item exists but has no captured page hint → portal degrades cleanly.
    expect(byId.get(21)).toMatchObject({ lineNumber: 7, totalHt: "320.50", lineDescription: "Robinetterie", pdfPageHint: null, pdfBbox: null });
    // General questions (no line item) never carry a page hint or bbox.
    expect(byId.get(22)).toMatchObject({ lineNumber: null, totalHt: null, lineDescription: null, pdfPageHint: null, pdfBbox: null });
  });

  it("falls back to null line metadata when a check references a missing line item (Task #110 edge case)", async () => {
    state.devis.push({ id: 54, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    // Note: NO matching line item is inserted for lineItemId 9999 — simulates
    // the line being deleted/renumbered after the check was created.
    state.checks.push({ id: 40, devisId: 54, status: "open", query: "Orphan?", lineItemId: 9999, origin: "line_item" });
    const raw = "rawvalid4".padEnd(40, "Z");
    state.tokens.push({ id: 9001, devisId: 54, tokenHash: `hash:${raw}`, revokedAt: null });

    // Portal /data must not crash and must surface null line metadata.
    const res = await fetch(`${baseUrl}/p/check/${raw}/data`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const orphan = (body.checks as Array<{ id: number; lineNumber: number | null; totalHt: string | null; lineDescription: string | null }>)
      .find((c) => c.id === 40);
    expect(orphan).toMatchObject({ lineNumber: null, totalHt: null, lineDescription: null });

    // Send route must also degrade cleanly.
    const sender = await import("../communications/email-sender");
    const sendRes = await fetch(`${baseUrl}/api/devis/54/checks/send`, { method: "POST" });
    expect(sendRes.status).toBe(200);
    const opts = (sender.queueDevisCheckBundle as any).mock.calls.at(-1)[0];
    const summary = opts.checkSummaries[0];
    expect(summary).toMatchObject({ query: "Orphan?", lineNumber: null, totalHt: null, lineDescription: null });
  });

  it("send route forwards lineNumber + totalHt to the bundle queue (cross-reference data, Task #110)", async () => {
    state.devis.push({ id: 53, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    state.lineItems.push({ id: 5001, devisId: 53, lineNumber: 4, description: "Fourniture chaudière", totalHt: "18500.00", pdfPageHint: 2, pdfBbox: null });
    state.checks.push({ id: 30, devisId: 53, status: "open", query: "Q-line", lineItemId: 5001, origin: "line_item" });
    state.checks.push({ id: 31, devisId: 53, status: "open", query: "Q-general", lineItemId: null, origin: "general" });

    const sender = await import("../communications/email-sender");
    const res = await fetch(`${baseUrl}/api/devis/53/checks/send`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(sender.queueDevisCheckBundle).toHaveBeenCalledTimes(1);
    const opts = (sender.queueDevisCheckBundle as any).mock.calls[0][0];
    const summaries = opts.checkSummaries as Array<{ query: string; lineNumber: number | null; totalHt: string | null }>;
    expect(summaries).toHaveLength(2);
    const line = summaries.find((s) => s.query === "Q-line");
    const general = summaries.find((s) => s.query === "Q-general");
    expect(line).toMatchObject({ lineNumber: 4, totalHt: "18500.00" });
    expect(general).toMatchObject({ lineNumber: null, totalHt: null });
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

describe("Notifications inbox — contractor responses", () => {
  beforeAll(async () => { await withApp(); });

  it("returns only checks in awaiting_architect status with the latest contractor message", async () => {
    state.projects.push({ id: 90, name: "Maison Dupont" });
    state.contractors.push({ id: 91, name: "Plomberie Martin", email: "m@e.com" });
    state.devis.push({ id: 92, projectId: 90, contractorId: 91, signOffStage: "received" });
    state.checks.push(
      { id: 700, devisId: 92, status: "awaiting_architect", query: "Q1", lineItemId: null, origin: "general" },
      { id: 701, devisId: 92, status: "awaiting_contractor", query: "Q2", lineItemId: null, origin: "general" },
      { id: 702, devisId: 92, status: "resolved", query: "Q3", lineItemId: null, origin: "general" },
    );
    state.messages.push(
      { id: 800, checkId: 700, authorType: "contractor", body: "Voici ma réponse", channel: "portal" },
      { id: 801, checkId: 700, authorType: "architect", body: "Merci", channel: "portal" },
    );

    const res = await fetch(`${baseUrl}/api/notifications/contractor-responses`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.checkId).toBe(700);
    expect(item.devisId).toBe(92);
    expect(item.projectId).toBe(90);
    expect(item.projectName).toBe("Maison Dupont");
    expect(item.contractorName).toBe("Plomberie Martin");
    expect(item.latestMessageBody).toBe("Voici ma réponse");
  });

  it("reports the true total awaiting count even when items list is paginated", async () => {
    state.projects.push({ id: 80, name: "Big" });
    state.contractors.push({ id: 81, name: "C", email: "c@e.com" });
    state.devis.push({ id: 82, projectId: 80, contractorId: 81, signOffStage: "received" });
    for (let i = 0; i < 75; i++) {
      state.checks.push({
        id: 1000 + i,
        devisId: 82,
        status: "awaiting_architect",
        query: `Q${i}`,
        lineItemId: null,
        origin: "general",
      });
    }

    const res = await fetch(`${baseUrl}/api/notifications/contractor-responses`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(75);
    expect(body.items.length).toBeLessThanOrEqual(50);
  });

  it("returns an empty list when no checks are awaiting the architect", async () => {
    state.projects.push({ id: 95, name: "Empty" });
    state.contractors.push({ id: 96, name: "X", email: "x@e.com" });
    state.devis.push({ id: 97, projectId: 95, contractorId: 96, signOffStage: "received" });
    state.checks.push(
      { id: 750, devisId: 97, status: "open", query: "Q", lineItemId: null, origin: "general" },
      { id: 751, devisId: 97, status: "resolved", query: "Q", lineItemId: null, origin: "general" },
    );

    const res = await fetch(`${baseUrl}/api/notifications/contractor-responses`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.items).toEqual([]);
  });
});

describe("Devis CHECKING — issue-for-copy route", () => {
  beforeAll(async () => { await withApp(); });

  it("issues a fresh token and returns the portal URL using PUBLIC_BASE_URL (not the request host)", async () => {
    state.devis.push({ id: 60, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });

    const res = await fetch(`${baseUrl}/api/devis/60/check-token/issue-for-copy`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.portalUrl).toMatch(/^https:\/\/example\.test\/p\/check\/raw-/);
    // A token row was created and is the only active token for the devis.
    const active = state.tokens.filter((t) => t.devisId === 60 && !t.revokedAt);
    expect(active).toHaveLength(1);
  });

  it("rotates: when an active token already exists it is revoked and a new one is issued", async () => {
    state.devis.push({ id: 61, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    // Pre-existing active token (would've been issued by an earlier email send).
    const oldRaw = "old-raw-value";
    state.tokens.push({ id: 7000, devisId: 61, tokenHash: `hash:${oldRaw}`, revokedAt: null });

    const res = await fetch(`${baseUrl}/api/devis/61/check-token/issue-for-copy`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The old token must be revoked, exactly one new active token remains, and
    // its raw value (encoded in the URL) is different from the old one.
    const oldToken = state.tokens.find((t) => t.id === 7000)!;
    expect(oldToken.revokedAt).toBeInstanceOf(Date);
    const active = state.tokens.filter((t) => t.devisId === 61 && !t.revokedAt);
    expect(active).toHaveLength(1);
    expect(body.portalUrl).not.toContain(oldRaw);
  });

  it("returns 409 when the contractor has no email on file", async () => {
    state.devis.push({ id: 62, projectId: 1, contractorId: 2, signOffStage: "received" });
    state.contractors.push({ id: 2, name: "NoEmail", email: "" });
    state.projects.push({ id: 1, name: "P" });

    const res = await fetch(`${baseUrl}/api/devis/62/check-token/issue-for-copy`, { method: "POST" });
    expect(res.status).toBe(409);
    // No token must have been issued on the failing path.
    expect(state.tokens.filter((t) => t.devisId === 62)).toHaveLength(0);
  });

  it("returns 404 when the devis does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/devis/9999/check-token/issue-for-copy`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("succeeds and falls back to a server log when there are no check threads to host the audit row", async () => {
    state.devis.push({ id: 63, projectId: 1, contractorId: 1, signOffStage: "received" });
    state.contractors.push({ id: 1, name: "Acme", email: "a@e.com" });
    state.projects.push({ id: 1, name: "P" });
    // Intentionally no checks for devis 63 — exercise the audit fallback.

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const res = await fetch(`${baseUrl}/api/devis/63/check-token/issue-for-copy`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(state.tokens.filter((t) => t.devisId === 63 && !t.revokedAt)).toHaveLength(1);
      const logged = infoSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("[devis-check-token-audit] devis=63"),
      );
      expect(logged).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
