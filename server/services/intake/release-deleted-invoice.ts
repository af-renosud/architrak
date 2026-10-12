import { and, eq, isNull, or, sql } from "drizzle-orm";
import { projectIntakeDocuments, type Invoice } from "../../../shared/schema";
import type { db } from "../../db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Call inside the invoice deletion transaction, after all financial guards.
 * Retain the PDF and provenance but do not automatically undo a user's delete.
 * Re-analysis or a new upload is an explicit request to create another draft.
 */
export async function releaseDeletedInvoiceSource(tx: Tx, invoice: Invoice) {
  await tx.update(projectIntakeDocuments).set({
    promotedKind: null,
    promotedId: null,
    analysisState: "analyzed",
    routingState: "parked",
    extractedData: sql`COALESCE(${projectIntakeDocuments.extractedData}, '{}'::jsonb) || jsonb_build_object('releasedInvoiceId', ${invoice.id}::integer)`,
    notes: sql`concat_ws(E'\\n', ${projectIntakeDocuments.notes}, ${`Draft invoice #${invoice.id} deleted. Source retained; re-analyze to create a fresh draft.`}::text)`,
    updatedAt: new Date(),
  }).where(and(
    eq(projectIntakeDocuments.projectId, invoice.projectId),
    or(
      and(eq(projectIntakeDocuments.promotedKind, "invoice"), eq(projectIntakeDocuments.promotedId, invoice.id)),
      ...(invoice.sourceIntakeDocumentId == null ? [] : [
        and(eq(projectIntakeDocuments.id, invoice.sourceIntakeDocumentId), isNull(projectIntakeDocuments.promotedId)),
      ]),
    ),
  ));
}
