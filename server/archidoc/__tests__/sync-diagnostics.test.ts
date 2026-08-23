import { describe, expect, it } from "vitest";
import { toSafeArchidocSyncFailure } from "../sync-diagnostics";

describe("ArchiDoc sync diagnostic redaction", () => {
  it("maps a rejected credential to a fixed safe reason", () => {
    expect(
      toSafeArchidocSyncFailure(
        "unauthorized: ArchiDoc rejected the configured sync credential. (HTTP 401, 19ms)",
      ),
    ).toEqual({
      code: "unauthorized",
      reason: "ArchiDoc rejected the configured sync credential.",
    });
  });

  it("redacts unrecognised upstream and credential details", () => {
    const failure = toSafeArchidocSyncFailure(
      "Unexpected upstream response: bearer production-secret / private response body",
    );

    expect(failure).toEqual({
      code: "sync_failure",
      reason: "The latest ArchiDoc sync failed. Check the safe deployment diagnostics.",
    });
    expect(JSON.stringify(failure)).not.toContain("production-secret");
    expect(JSON.stringify(failure)).not.toContain("private response body");
  });
});