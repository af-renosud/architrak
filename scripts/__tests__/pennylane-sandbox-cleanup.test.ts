import { describe, expect, it } from "vitest";
import { isSandboxBaseUrl } from "../pennylane-sandbox-cleanup";

describe("isSandboxBaseUrl", () => {
  it("accepts known sandbox hostnames", () => {
    expect(isSandboxBaseUrl("https://app.sandbox.pennylane.com/api/external/v2").ok).toBe(true);
    expect(isSandboxBaseUrl("https://sandbox.pennylane.com").ok).toBe(true);
    expect(isSandboxBaseUrl("https://staging.pennylane.com/anything").ok).toBe(true);
  });

  it("rejects the production host even with a 'test' path or query", () => {
    expect(isSandboxBaseUrl("https://app.pennylane.com").ok).toBe(false);
    expect(isSandboxBaseUrl("https://app.pennylane.com/test").ok).toBe(false);
    expect(isSandboxBaseUrl("https://app.pennylane.com/?env=test").ok).toBe(false);
    expect(isSandboxBaseUrl("https://app.pennylane.com/?host=sandbox.pennylane.com").ok).toBe(false);
  });

  it("rejects attacker-crafted hostnames that append extra labels", () => {
    expect(isSandboxBaseUrl("https://sandbox.pennylane.com.evil.com").ok).toBe(false);
    expect(isSandboxBaseUrl("https://test.pennylane.com.attacker.io").ok).toBe(false);
    expect(isSandboxBaseUrl("https://sandbox.pennylane.evil.com").ok).toBe(false);
  });

  it("rejects malformed URLs and unsupported protocols", () => {
    expect(isSandboxBaseUrl("not a url").ok).toBe(false);
    expect(isSandboxBaseUrl("ftp://sandbox.pennylane.com").ok).toBe(false);
  });
});
