import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Task #466 — sender-identity selection in sendCommunication:
 *
 *  - the INITIATING user's linked Gmail client is used when they linked
 *    their mailbox, and sent_via_user_id records exactly that user;
 *  - no sentByUserId → connector send, sent_via_user_id stays null even
 *    when OTHER users have linked mailboxes (we never substitute someone
 *    else's mailbox);
 *  - connector-less deployments: a linked per-user client is sufficient —
 *    isGmailConfigured() is only consulted on the connector fallback;
 *  - unlinked sender + unconfigured connector → the send fails loudly.
 */

const { state, storageSpy, connectorSend, userSend } = vi.hoisted(() => {
  const state = {
    comms: [] as Array<Record<string, unknown> & { id: number; status: string }>,
    users: new Map<number, Record<string, unknown>>(),
    connectorConfigured: true,
  };
  const connectorSend = vi.fn(async () => ({ data: { id: "conn_msg", threadId: "conn_thr" } }));
  const userSend = vi.fn(async () => ({ data: { id: "user_msg", threadId: "user_thr" } }));
  const storageSpy = {
    getProjectCommunication: vi.fn(async (id: number) => state.comms.find((c) => c.id === id)),
    updateProjectCommunication: vi.fn(async (id: number, patch: Record<string, unknown>) => {
      const row = state.comms.find((c) => c.id === id);
      if (row) Object.assign(row, patch);
      return row;
    }),
    // Task #543 — atomic dispatch claim contract: only queued/failed/draft
    // rows are claimable; the claim flips them to "sending".
    claimProjectCommunicationForSending: vi.fn(async (id: number) => {
      const row = state.comms.find((c) => c.id === id);
      if (!row || !["queued", "failed", "draft"].includes(row.status)) return undefined;
      Object.assign(row, { status: "sending", archivedAt: null });
      return row;
    }),
    getUser: vi.fn(async (id: number) => state.users.get(id)),
  };
  return { state, storageSpy, connectorSend, userSend };
});

vi.mock("../../storage", () => ({ storage: storageSpy }));
vi.mock("../../gmail/client", () => ({
  isGmailConfigured: () => state.connectorConfigured,
  isFakeGmailMode: () => false,
  getUncachableGmailClient: vi.fn(async () => ({
    users: { messages: { send: connectorSend } },
  })),
}));
vi.mock("../../gmail/user-client", () => ({
  getGmailClientForUser: vi.fn(async (user: { gmailRefreshToken?: string | null }) => {
    if (!user.gmailRefreshToken) throw new Error("not linked");
    return { users: { messages: { send: userSend } } };
  }),
}));
vi.mock("../../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(),
  uploadDocument: vi.fn(),
}));
vi.mock("../certificat-generator", () => ({
  generateCertificatPdf: vi.fn(),
  buildCertificatEmailBody: vi.fn(),
}));
vi.mock("../../env", () => ({ env: {} }));

import { sendCommunication } from "../email-sender";

let nextId = 1;
function seedComm(): number {
  const id = nextId++;
  state.comms.push({
    id,
    status: "queued",
    recipientEmail: "client@example.com",
    subject: "Certificat",
    body: "corps",
    attachmentStorageKeys: [],
  });
  return id;
}

beforeEach(() => {
  state.comms.length = 0;
  state.users.clear();
  state.connectorConfigured = true;
  connectorSend.mockClear();
  userSend.mockClear();
});

describe("sendCommunication sender identity (Task #466)", () => {
  it("sends via the initiating user's linked client and records sent_via_user_id", async () => {
    state.users.set(7, { id: 7, gmailRefreshToken: "rt-7" });
    const id = seedComm();
    await sendCommunication(id, { sentByUserId: 7 });
    expect(userSend).toHaveBeenCalledTimes(1);
    expect(connectorSend).not.toHaveBeenCalled();
    const row = state.comms[0];
    expect(row.status).toBe("sent");
    expect(row.sentViaUserId).toBe(7);
  });

  it("never substitutes another linked user's mailbox: no sentByUserId → connector, null owner", async () => {
    state.users.set(7, { id: 7, gmailRefreshToken: "rt-7" }); // someone ELSE is linked
    const id = seedComm();
    await sendCommunication(id);
    expect(connectorSend).toHaveBeenCalledTimes(1);
    expect(userSend).not.toHaveBeenCalled();
    expect(state.comms[0].sentViaUserId).toBeNull();
  });

  it("unlinked sender falls back to the connector with null owner", async () => {
    state.users.set(9, { id: 9, gmailRefreshToken: null });
    const id = seedComm();
    await sendCommunication(id, { sentByUserId: 9 });
    expect(connectorSend).toHaveBeenCalledTimes(1);
    expect(state.comms[0].sentViaUserId).toBeNull();
  });

  it("connector-less deployment: a linked sender can still send", async () => {
    state.connectorConfigured = false;
    state.users.set(7, { id: 7, gmailRefreshToken: "rt-7" });
    const id = seedComm();
    await sendCommunication(id, { sentByUserId: 7 });
    expect(userSend).toHaveBeenCalledTimes(1);
    expect(state.comms[0].sentViaUserId).toBe(7);
  });

  it("unlinked sender + unconfigured connector fails loudly and marks the comm failed", async () => {
    state.connectorConfigured = false;
    const id = seedComm();
    await expect(sendCommunication(id, { sentByUserId: 42 })).rejects.toThrow(/Gmail not configured/);
    expect(state.comms[0].status).toBe("failed");
  });
});
