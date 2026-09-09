import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/queryClient";
import { getManualCertificatCreationErrorToast } from "../certificat-creation-errors";

describe("manual certificate source-conflict recovery", () => {
  it("keeps the operator oriented toward invoice-source creation after a stale 409", () => {
    const toast = getManualCertificatCreationErrorToast(
      new ApiError(409, "A source is now available", {
        code: "ELIGIBLE_INVOICE_SOURCES_REQUIRED",
        invoiceIds: [88],
      }),
    );

    expect(toast.title).toBe("Invoice source now available");
    expect(toast.description).toContain("form has been kept open");
    expect(toast.description).toContain("retry from the quotation");
    expect(toast.description).toContain("approved invoice source");
    expect(toast.variant).toBe("destructive");
  });
});