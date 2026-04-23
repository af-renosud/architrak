import { describe, it, expect, vi, beforeEach } from "vitest";

// Verify the operator-alert helper used by post-deploy maintenance scripts:
//  - no-recipients: returns delivered=false WITHOUT touching Gmail (so the
//    helper is safe to call from local dev / CI where the operator inbox
//    isn't configured).
//  - gmail-not-configured: returns delivered=false without throwing even
//    when recipients are present.
//  - happy path: encodes a valid base64url RFC 822 envelope addressed to
//    every recipient and tags subject + footer with the source/deploy.
//  - gmail send failure: surfaces reason in the result without throwing
//    (callers MUST NOT abort the underlying maintenance job because the
//    alert plumbing failed).

const { gmailSendMock, isConfiguredMock, envOverrides } = vi.hoisted(() => ({
  gmailSendMock: vi.fn(),
  isConfiguredMock: vi.fn(),
  envOverrides: {
    OPERATOR_ALERT_EMAIL: undefined as string | undefined,
    REPLIT_DEPLOYMENT_ID: undefined as string | undefined,
    REPL_ID: undefined as string | undefined,
    REPL_SLUG: undefined as string | undefined,
  },
}));

vi.mock("../../env", () => ({
  get env() {
    return envOverrides;
  },
}));
vi.mock("../../gmail/client", () => ({
  getUncachableGmailClient: async () => ({
    users: { messages: { send: gmailSendMock } },
  }),
  isGmailConfigured: () => isConfiguredMock(),
}));

import {
  parseRecipients,
  buildAlertFooter,
  sendOperatorAlert,
} from "../operator-alerts";

beforeEach(() => {
  vi.clearAllMocks();
  envOverrides.OPERATOR_ALERT_EMAIL = undefined;
  envOverrides.REPLIT_DEPLOYMENT_ID = undefined;
  envOverrides.REPL_ID = undefined;
  envOverrides.REPL_SLUG = undefined;
  isConfiguredMock.mockReturnValue(true);
  gmailSendMock.mockResolvedValue({ data: { id: "x" } });
});

describe("parseRecipients", () => {
  it("splits comma-separated lists, trims, and drops empties", () => {
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients("")).toEqual([]);
    expect(parseRecipients("a@b.co")).toEqual(["a@b.co"]);
    expect(parseRecipients(" a@b.co , c@d.co ,, ")).toEqual([
      "a@b.co",
      "c@d.co",
    ]);
  });
});

describe("buildAlertFooter", () => {
  it("uses REPLIT_DEPLOYMENT_ID when set, falls back through REPL_ID/SLUG, then 'unknown'", () => {
    const t = new Date("2026-04-23T12:00:00Z");
    expect(buildAlertFooter(t)).toContain("Deploy: unknown");
    expect(buildAlertFooter(t)).toContain("Timestamp: 2026-04-23T12:00:00.000Z");

    envOverrides.REPL_SLUG = "my-slug";
    expect(buildAlertFooter(t)).toContain("Deploy: my-slug");

    envOverrides.REPL_ID = "abc-123";
    expect(buildAlertFooter(t)).toContain("Deploy: abc-123");

    envOverrides.REPLIT_DEPLOYMENT_ID = "deploy-xyz";
    expect(buildAlertFooter(t)).toContain("Deploy: deploy-xyz");
  });
});

describe("sendOperatorAlert", () => {
  it("no-ops without recipients and never calls Gmail", async () => {
    const res = await sendOperatorAlert({
      source: "test",
      subject: "hi",
      body: "body",
    });
    expect(res.delivered).toBe(false);
    expect(res.reason).toBe("no-recipients");
    expect(res.recipients).toEqual([]);
    expect(gmailSendMock).not.toHaveBeenCalled();
  });

  it("returns gmail-not-configured without throwing when connector is unavailable", async () => {
    envOverrides.OPERATOR_ALERT_EMAIL = "ops@example.com";
    isConfiguredMock.mockReturnValue(false);

    const res = await sendOperatorAlert({
      source: "test",
      subject: "hi",
      body: "body",
    });
    expect(res.delivered).toBe(false);
    expect(res.reason).toBe("gmail-not-configured");
    expect(res.recipients).toEqual(["ops@example.com"]);
    expect(gmailSendMock).not.toHaveBeenCalled();
  });

  it("delivers a valid base64url envelope tagged with source + every recipient", async () => {
    envOverrides.OPERATOR_ALERT_EMAIL = "ops@a.co, oncall@b.co";
    envOverrides.REPLIT_DEPLOYMENT_ID = "deploy-42";

    const res = await sendOperatorAlert({
      source: "backfill-page-hints",
      subject: "1 parse failure",
      body: "details here",
    });

    expect(res.delivered).toBe(true);
    expect(res.recipients).toEqual(["ops@a.co", "oncall@b.co"]);
    expect(gmailSendMock).toHaveBeenCalledTimes(1);
    const call = gmailSendMock.mock.calls[0][0];
    expect(call.userId).toBe("me");
    const decoded = Buffer.from(call.requestBody.raw, "base64url").toString();
    expect(decoded).toContain("To: ops@a.co, oncall@b.co");
    expect(decoded).toContain("Subject: [ops:backfill-page-hints] 1 parse failure");
    expect(decoded).toContain("details here");
    expect(decoded).toContain("Deploy: deploy-42");
  });

  it("returns delivered=false WITHOUT throwing when Gmail send rejects", async () => {
    envOverrides.OPERATOR_ALERT_EMAIL = "ops@a.co";
    gmailSendMock.mockRejectedValue(new Error("rate limited"));

    const res = await sendOperatorAlert({
      source: "test",
      subject: "hi",
      body: "body",
    });
    expect(res.delivered).toBe(false);
    expect(res.reason).toBe("rate limited");
    expect(res.recipients).toEqual(["ops@a.co"]);
  });
});
