import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateBic, validateIban } from "@shared/iban";

const fixtureUrl = (name: string) =>
  new URL(`../../../docs/wire-fixtures/${name}`, import.meta.url);

const readFixture = (name: string): { text: string; value: unknown } => {
  const text = readFileSync(fixtureUrl(name), "utf8");
  return { text, value: JSON.parse(text) };
};

const decimalSequence = z.string().regex(/^(0|[1-9]\d*)$/);
const utcTimestamp = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nullableTrimmedString = z.string().trim().min(1).nullable();

const primaryContactSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    jobTitle: nullableTrimmedString,
    email: z.string().email().nullable(),
    mobile: nullableTrimmedString,
  })
  .strict();

const ribDocumentSchema = z
  .object({
    id: z.string().trim().min(1),
    fileName: z.string().trim().min(1),
    mimeType: z.literal("application/pdf"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    downloadPath: z.string().regex(
      /^\/api\/integrations\/architrak\/v1\/suppliers\/[^/?]+\/rib\/[^/?]+$/,
    ),
    updatedAt: utcTimestamp,
  })
  .strict();

const bankingSchema = z
  .object({
    accountHolderName: nullableTrimmedString,
    iban: nullableTrimmedString,
    bic: nullableTrimmedString,
    bankName: nullableTrimmedString,
    bankingVerificationStatus: z.enum(["unverified", "verified", "rejected"]),
    bankingVerifiedAt: utcTimestamp.nullable(),
    bankingVerifiedBy: z
      .object({
        id: z.string().trim().min(1),
        displayName: z.string().trim().min(1),
      })
      .strict()
      .nullable(),
    bankingVerificationMethod: z
      .enum(["manual_rib_review", "bank_account_check", "imported_verified"])
      .nullable(),
    ribDocument: ribDocumentSchema.nullable(),
  })
  .strict()
  .superRefine((banking, ctx) => {
    if (banking.iban !== null && !validateIban(banking.iban).valid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid IBAN" });
    }
    if (banking.bic !== null && !validateBic(banking.bic).valid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid BIC" });
    }
    if (
      banking.bankingVerificationStatus === "verified" &&
      (
        banking.accountHolderName === null ||
        banking.iban === null ||
        banking.bankingVerifiedAt === null ||
        banking.bankingVerifiedBy === null ||
        banking.bankingVerificationMethod === null ||
        banking.ribDocument === null
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verified banking requires complete provenance",
      });
    }
  });

const assignmentSchema = z
  .object({
    id: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    directPaymentStatus: z.enum(["eligible", "not_eligible", "suspended"]),
    validFrom: calendarDate.nullable(),
    validUntil: calendarDate.nullable(),
    reason: nullableTrimmedString,
    updatedAt: utcTimestamp,
  })
  .strict();

const supplierSchema = z
  .object({
    id: z.string().trim().min(1),
    partnerType: z.literal("supplier"),
    name: z.string().trim().min(1),
    siret: z.string().regex(/^\d{14}$/).nullable(),
    address1: nullableTrimmedString,
    address2: nullableTrimmedString,
    town: nullableTrimmedString,
    postcode: nullableTrimmedString,
    countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
    isActive: z.boolean(),
    primaryContact: primaryContactSchema.nullable(),
    banking: bankingSchema.nullable(),
    projectPaymentAssignments: z.array(assignmentSchema),
    updatedAt: utcTimestamp,
  })
  .strict();

const upsertChangeSchema = z
  .object({
    sequence: decimalSequence,
    operation: z.literal("upsert"),
    changedAt: utcTimestamp,
    supplier: supplierSchema,
  })
  .strict();

const deleteChangeSchema = z
  .object({
    sequence: decimalSequence,
    operation: z.literal("delete"),
    changedAt: utcTimestamp,
    supplierId: z.string().trim().min(1),
  })
  .strict();

