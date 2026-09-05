import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, storageSpy, gmailSpy } = vi.hoisted(() => {
  const state = {
    communication: null as null | Record<string, any>,
    providerAccepted: false,
    failFirstSuccessWrite: true,
  };
  const gmailSpy = {
    send: vi.fn(async () => {
      state.providerAccepted = true;
      return { data: { id: "gmail-501", threadId: "thread-501" } };
    }),
    list: vi.fn(async () => ({
      data: {
        messages: state.providerAccepted
          ? [{ id: "gmail-501", threadId: "thread-501" }]
          : [],
      },
    })),
    get: vi.fn(async () => ({
      data: {
        id: "gmail-501",
        threadId: "thread-501",
        internalDate: String(new Date("2026-09-05T09:01:00.000Z").getTime()),
      },
    })),
  };
  const storageSpy = {
    claimProjectCommunicationForSending: vi.fn(async () => {
      const comm = state.communication;
      if (!comm || !["queued", "failed", "draft"].includes(comm.status)) return undefined;
      comm.status = "sending";
      return comm;
    }),
    getProjectCommunication: vi.fn(async () => state.communication),
    getUser: vi.fn(async () => ({ id: 7, gmailRefreshToken: "refresh-token" })),
    updateProjectCommunication: vi.fn(async (_id: number, patch: Record<string, unknown>) => {
      Object.assign(state.communication!, patch);
      return state.communication;
    }),
    markProjectCommunicationSent: vi.fn(async (_id: number, patch: Record<string, unknown>) => {
      if (state.failFirstSuccessWrite) {
        state.failFirstSuccessWrite = false;
        throw new Error("database timeout after Gmail accepted");
      }
      Object.assign(state.communication!, patch, { status: "sent" });
      return state.communication;
    }),
  };
  return { state, storageSpy, gmailSpy };
});

vi.mock("../../storage", () => ({ storage: storageSpy }));
vi.mock("../../gmail/client", () => ({
  isGmailConfigured: () => true,
  isFakeGmailMode: () => false,
  getUncachableGmailClient: vi.fn(async () => ({ users: { messages: gmailSpy } })),
}));
vi.mock("../../gmail/user-client", () => ({
  getGmailClientForUser: vi.fn(async () => ({ users: { messages: gmailSpy } })),
}));
vi.mock("../../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(),
  uploadDocument: vi.fn(),
}));
vi.mock("../certificat-generator", () => ({
  generateCertificatPdf: vi.fn(),
  buildCertificatEmailBody: vi.fn(),
}));
vi.mock("../../env", () => ({
  env: { PUBLIC_BASE_URL: "https://architrak.test", SESSION_SECRET: "test-session-secret" },
}));

import {
  CommunicationDeliveryAwaitingConfirmationError,
  communicationProviderMessageId,
  sendCommunication,
} from "../email-sender";
import {
  encryptCommunicationBody,
  PROTECTED_CLIENT_LINK_LABEL,
} from "../../services/communication-body-crypto";

beforeEach(() => {
  vi.clearAllMocks();
  state.providerAccepted = false;
  state.failFirstSuccessWrite = true;
  state.communication = {
    id: 501,
    projectId: 9,
    type: "devis_client_link",
    recipientType: "client",
    recipientEmail: "marie@example.test",
    recipientName: "Marie",
    subject: "Devis D-100 — Maison",
    body: `Please review\n${PROTECTED_CLIENT_LINK_LABEL}`,
    encryptedBody: encryptCommunicationBody(
      "Please review\nhttps://architrak.test/p/client/raw-token",
    ),
    status: "queued",
    sentAt: null,
    sentViaUserId: null,
    dedupeKey: "devis-client-link:71",
    attachmentStorageKeys: [],
    relatedCertificatId: null,
  };
});

