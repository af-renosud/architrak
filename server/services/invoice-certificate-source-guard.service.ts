import { and, eq, ne } from "drizzle-orm";
import { certificatSources, certificats } from "@shared/schema";
import { db } from "../db";

export type DatabaseTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];

export const INVOICE_CERTIFICATE_SOURCE_CONSTRAINT =
  "invoice_certificate_source_seal";

export function isInvoiceCertificateSourceDatabaseRefusal(
  error: unknown,
): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      candidate.code === "23514"
      && (
        candidate.constraint === INVOICE_CERTIFICATE_SOURCE_CONSTRAINT
        || candidate.message === "invoice_certificate_source_immutable"
      )
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Source invoices become financial evidence as soon as an active certificate
 * claims them. Callers must hold the invoice row lock before this check so an
 * edit cannot race the source claim or issuance path.
 * References owned only by superseded certificates do not freeze the invoice.
 */
export async function hasLiveCertificateSource(
  tx: DatabaseTransaction,
  invoiceId: number,
): Promise<boolean> {
  const [source] = await tx
    .select({ id: certificatSources.id })
    .from(certificatSources)
    .innerJoin(certificats, eq(certificatSources.certificatId, certificats.id))
    .where(
      and(
        eq(certificatSources.invoiceId, invoiceId),
        ne(certificats.status, "superseded"),
      ),
    )
    .limit(1);
  return source != null;
}