const responseSchema = z
  .object({
    contractVersion: z.literal("supplier-payment-readiness.v1"),
    syncWindow: z
      .object({
        mode: z.enum(["bootstrap", "incremental"]),
        afterSequenceExclusive: decimalSequence.nullable(),
        throughSequenceInclusive: decimalSequence,
        minimumAvailableSequence: decimalSequence,
      })
      .strict(),
    nextPageToken: z.string().trim().min(1).nullable(),
    changes: z.array(
      z.discriminatedUnion("operation", [
        upsertChangeSchema,
        deleteChangeSchema,
      ]),
    ),
  })
  .strict()
  .superRefine((response, ctx) => {
    const after = response.syncWindow.afterSequenceExclusive;
    if (response.syncWindow.mode === "bootstrap" && after !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bootstrap afterSequenceExclusive must be null",
      });
    }
    if (response.syncWindow.mode === "incremental" && after === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "incremental afterSequenceExclusive is required",
      });
    }

    const through = BigInt(response.syncWindow.throughSequenceInclusive);
    let prior: bigint | null = null;
    for (const change of response.changes) {
      const sequence = BigInt(change.sequence);
      if (
        response.syncWindow.mode === "incremental" &&
        after !== null &&
        sequence <= BigInt(after)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "incremental sequence is not after the cursor",
        });
      }
      if (sequence > through) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "change is beyond the frozen upper bound",
        });
      }
      if (
        response.syncWindow.mode === "incremental" &&
        prior !== null &&
        sequence <= prior
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "incremental changes are not strictly ordered",
        });
      }
      prior = sequence;
    }
  });

const responseFixtures = [
  "supplier-payment-readiness-v1.json",
  "supplier-payment-readiness-v1-delete.json",
  "supplier-payment-readiness-v1-incomplete.json",
  "supplier-payment-readiness-v1-assignment-cleared.json",
] as const;

const cursorExpiredSchema = z
  .object({
    code: z.literal("SYNC_CURSOR_EXPIRED"),
    minimumAvailableSequence: decimalSequence,
    message: z.literal("Run a bootstrap sync before resuming incrementally."),
  })
  .strict();

const ribMismatchSchema = z
  .object({
    code: z.literal("RIB_VERSION_MISMATCH"),
    supplierId: z.string().trim().min(1),
    requestedDocumentId: z.string().trim().min(1),
    currentDocumentId: z.string().trim().min(1),
    message: z.literal(
      "The supplier RIB changed after this feed version. Refresh supplier payment readiness before retrying.",
    ),
  })
  .strict();