describe("client-link Gmail reconciliation", () => {
  it("reconciles a provider-accepted send after a failed success write without sending twice", async () => {
    await expect(sendCommunication(501, { sentByUserId: 7 }))
      .rejects.toThrow("database timeout after Gmail accepted");
    expect(gmailSpy.send).toHaveBeenCalledTimes(1);
    const firstSend = gmailSpy.send.mock.calls[0]?.[0] as {
      requestBody: { raw: string };
    };
    expect(Buffer.from(firstSend.requestBody.raw, "base64url").toString("utf8"))
      .toContain("https://architrak.test/p/client/raw-token");
    expect(state.communication?.status).toBe("sending");
    expect(state.communication?.sentViaUserId).toBe(7);

    await sendCommunication(501, { sentByUserId: 7 });

    expect(gmailSpy.send).toHaveBeenCalledTimes(1);
    expect(gmailSpy.list).toHaveBeenCalledWith(expect.objectContaining({
      q: expect.stringContaining("rfc822msgid:architrak-"),
    }));
    expect(state.communication).toMatchObject({
      status: "sent",
      emailMessageId: "gmail-501",
      emailThreadId: "thread-501",
      sentAt: new Date("2026-09-05T09:01:00.000Z"),
    });
  });

  it("reconciles by the unique portal token when Gmail rewrites Message-ID", async () => {
    await expect(sendCommunication(501, { sentByUserId: 7 }))
      .rejects.toThrow("database timeout after Gmail accepted");
    gmailSpy.list
      .mockResolvedValueOnce({ data: { messages: [] } })
      .mockResolvedValueOnce({
        data: { messages: [{ id: "gmail-501", threadId: "thread-501" }] },
      });

    await sendCommunication(501, { sentByUserId: 7 });

    expect(gmailSpy.send).toHaveBeenCalledTimes(1);
    expect(gmailSpy.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        q: 'in:sent "raw-token"',
      }),
    );
    expect(state.communication).toMatchObject({
      status: "sent",
      emailMessageId: "gmail-501",
      emailThreadId: "thread-501",
    });
  });

  it("reports an accepted send as awaiting confirmation while Gmail is still indexing it", async () => {
    state.communication!.status = "sending";
    state.communication!.sentViaUserId = 7;
    state.communication!.emailMessageId = "gmail-501";
    state.providerAccepted = false;

    await expect(sendCommunication(501, { sentByUserId: 7 }))
      .rejects.toBeInstanceOf(CommunicationDeliveryAwaitingConfirmationError);

    expect(gmailSpy.send).not.toHaveBeenCalled();
    expect(gmailSpy.list).toHaveBeenCalledTimes(2);
    expect(state.communication?.status).toBe("sending");
  });

  it("keeps provider-accepted evidence awaiting confirmation when lookup is temporarily unavailable", async () => {
    state.communication!.status = "sending";
    state.communication!.sentViaUserId = 7;
    state.communication!.emailMessageId = "gmail-501";
    gmailSpy.list.mockRejectedValueOnce(new Error("Gmail search unavailable"));

    await expect(sendCommunication(501, { sentByUserId: 7 }))
      .rejects.toBeInstanceOf(CommunicationDeliveryAwaitingConfirmationError);

    expect(gmailSpy.send).not.toHaveBeenCalled();
    expect(state.communication?.status).toBe("sending");
  });

  it("keeps a pre-send or abandoned claim as ordinary in-progress work", async () => {
    state.communication!.status = "sending";
    state.communication!.sentViaUserId = 7;
    state.communication!.emailMessageId = null;
    state.providerAccepted = false;

    await expect(sendCommunication(501, { sentByUserId: 7 }))
      .rejects.toMatchObject({ name: "CommunicationSendInProgressError" });

    expect(gmailSpy.send).not.toHaveBeenCalled();
    expect(gmailSpy.list).toHaveBeenCalledTimes(2);
    expect(state.communication?.status).toBe("sending");
  });

  it("uses a deterministic RFC Message-ID for all attempts of one communication", () => {
    const first = communicationProviderMessageId(state.communication as any);
    const second = communicationProviderMessageId({ ...state.communication } as any);
    expect(first).toBe(second);
    expect(first).toMatch(/^<architrak-[a-f0-9]{32}@mail\.architrak\.app>$/);
  });

  it("does not require Gmail read scope before a fresh client-link send", async () => {
    gmailSpy.list.mockRejectedValueOnce(new Error("insufficientPermissions"));

    await expect(sendCommunication(501)).rejects.toThrow(
      "database timeout after Gmail accepted",
    );

    expect(gmailSpy.list).not.toHaveBeenCalled();
    expect(gmailSpy.send).toHaveBeenCalledTimes(1);
    expect(state.communication).toMatchObject({
      status: "sending",
      sentViaUserId: null,
    });
  });
});
