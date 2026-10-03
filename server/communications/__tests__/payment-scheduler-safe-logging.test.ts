import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";

const mocks = vi.hoisted(() => ({
  sendPaymentChase: vi.fn(),
  send: vi.fn(),
  due: vi.fn(),
  milestones: vi.fn(),
  pending: vi.fn(async () => []),
  getUser: vi.fn(async () => ({ email: "synthetic@example.invalid" })),
  markSent: vi.fn(),
}));
vi.mock("../../storage", () => ({
  storage: {
    getDuePaymentReminders: mocks.due,
    getReachedUninvoicedMilestones: mocks.milestones,
    getPendingFeeInvoicesForProjects: mocks.pending,
    getUser: mocks.getUser,
    markDesignContractMilestoneReminderSent: mocks.markSent,
  },
}));
vi.mock("../email-sender", () => ({ sendPaymentChase: mocks.sendPaymentChase }));
vi.mock("../../gmail/client", () => ({
  isGmailConfigured: () => true,
  getUncachableGmailClient: async () => ({ users: { messages: { send: mocks.send } } }),
}));
import { startScheduler, stopScheduler } from "../payment-scheduler";

const sentinels = [
  "synthetic-Authorization-bearer-value",
  "synthetic-refresh-request-value",
  "postgresql://synthetic:synthetic-password@invalid.example/db",
  "synthetic-bind-parameter",
];
function failure() {
  return Object.assign(new Error(sentinels.join(" ")), {
    cause: { code: "23505", params: sentinels },
    config: {
      headers: { Authorization: sentinels[0] },
      data: { refresh_token: sentinels[1] },
      url: sentinels[2],
    },
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.due.mockResolvedValue([]);
  mocks.milestones.mockResolvedValue([]);
});
afterEach(() => {
  stopScheduler();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scheduled Gmail failure logs", () => {
  it.each(["payment chase", "digest", "reminder query", "digest query"])(
    "keeps %s failures safe through startup and recurring timer boundaries",
    async (stage) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const infoLog = vi.spyOn(console, "log").mockImplementation(() => {});
      if (stage === "payment chase") {
        mocks.due.mockResolvedValue([{ id: 17 }]);
        mocks.sendPaymentChase.mockRejectedValue(failure());
      } else if (stage === "digest") {
        mocks.milestones.mockResolvedValue([{
          project: { id: 3, code: "SYN", name: "Synthetic project" },
          contract: { uploadedByUserId: 42 },
          milestone: { id: 9, reachedAt: new Date(), labelFr: "Synthetic", amountTtc: "100.00" },
        }]);
        mocks.send.mockRejectedValue(failure());
      } else if (stage === "reminder query") {
        mocks.due.mockRejectedValue(failure());
      } else {
        mocks.milestones.mockRejectedValue(failure());
      }
      startScheduler(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(errorLog).toHaveBeenCalledTimes(2);
      const calls = [...errorLog.mock.calls, ...infoLog.mock.calls];
      expect(calls.flat().every((arg) => typeof arg === "string")).toBe(true);
      const output = inspect(calls, { depth: null });
      for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
      expect(output).toContain("database_unique_violation");
      if (stage === "payment chase") expect(mocks.sendPaymentChase).toHaveBeenCalledTimes(2);
      if (stage === "digest") {
        expect(mocks.send).toHaveBeenCalledTimes(2);
        expect(mocks.markSent).not.toHaveBeenCalled();
      }
    },
  );
});