import { describe, it, expect, vi } from "vitest";
import { assertNoDevLoginBackdoorInProduction } from "../env";

describe("assertNoDevLoginBackdoorInProduction", () => {
  it("exits with a clear error when NODE_ENV=production and ENABLE_DEV_LOGIN_FOR_E2E is true", () => {
    const exit = vi.fn(() => {
      throw new Error("__exit__");
    }) as unknown as (code: number) => never;
    const log = vi.fn();

    expect(() =>
      assertNoDevLoginBackdoorInProduction(
        { NODE_ENV: "production", ENABLE_DEV_LOGIN_FOR_E2E: true },
        exit,
        log,
      ),
    ).toThrow("__exit__");

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    const msg = (log as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(msg).toContain("ENABLE_DEV_LOGIN_FOR_E2E");
    expect(msg).toContain("NODE_ENV=production");
    expect(msg.toLowerCase()).toContain("refusing to start");
  });

  it("does not exit when ENABLE_DEV_LOGIN_FOR_E2E is false in production", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const log = vi.fn();
    assertNoDevLoginBackdoorInProduction(
      { NODE_ENV: "production", ENABLE_DEV_LOGIN_FOR_E2E: false },
      exit,
      log,
    );
    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not exit when ENABLE_DEV_LOGIN_FOR_E2E is true outside production", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const log = vi.fn();
    for (const nodeEnv of ["development", "test"] as const) {
      assertNoDevLoginBackdoorInProduction(
        { NODE_ENV: nodeEnv, ENABLE_DEV_LOGIN_FOR_E2E: true },
        exit,
        log,
      );
    }
    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
