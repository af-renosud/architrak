import { env } from "../env";

export const SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED =
  "SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED" as const;

export function supplierDirectPaymentAllowedForProject(input: {
  nodeEnv: "development" | "production" | "test";
  allowlist: string | undefined;
  projectArchidocId: string;
}): boolean {
  if (input.nodeEnv === "test" && input.allowlist === undefined) {
    return true;
  }
  const allowedProjectIds = new Set(
    (input.allowlist ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return allowedProjectIds.has(input.projectArchidocId);
}

export function isSupplierDirectPaymentAllowedForProject(
  projectArchidocId: string,
): boolean {
  return supplierDirectPaymentAllowedForProject({
    nodeEnv: env.NODE_ENV,
    allowlist: env.SUPPLIER_DIRECT_PAYMENT_PROJECT_ALLOWLIST,
    projectArchidocId,
  });
}