import { describe, expect, it } from "vitest";
import {
  SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED,
  supplierDirectPaymentAllowedForProject,
} from "../supplier-certificate-rollout.service";

describe("supplier direct-payment rollout gate", () => {
  it("fails closed outside tests when the allowlist is absent or empty", () => {
    for (const nodeEnv of ["development", "production"] as const) {
      expect(
        supplierDirectPaymentAllowedForProject({
          nodeEnv,
          allowlist: undefined,
          projectArchidocId: "project-canary",
        }),
      ).toBe(false);
      expect(
        supplierDirectPaymentAllowedForProject({
          nodeEnv,
          allowlist: "  ",
          projectArchidocId: "project-canary",
        }),
      ).toBe(false);
    }
  });

  it("allows only exact, explicitly listed ArchiDoc project IDs", () => {
    expect(
      supplierDirectPaymentAllowedForProject({
        nodeEnv: "production",
        allowlist: "project-other, project-canary",
        projectArchidocId: "project-canary",
      }),
    ).toBe(true);
    expect(
      supplierDirectPaymentAllowedForProject({
        nodeEnv: "production",
        allowlist: "project-other, project-canary",
        projectArchidocId: "project-can",
      }),
    ).toBe(false);
  });

  it("keeps existing fixture suites enabled only in test when unset", () => {
    expect(
      supplierDirectPaymentAllowedForProject({
        nodeEnv: "test",
        allowlist: undefined,
        projectArchidocId: "fixture-project",
      }),
    ).toBe(true);
    expect(SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED).toBe(
      "SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED",
    );
  });
});