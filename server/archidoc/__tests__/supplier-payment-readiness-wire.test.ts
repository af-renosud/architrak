import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../env";
import {
  fetchSupplierPaymentReadinessPage,
  SupplierPaymentCursorExpiredError,
} from "../sync-client";
import {
  supplierPaymentCursorExpiredSchema,
  supplierPaymentReadinessResponseSchema,
} from "../supplier-payment-readiness-wire";
import {
  fetchSupplierPaymentReadinessWindowWithRecovery,
} from "../supplier-payment-readiness-sync";

const fixture = (name = "supplier-payment-readiness-v1.json") =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../docs/wire-fixtures/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

function asBootstrapPage() {
  const value = fixture();
  value.syncWindow = {
    ...value.syncWindow,
    mode: "bootstrap",
    afterSequenceExclusive: null,
  };
  return value;
}

function secondBootstrapChange(source: any) {
  const change = structuredClone(source);
  change.supplier.id = "zz-supplier-sequence-fixture";
  change.supplier.primaryContact.id = "contact-second";
  change.supplier.banking.ribDocument.id = "rib-second";
  change.supplier.banking.ribDocument.downloadPath =
    "/api/integrations/architrak/v1/suppliers/zz-supplier-sequence-fixture/rib/rib-second";
  change.supplier.projectPaymentAssignments[0].id =
    "assignment-second";
  return change;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("supplier payment-readiness production wire consumer", () => {
  it.each([
    "supplier-payment-readiness-v1.json",
    "supplier-payment-readiness-v1-assignment-cleared.json",
    "supplier-payment-readiness-v1-delete.json",
    "supplier-payment-readiness-v1-incomplete.json",
  ])(
    "accepts frozen response fixture %s through the production validator",
    (name) => {
      expect(() =>
        supplierPaymentReadinessResponseSchema.parse(fixture(name)),
      ).not.toThrow();
    },
  );

  it("accepts the frozen cursor-expired fixture through the production validator", () => {
    expect(() =>
      supplierPaymentCursorExpiredSchema.parse(
        fixture("supplier-payment-readiness-v1-cursor-expired.json"),
      ),
    ).not.toThrow();
  });

  it.each([
    {
      name: "invalid IBAN",
      mutate: (value: any) => {
        value.changes[0].supplier.banking.iban =
          "FR7630006000011234567890188";
      },
    },
    {
      name: "invalid BIC",
      mutate: (value: any) => {
        value.changes[0].supplier.banking.bic = "not-a-bic";
      },
    },
    {
      name: "incomplete verified provenance",
      mutate: (value: any) => {
        value.changes[0].supplier.banking.ribDocument = null;
      },
    },
    {
      name: "RIB path bound to another supplier",
      mutate: (value: any) => {
        value.changes[0].supplier.banking.ribDocument.downloadPath =
          "/api/integrations/architrak/v1/suppliers/other/rib/rib_01J6ARCHITRAK0000000000001";
      },
    },
    {
      name: "duplicate project assignment",
      mutate: (value: any) => {
        value.changes[0].supplier.projectPaymentAssignments.push({
          ...value.changes[0].supplier.projectPaymentAssignments[0],
          id: "another-assignment",
        });
      },
    },
    {
      name: "unknown additive key",
      mutate: (value: any) => {
        value.changes[0].supplier.unversionedField = true;
      },
    },
  ])("rejects $name before persistence", ({ mutate }) => {
    const value = fixture();
    mutate(value);
    expect(() =>
      supplierPaymentReadinessResponseSchema.parse(value),
    ).toThrow();
  });

  it("rejects an incremental frozen window whose upper bound regresses behind its cursor", () => {
    const value = fixture();
    value.syncWindow.throughSequenceInclusive = "8419";
    expect(() =>
      supplierPaymentReadinessResponseSchema.parse(value),
    ).toThrow();
  });

  it("rejects a duplicate global sequence inside a bootstrap page", () => {
    const value = asBootstrapPage();
    value.changes.push(secondBootstrapChange(value.changes[0]));
    expect(() =>
      supplierPaymentReadinessResponseSchema.parse(value),
    ).toThrow();
  });

  it("uses only the opaque token on subsequent page requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(fixture()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await fetchSupplierPaymentReadinessPage({
      pageToken: "opaque-token",
    });
    const requested = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(requested.searchParams.get("pageToken")).toBe("opaque-token");
    expect(requested.searchParams.has("mode")).toBe(false);
    expect(requested.searchParams.has("afterSequence")).toBe(false);
    expect(requested.searchParams.has("limit")).toBe(false);
    expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Bearer /),
      Accept: "application/json",
    });
    expect(String(fetchSpy.mock.calls[0][1]?.headers)).not.toContain(
      env.ARCHIDOC_SYNC_API_KEY,
    );
  });

  it("maps only the pinned 410 body to cursor-expired recovery", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "SYNC_CURSOR_EXPIRED",
          minimumAvailableSequence: "8000",
          message: "Run a bootstrap sync before resuming incrementally.",
        }),
        {
          status: 410,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    await expect(
      fetchSupplierPaymentReadinessPage({
        mode: "incremental",
        afterSequence: "1",
      }),
    ).rejects.toBeInstanceOf(SupplierPaymentCursorExpiredError);
  });

  it("recovers an expired incremental cursor by refetching a bootstrap window", async () => {
    const bootstrap = asBootstrapPage();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "SYNC_CURSOR_EXPIRED",
            minimumAvailableSequence: "8000",
            message: "Run a bootstrap sync before resuming incrementally.",
          }),
          {
            status: 410,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(bootstrap), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const result =
      await fetchSupplierPaymentReadinessWindowWithRecovery(
        "incremental",
        "7999",
      );
    expect(result.recoveredExpiredCursor).toBe(true);
    expect(result.window.mode).toBe("bootstrap");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const recoveryUrl = new URL(String(fetchSpy.mock.calls[1][0]));
    expect(recoveryUrl.searchParams.get("mode")).toBe("bootstrap");
    expect(recoveryUrl.searchParams.has("afterSequence")).toBe(false);
  });

  it("rejects a duplicate global sequence split across bootstrap pages", async () => {
    const first = asBootstrapPage();
    first.nextPageToken = "second-page";
    const second = asBootstrapPage();
    second.changes = [secondBootstrapChange(first.changes[0])];
    second.nextPageToken = null;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(first), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(second), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    await expect(
      fetchSupplierPaymentReadinessWindowWithRecovery(
        "bootstrap",
        null,
      ),
    ).rejects.toThrow(/sequence was duplicated across pages/);
  });
});