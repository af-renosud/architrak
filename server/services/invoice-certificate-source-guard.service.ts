import { and, eq, ne } from "drizzle-orm";
import { certificatSources, certificats } from "@shared/schema";
import { db } from "../db";

export type DatabaseTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Source invoices become financial evidence as soon as an active certificate
 * claims them. Callers must hold the invoice row lock before this check so an
 * edit cannot race the source claim or issuance path.
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