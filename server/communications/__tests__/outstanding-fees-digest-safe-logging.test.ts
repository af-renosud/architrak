import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  summary: vi.fn(),
  settings: { OUTSTANDING_FEES_DIGEST_HOUR: 8, get OUTSTANDING_FEES_DIGEST_RECIPIENTS() { return "synthetic@example.invalid"; } },
}));
vi.mock("../../env", () => ({ env: mocks.settings }));
vi.mock("../../gmail/client", () => ({
  isGmailConfigured: () => true,
  getUncachableGmailClient: async () => ({ users: { messages: { send: mocks.send } } }),
}));
vi.mock("../../services/outstanding-fees.service", () => ({ getOutstandingFeesGlobal: mocks.summary }));
import {
  processOutstandingFeesDigest, startOutstandingFeesDigestScheduler,
  __resetOutstandingFeesDigestForTests,
} from "../outstanding-fees-digest";

const sentinels = [
  "synthetic-Authorization-secret", "synthetic-refresh-token",
  "postgresql://synthetic:synthetic-password@invalid.example/db", "synthetic-query-bind-value",
];
function failure() {
  return Object.assign(new Error(sentinels.join(" ")), {
    code: 401, params: sentinels,
    config: { headers: { Authorization: sentinels[0] }, data: { refresh_token: sentinels[1] } },
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 4, 11, 8, 0, 0));
  mocks.summary.mockResolvedValue({ totalCount: 1, totalFeeHt: 100, buckets: [], byProject: [], entries: [] });
});
afterEach(() => {
  __resetOutstandingFeesDigestForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function assertSafe(calls: unknown[][]) {
  expect(calls.flat().every((arg) => typeof arg === "string")).toBe(true);
  const output = inspect(calls, { depth: null });
  for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
  expect(output).toContain("http_401");
}
describe("weekly Gmail digest credential-safe logs", () => {
  it("redacts a failed Gmail send and leaves it retryable on the next tick", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.send.mockRejectedValue(failure());
    await processOutstandingFeesDigest();
    startOutstandingFeesDigestScheduler(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    assertSafe(log.mock.calls);
  });
  it("redacts rejections thrown before the inner send catch at the recurring timer boundary", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    startOutstandingFeesDigestScheduler(1000);
    // Fail the preflight read outside processOutstandingFeesDigest's try/catch.
    const getter = vi.spyOn(mocks.settings, "OUTSTANDING_FEES_DIGEST_RECIPIENTS", "get");
    getter.mockImplementation(() => { throw failure(); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("tick error");
    assertSafe(log.mock.calls);
  });
});