import { z } from "zod";
import { validateBic, validateIban } from "@shared/iban";

export const SUPPLIER_PAYMENT_READINESS_CONTRACT_VERSION =
  "supplier-payment-readiness.v1" as const;

const decimalSequence = z.string().regex(/^(0|[1-9]\d*)$/);
const utcTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)), "invalid UTC timestamp");
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, "invalid calendar date");
const nullableTrimmedString = z
  .string()
  .refine((value) => value.trim() === value && value.length > 0)
  .nullable();
const requiredTrimmedString = z
  .string()
  .refine((value) => value.trim() === value && value.length > 0);

export const supplierPaymentPrimaryContactWireSchema = z
  .object({
    id: requiredTrimmedString,
    name: requiredTrimmedString,
    jobTitle: nullableTrimmedString,
    email: z
      .string()
      .email()
      .refine((value) => value.trim() === value)
      .nullable(),
    mobile: nullableTrimmedString,
  })
  .strict();

export const supplierPaymentRibDocumentWireSchema = z
  .object({
    id: requiredTrimmedString,
    fileName: requiredTrimmedString,
    mimeType: z.literal("application/pdf"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    downloadPath: z.string().regex(
      /^\/api\/integrations\/architrak\/v1\/suppliers\/[^/?]+\/rib\/[^/?]+$/,
    ),
    updatedAt: utcTimestamp,
  })
  .strict();

export const supplierPaymentBankingWireSchema = z
  .object({
    accountHolderName: nullableTrimmedString,
    iban: nullableTrimmedString,
    bic: nullableTrimmedString,
    bankName: nullableTrimmedString,
    bankingVerificationStatus: z.enum(["unverified", "verified", "rejected"]),
    bankingVerifiedAt: utcTimestamp.nullable(),
    bankingVerifiedBy: z
      .object({
        id: requiredTrimmedString,
        displayName: requiredTrimmedString,
      })
      .strict()
      .nullable(),
    bankingVerificationMethod: z
      .enum(["manual_rib_review", "bank_account_check", "imported_verified"])
      .nullable(),
    ribDocument: supplierPaymentRibDocumentWireSchema.nullable(),
  })
  .strict()
  .superRefine((banking, ctx) => {
    if (banking.iban !== null) {
      const validation = validateIban(banking.iban);
      if (!validation.valid || validation.normalised !== banking.iban) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["iban"],
          message: "IBAN must be valid, uppercase, and contain no spaces",
        });
      }
    }
    if (banking.bic !== null) {
      const validation = validateBic(banking.bic);
      if (!validation.valid || validation.normalised !== banking.bic) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bic"],
          message: "BIC must be valid, uppercase, and contain no spaces",
        });
      }
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

export const supplierProjectPaymentAssignmentWireSchema = z
  .object({
    id: requiredTrimmedString,
    projectId: requiredTrimmedString,
    directPaymentStatus: z.enum([
      "eligible",
      "not_eligible",
      "suspended",
    ]),
    validFrom: calendarDate.nullable(),
    validUntil: calendarDate.nullable(),
    reason: nullableTrimmedString,
    updatedAt: utcTimestamp,
  })
  .strict()
  .superRefine((assignment, ctx) => {
    if (
      assignment.validFrom !== null &&
      assignment.validUntil !== null &&
      assignment.validFrom > assignment.validUntil
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assignment validFrom must not be after validUntil",
      });
    }
  });

export const supplierPaymentReadinessSupplierWireSchema = z
  .object({
    id: requiredTrimmedString,
    partnerType: z.literal("supplier"),
    name: requiredTrimmedString,
    siret: z.string().regex(/^\d{14}$/).nullable(),
    address1: nullableTrimmedString,
    address2: nullableTrimmedString,
    town: nullableTrimmedString,
    postcode: nullableTrimmedString,
    countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
    isActive: z.boolean(),
    primaryContact: supplierPaymentPrimaryContactWireSchema.nullable(),
    banking: supplierPaymentBankingWireSchema.nullable(),
    projectPaymentAssignments: z.array(
      supplierProjectPaymentAssignmentWireSchema,
    ),
    updatedAt: utcTimestamp,
  })
  .strict()
  .superRefine((supplier, ctx) => {
    const assignmentIds = new Set<string>();
    const projectIds = new Set<string>();
    for (
      let index = 0;
      index < supplier.projectPaymentAssignments.length;
      index++
    ) {
      const assignment = supplier.projectPaymentAssignments[index];
      if (assignmentIds.has(assignment.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["projectPaymentAssignments", index, "id"],
          message: "duplicate assignment id",
        });
      }
      assignmentIds.add(assignment.id);
      if (projectIds.has(assignment.projectId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["projectPaymentAssignments", index, "projectId"],
          message: "duplicate supplier/project assignment",
        });
      }
      projectIds.add(assignment.projectId);
    }
    const rib = supplier.banking?.ribDocument;
    if (
      rib &&
      rib.downloadPath !==
        `/api/integrations/architrak/v1/suppliers/${supplier.id}/rib/${rib.id}`
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["banking", "ribDocument", "downloadPath"],
        message: "RIB downloadPath does not bind supplier and document ids",
      });
    }
  });

