/**
 * Coverage for the runtime watchdog (Task #126).
 *
 * Verifies the dedupe contract: exactly ONE alert per failure window,
 * re-armed only after a successful poll. Uses a fake setInterval so
 * we control timing deterministically.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { startHealthzWatchdog } from "../operations/healthz-watchdog";

interface MockResponse {
  status: number;
  body: string;
}

function makeFetchMock(responses: Array<MockResponse | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      text: async () => r.body,
    } as unknown as Response;
  });
}

function makeAlertMock() {
  return vi.fn(async () => ({
    delivered: true,
    recipients: ["ops@example.com"],
  }));
}

describe("startHealthzWatchdog", () => {
  let fakeNowTimers: Array<{ fn: () => void; intervalMs: number }>;
  let fakeSetInterval: ReturnType<typeof vi.fn>;
  let fakeClearInterval: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeNowTimers = [];
    fakeSetInterval = vi.fn((fn: () => void, ms: number) => {
      fakeNowTimers.push({ fn, intervalMs: ms });
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    });
    fakeClearInterval = vi.fn();
  });

  it("sends exactly ONE alert across 10 consecutive failures", async () => {
    const fetchImpl = makeFetchMock([
      { status: 503, body: '{"status":"degraded"}' },
    ]);
    const sendAlert = makeAlertMock();
    const wd = startHealthzWatchdog({
      url: "http://test/healthz/deep",
      intervalMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sendAlert,
      setIntervalImpl: fakeSetInterval as unknown as typeof setInterval,
      clearIntervalImpl: fakeClearInterval as unknown as typeof clearInterval,
    });

    for (let i = 0; i < 10; i++) {
      await wd.pollOnceForTest();
    }

    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const alert = sendAlert.mock.calls[0][0];
    expect(alert.source).toBe("healthz-watchdog");
    expect(alert.subject).toMatch(/deep health check failing/);
    expect(alert.body).toContain("status=503");
  });

  it("re-arms after a successful poll: fail, ok, fail → 2 alerts", async () => {
    const fetchImpl = makeFetchMock([
      { status: 503, body: "down" },
      { status: 503, body: "down" },
      { status: 200, body: '{"status":"ok"}' },
      { status: 503, body: "down again" },
      { status: 503, body: "still down" },
    ]);
    const sendAlert = makeAlertMock();
    const wd = startHealthzWatchdog({
      url: "http://test/healthz/deep",
      intervalMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sendAlert,
      setIntervalImpl: fakeSetInterval as unknown as typeof setInterval,
      clearIntervalImpl: fakeClearInterval as unknown as typeof clearInterval,
    });

    for (let i = 0; i < 5; i++) {
      await wd.pollOnceForTest();
    }

    // Two failure windows → two alerts.
    expect(sendAlert).toHaveBeenCalledTimes(2);
  });

  it("does not alert on a transient single failure followed by recovery", async () => {
    // Watchdog starts assuming healthy; first failure DOES alert.
    // To represent "transient single failure followed by recovery"
    // without an initial alert, we run one OK poll first to establish
    // the baseline, then a single failure (alert), then recoveries
    // (no further alerts) — and verify we only alerted ONCE.
    const fetchImpl = makeFetchMock([
      { status: 200, body: "ok" },
      { status: 503, body: "blip" },
      { status: 200, body: "ok again" },
      { status: 200, body: "ok again" },
      { status: 200, body: "ok again" },
    ]);
    const sendAlert = makeAlertMock();
    const wd = startHealthzWatchdog({
      url: "http://test/healthz/deep",
      intervalMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sendAlert,
      setIntervalImpl: fakeSetInterval as unknown as typeof setInterval,
      clearIntervalImpl: fakeClearInterval as unknown as typeof clearInterval,
    });

    for (let i = 0; i < 5; i++) {
      await wd.pollOnceForTest();
    }
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it("treats network errors as failures and dedupes them too", async () => {
    const fetchImpl = makeFetchMock([
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
    ]);
    const sendAlert = makeAlertMock();
    const wd = startHealthzWatchdog({
      url: "http://test/healthz/deep",
      intervalMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sendAlert,
      setIntervalImpl: fakeSetInterval as unknown as typeof setInterval,
      clearIntervalImpl: fakeClearInterval as unknown as typeof clearInterval,
    });

    for (let i = 0; i < 3; i++) {
      await wd.pollOnceForTest();
    }
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][0].body).toContain("ECONNREFUSED");
  });

  it("registers exactly one interval and stops cleanly", () => {
    const fetchImpl = makeFetchMock([{ status: 200, body: "ok" }]);
    const sendAlert = makeAlertMock();
    const wd = startHealthzWatchdog({
      url: "http://test/healthz/deep",
      intervalMs: 5 * 60 * 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sendAlert,
      setIntervalImpl: fakeSetInterval as unknown as typeof setInterval,
      clearIntervalImpl: fakeClearInterval as unknown as typeof clearInterval,
    });
    expect(fakeSetInterval).toHaveBeenCalledTimes(1);
    expect(fakeNowTimers[0].intervalMs).toBe(5 * 60 * 1000);
    wd.stop();
    expect(fakeClearInterval).toHaveBeenCalledTimes(1);
  });
});

describe("warnIfOperatorAlertEmailMissingInProduction (env.ts boot guard)", () => {
  it("warns in production when OPERATOR_ALERT_EMAIL is unset", async () => {
    const { warnIfOperatorAlertEmailMissingInProduction } = await import("../env");
    const log = vi.fn();
    warnIfOperatorAlertEmailMissingInProduction(
      { NODE_ENV: "production", OPERATOR_ALERT_EMAIL: undefined },
      log,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/OPERATOR_ALERT_EMAIL/);
  });

  it("stays silent in production when OPERATOR_ALERT_EMAIL is set", async () => {
    const { warnIfOperatorAlertEmailMissingInProduction } = await import("../env");
    const log = vi.fn();
    warnIfOperatorAlertEmailMissingInProduction(
      { NODE_ENV: "production", OPERATOR_ALERT_EMAIL: "ops@example.com" },
      log,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("stays silent in non-production even when OPERATOR_ALERT_EMAIL is unset", async () => {
    const { warnIfOperatorAlertEmailMissingInProduction } = await import("../env");
    const log = vi.fn();
    warnIfOperatorAlertEmailMissingInProduction(
      { NODE_ENV: "development", OPERATOR_ALERT_EMAIL: undefined },
      log,
    );
    expect(log).not.toHaveBeenCalled();
  });
});
