import { describe, it, expect, vi } from "vitest";
import {
  detectMisconfiguredArchidocBaseUrl,
  warnIfArchidocBaseUrlMisconfigured,
} from "../env";

describe("detectMisconfiguredArchidocBaseUrl", () => {
  it("flags a replit.dev host in production (the original Task #164 incident)", () => {
    expect(
      detectMisconfiguredArchidocBaseUrl({
        NODE_ENV: "production",
        ARCHIDOC_BASE_URL: "https://riker-7-archidoc.user.replit.dev",
      }),
    ).toBe("riker-7-archidoc.user.replit.dev");
  });

  it("flags localhost / 127.0.0.1 / staging hosts in production", () => {
    for (const url of [
      "https://localhost:8080",
      "http://127.0.0.1:5000",
      "https://archidoc-staging.example.com",
      "https://staging.archidoc.example.com",
      "https://archidoc-staging.example.com",
    ]) {
      expect(
        detectMisconfiguredArchidocBaseUrl({
          NODE_ENV: "production",
          ARCHIDOC_BASE_URL: url,
        }),
      ).not.toBeNull();
    }
  });

  it("returns null for a clean production host", () => {
    expect(
      detectMisconfiguredArchidocBaseUrl({
        NODE_ENV: "production",
        ARCHIDOC_BASE_URL: "https://archidoc.example.com",
      }),
    ).toBeNull();
  });

  it("returns null when not in production even for replit.dev", () => {
    for (const nodeEnv of ["development", "test"] as const) {
      expect(
        detectMisconfiguredArchidocBaseUrl({
          NODE_ENV: nodeEnv,
          ARCHIDOC_BASE_URL: "https://x.replit.dev",
        }),
      ).toBeNull();
    }
  });

  it("returns null when ARCHIDOC_BASE_URL is unset", () => {
    expect(
      detectMisconfiguredArchidocBaseUrl({
        NODE_ENV: "production",
        ARCHIDOC_BASE_URL: undefined,
      }),
    ).toBeNull();
  });
});

describe("warnIfArchidocBaseUrlMisconfigured", () => {
  it("logs a clear WARN naming the offending host in production", () => {
    const log = vi.fn();
    warnIfArchidocBaseUrlMisconfigured(
      {
        NODE_ENV: "production",
        ARCHIDOC_BASE_URL: "https://riker.replit.dev",
      },
      log,
    );
    expect(log).toHaveBeenCalledTimes(1);
    const msg = (log as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(msg).toContain("ARCHIDOC_BASE_URL");
    expect(msg).toContain("riker.replit.dev");
    expect(msg).toContain("WARN");
  });

  it("stays silent for a clean production host", () => {
    const log = vi.fn();
    warnIfArchidocBaseUrlMisconfigured(
      {
        NODE_ENV: "production",
        ARCHIDOC_BASE_URL: "https://archidoc.example.com",
      },
      log,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("stays silent in non-production environments", () => {
    const log = vi.fn();
    warnIfArchidocBaseUrlMisconfigured(
      {
        NODE_ENV: "development",
        ARCHIDOC_BASE_URL: "https://riker.replit.dev",
      },
      log,
    );
    expect(log).not.toHaveBeenCalled();
  });
});
