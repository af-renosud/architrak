import { describe, it, expect } from "vitest";
import {
  decideEmailDocRetry,
  EMAIL_DOC_MAX_ATTEMPTS,
  EMAIL_DOC_BACKOFF_MS,
  EMAIL_DOC_BACKLOG_CUTOFF,
} from "../services/email-doc-retry";

describe("decideEmailDocRetry", () => {
  it("retries transient failures with escalating backoff", () => {
    expect(decideEmailDocRetry(1, true)).toEqual({ status: "pending", retryInMs: EMAIL_DOC_BACKOFF_MS[0] });
    expect(decideEmailDocRetry(2, true)).toEqual({ status: "pending", retryInMs: EMAIL_DOC_BACKOFF_MS[1] });
    expect(decideEmailDocRetry(3, true)).toEqual({ status: "pending", retryInMs: EMAIL_DOC_BACKOFF_MS[2] });
    expect(decideEmailDocRetry(4, true)).toEqual({ status: "pending", retryInMs: EMAIL_DOC_BACKOFF_MS[3] });
  });

  it("goes terminal when transient retries are exhausted", () => {
    expect(decideEmailDocRetry(EMAIL_DOC_MAX_ATTEMPTS, true)).toEqual({ status: "failed", retryInMs: null });
    expect(decideEmailDocRetry(EMAIL_DOC_MAX_ATTEMPTS + 3, true)).toEqual({ status: "failed", retryInMs: null });
  });

  it("goes terminal immediately on permanent failures", () => {
    expect(decideEmailDocRetry(1, false)).toEqual({ status: "failed", retryInMs: null });
  });

  it("clamps backoff index beyond the schedule (defensive)", () => {
    // attempts between schedule length and max reuse the last backoff step
    const last = EMAIL_DOC_BACKOFF_MS[EMAIL_DOC_BACKOFF_MS.length - 1];
    expect(decideEmailDocRetry(EMAIL_DOC_MAX_ATTEMPTS - 1, true).retryInMs).toBe(last);
  });

  it("backlog cutoff excludes the written-off pre-July-2026 documents", () => {
    expect(EMAIL_DOC_BACKLOG_CUTOFF.getTime()).toBe(Date.parse("2026-07-01T00:00:00Z"));
    expect(new Date("2026-05-28T12:00:00Z") < EMAIL_DOC_BACKLOG_CUTOFF).toBe(true);
    expect(new Date("2026-08-04T12:00:00Z") >= EMAIL_DOC_BACKLOG_CUTOFF).toBe(true);
  });
});
