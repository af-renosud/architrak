import { z } from "zod";
import {
  supplierPaymentBankingWireSchema,
  supplierProjectPaymentAssignmentWireSchema,
} from "./supplier-payment-readiness-wire";

export const SUPPLIER_PAYMENT_CERTIFICATE_HANDOFF_CONTRACT_VERSION =
  "supplier-payment-certificate-handoff.v1" as const;

const requiredTrimmedString = z
  .string()
  .refine((value) => value.trim() === value && value.length > 0);
const nullableTrimmedString = requiredTrimmedString.nullable();
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day;
  }, "invalid calendar date");
const utcTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)), "invalid UTC timestamp");

const handoffPrimaryContactSchema = z
  .object({
    id: requiredTrimmedString,
    name: requiredTrimmedString,
    title: nullableTrimmedString,
    email: z
      .string()
      .email()
      .refine((value) => value.trim() === value)
      .nullable(),
    mobile: nullableTrimmedString,
  })
  .strict()
  .transform(({ title, ...contact }) => ({
    ...contact,
    jobTitle: title,
  }));

const handoffSupplierSchema = z
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
    primaryContact: handoffPrimaryContactSchema.nullable(),
    banking: supplierPaymentBankingWireSchema,
    updatedAt: utcTimestamp,
  })
  .strict();

/**
 * Exact v1 on-demand contract. In particular there is no permissive passthrough:
 * an upstream addition/removal must be reviewed before certificate data is used.
 */
export const supplierPaymentCertificateHandoffSchema = z
  .object({
    contractVersion: z.literal(
      SUPPLIER_PAYMENT_CERTIFICATE_HANDOFF_CONTRACT_VERSION,
    ),
    projectId: requiredTrimmedString,
    issueDate: calendarDate,
    supplier: handoffSupplierSchema,
    assignment: supplierProjectPaymentAssignmentWireSchema,
  })
  .strict()
  .superRefine((handoff, ctx) => {
    if (handoff.assignment.projectId !== handoff.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assignment", "projectId"],
        message: "assignment does not bind the handoff project",
      });
    }
    const rib = handoff.supplier.banking.ribDocument;
    if (
      rib &&
      rib.downloadPath !==
        `/api/integrations/architrak/v1/suppliers/${handoff.supplier.id}/rib/${rib.id}`
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supplier", "banking", "ribDocument", "downloadPath"],
        message: "RIB metadata does not bind supplier and document ids",
      });
    }
  });

export type SupplierPaymentCertificateHandoff = z.infer<
  typeof supplierPaymentCertificateHandoffSchema
>;

export const supplierPaymentCertificateNotReadySchema = z
  .object({
    code: z.literal("SUPPLIER_NOT_PAYMENT_READY"),
  })
  .passthrough();