const upsertChangeSchema = z
  .object({
    sequence: decimalSequence,
    operation: z.literal("upsert"),
    changedAt: utcTimestamp,
    supplier: supplierPaymentReadinessSupplierWireSchema,
  })
  .strict();

const deleteChangeSchema = z
  .object({
    sequence: decimalSequence,
    operation: z.literal("delete"),
    changedAt: utcTimestamp,
    supplierId: requiredTrimmedString,
  })
  .strict();

export const supplierPaymentReadinessResponseSchema = z
  .object({
    contractVersion: z.literal(SUPPLIER_PAYMENT_READINESS_CONTRACT_VERSION),
    syncWindow: z
      .object({
        mode: z.enum(["bootstrap", "incremental"]),
        afterSequenceExclusive: decimalSequence.nullable(),
        throughSequenceInclusive: decimalSequence,
        minimumAvailableSequence: decimalSequence,
      })
      .strict(),
    nextPageToken: requiredTrimmedString.nullable(),
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
    const minimum = BigInt(response.syncWindow.minimumAvailableSequence);
    if (minimum > through) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minimumAvailableSequence exceeds throughSequenceInclusive",
      });
    }
    if (after !== null && through < BigInt(after)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["syncWindow", "throughSequenceInclusive"],
        message:
          "throughSequenceInclusive cannot be lower than afterSequenceExclusive",
      });
    }
    let priorSequence: bigint | null = null;
    let priorBootstrapSupplierId: string | null = null;
    const bootstrapSupplierIds = new Set<string>();
    const changeSequences = new Set<string>();
    const assignmentIds = new Set<string>();
    for (let index = 0; index < response.changes.length; index++) {
      const change = response.changes[index];
      const sequence = BigInt(change.sequence);
      if (changeSequences.has(change.sequence)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["changes", index, "sequence"],
          message: "change sequence is duplicated",
        });
      }
      changeSequences.add(change.sequence);
      if (
        response.syncWindow.mode === "incremental" &&
        after !== null &&
        sequence <= BigInt(after)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["changes", index, "sequence"],
          message: "incremental sequence is not after the cursor",
        });
      }
      if (sequence > through) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["changes", index, "sequence"],
          message: "change is beyond the frozen upper bound",
        });
      }
      if (
        response.syncWindow.mode === "incremental" &&
        priorSequence !== null &&
        sequence <= priorSequence
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["changes", index, "sequence"],
          message: "incremental changes are not strictly ordered",
        });
      }
      if (response.syncWindow.mode === "bootstrap") {
        if (change.operation !== "upsert") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["changes", index, "operation"],
            message: "bootstrap contains a delete event",
          });
        } else {
          if (bootstrapSupplierIds.has(change.supplier.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["changes", index, "supplier", "id"],
              message: "bootstrap contains a duplicate supplier",
            });
          }
          if (
            priorBootstrapSupplierId !== null &&
            change.supplier.id <= priorBootstrapSupplierId
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["changes", index, "supplier", "id"],
              message: "bootstrap suppliers are not in stable id order",
            });
          }
          bootstrapSupplierIds.add(change.supplier.id);
          priorBootstrapSupplierId = change.supplier.id;
        }
      }
      if (change.operation === "upsert") {
        for (const assignment of
          change.supplier.projectPaymentAssignments) {
          if (assignmentIds.has(assignment.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [
                "changes",
                index,
                "supplier",
                "projectPaymentAssignments",
              ],
              message:
                "assignment id is duplicated across supplier changes",
            });
          }
          assignmentIds.add(assignment.id);
        }
      }
      priorSequence = sequence;
    }
  });

export const supplierPaymentCursorExpiredSchema = z
  .object({
    code: z.literal("SYNC_CURSOR_EXPIRED"),
    minimumAvailableSequence: decimalSequence,
    message: z.literal(
      "Run a bootstrap sync before resuming incrementally.",
    ),
  })
  .strict();

export type SupplierPaymentReadinessResponse = z.infer<
  typeof supplierPaymentReadinessResponseSchema
>;
export type SupplierPaymentReadinessChange =
  SupplierPaymentReadinessResponse["changes"][number];
export type SupplierPaymentReadinessSupplier = z.infer<
  typeof supplierPaymentReadinessSupplierWireSchema
>;
export type SupplierPaymentReadinessMode =
  SupplierPaymentReadinessResponse["syncWindow"]["mode"];