describe("supplier payment-readiness v1 wire fixtures", () => {
  it.each(responseFixtures)("%s strictly matches the frozen response union", (name) => {
    const { value } = readFixture(name);
    expect(() => responseSchema.parse(value)).not.toThrow();
  });

  it("pins the exact happy-path response and upsert key order", () => {
    const { value } = readFixture("supplier-payment-readiness-v1.json");
    const fixture = responseSchema.parse(value);
    expect(Object.keys(fixture)).toEqual([
      "contractVersion",
      "syncWindow",
      "nextPageToken",
      "changes",
    ]);
    expect(Object.keys(fixture.syncWindow)).toEqual([
      "mode",
      "afterSequenceExclusive",
      "throughSequenceInclusive",
      "minimumAvailableSequence",
    ]);
    expect(Object.keys(fixture.changes[0])).toEqual([
      "sequence",
      "operation",
      "changedAt",
      "supplier",
    ]);

    const change = fixture.changes[0];
    if (change.operation !== "upsert") throw new Error("expected upsert fixture");
    expect(Object.keys(change.supplier)).toEqual([
      "id",
      "partnerType",
      "name",
      "siret",
      "address1",
      "address2",
      "town",
      "postcode",
      "countryCode",
      "isActive",
      "primaryContact",
      "banking",
      "projectPaymentAssignments",
      "updatedAt",
    ]);
    expect(change.supplier.primaryContact?.name).not.toBe(change.supplier.name);
  });

  it("pins deletion, explicit incomplete nulls, and assignment removal", () => {
    const deleted = responseSchema.parse(
      readFixture("supplier-payment-readiness-v1-delete.json").value,
    );
    expect(deleted.changes[0]).toEqual({
      sequence: "8422",
      operation: "delete",
      changedAt: "2026-08-24T10:00:00Z",
      supplierId: "supplier_01J6ARCHITRAK000000000099",
    });

    const incomplete = responseSchema.parse(
      readFixture("supplier-payment-readiness-v1-incomplete.json").value,
    );
    const incompleteChange = incomplete.changes[0];
    if (incompleteChange.operation !== "upsert") throw new Error("expected upsert");
    expect(incompleteChange.supplier).toMatchObject({
      isActive: false,
      siret: null,
      primaryContact: null,
      banking: null,
      projectPaymentAssignments: [],
    });

    const cleared = responseSchema.parse(
      readFixture("supplier-payment-readiness-v1-assignment-cleared.json").value,
    );
    const clearedChange = cleared.changes[0];
    if (clearedChange.operation !== "upsert") throw new Error("expected upsert");
    expect(clearedChange.supplier.banking).not.toBeNull();
    expect(clearedChange.supplier.projectPaymentAssignments).toEqual([]);
  });

  it("pins cursor-expired and RIB-version-mismatch error bodies", () => {
    expect(() =>
      cursorExpiredSchema.parse(
        readFixture("supplier-payment-readiness-v1-cursor-expired.json").value,
      ),
    ).not.toThrow();
    expect(() =>
      ribMismatchSchema.parse(
        readFixture("supplier-rib-version-mismatch-v1.json").value,
      ),
    ).not.toThrow();
  });

  it("contains no public/signed RIB URL and binds the path to the document", () => {
    const { text, value } = readFixture("supplier-payment-readiness-v1.json");
    const fixture = responseSchema.parse(value);
    const change = fixture.changes[0];
    if (change.operation !== "upsert") throw new Error("expected upsert fixture");
    const rib = change.supplier.banking?.ribDocument;
    if (!rib) throw new Error("expected RIB fixture");

    expect(rib.downloadPath).toContain(`/${change.supplier.id}/rib/${rib.id}`);
    expect(text).not.toMatch(/https?:\/\/[^"]*rib/i);
    expect(text).not.toMatch(/[?&](?:token|signature|key)=/i);
  });

  it("pins fixture bytes by SHA-256", () => {
    const expectedDigests: Record<string, string> = {
      // Filled from the reviewed, frozen files. A legitimate contract
      // amendment must update both the fixture and this explicit digest.
      "supplier-payment-readiness-v1.json":
        "5e3f7843f5190fd5dfc63950a31d2e1603281058a3b7970ade44e379778909fd",
      "supplier-payment-readiness-v1-delete.json":
        "5bf5625150ab21d225a181cb2ba59221aa0886fd5dbb4535a8331eae074dd711",
      "supplier-payment-readiness-v1-incomplete.json":
        "6b3dbf3b8c38384fb6a9de6a413fc0e112f10cb7913e21f5a938abbd14aa19f8",
      "supplier-payment-readiness-v1-assignment-cleared.json":
        "43e674ada3528ad11dcb00f06d187abb5e4f0e9a4996fa68abc3fa8154754a2e",
      "supplier-payment-readiness-v1-cursor-expired.json":
        "65d6f0f0880b953b4ccb594d2eb8bd474caef60d63bc198f818ba4206b4d375e",
      "supplier-rib-version-mismatch-v1.json":
        "fd48ce2cbef3257e0be5910feeaf072eaaed934875c68aa13b1f473af22404b2",
    };

    for (const [name, expected] of Object.entries(expectedDigests)) {
      const { text } = readFixture(name);
      expect(createHash("sha256").update(text).digest("hex"), name).toBe(expected);
    }
  });
});