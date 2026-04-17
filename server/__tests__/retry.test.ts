import { describe, it, expect } from "vitest";
import { retry } from "../lib/retry";

describe("retry helper", () => {
  it("returns the result on first success", async () => {
    let calls = 0;
    const out = await retry(async () => {
      calls += 1;
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries until success up to the configured retry count", async () => {
    let calls = 0;
    const out = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
        return "done";
      },
      { retries: 3, baseMs: 1, jitter: false },
    );
    expect(out).toBe("done");
    expect(calls).toBe(3);
  });

  it("propagates the last error after exhausting retries", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new Error(`fail ${calls}`);
        },
        { retries: 2, baseMs: 1, jitter: false },
      ),
    ).rejects.toThrow(/fail 3/);
    expect(calls).toBe(3);
  });

  it("does not retry when shouldRetry returns false", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new Error("fatal");
        },
        { retries: 5, baseMs: 1, jitter: false, shouldRetry: () => false },
      ),
    ).rejects.toThrow(/fatal/);
    expect(calls).toBe(1);
  });
});
