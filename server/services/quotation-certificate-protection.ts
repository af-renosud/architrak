/**
 * SQL predicate for a certificate's relationship to a quotation.
 * The argument is a trusted SQL parameter/column expression, never user text.
 * Empty/late-only source sets retain legacy contractor-wide protection.
 */
export function certificateProtectsQuotation(target: string) {
  return `(
    c.acompte_devis_id = ${target}
    OR c.issuance_snapshot->>'tvaEvidenceDevisId' = (${target})::text
    OR (c.issuance_snapshot->'sourceInvoiceIds' IS NOT NULL
      AND jsonb_typeof(c.issuance_snapshot->'sourceInvoiceIds') <> 'array')
    OR EXISTS (
      SELECT 1 FROM certificat_sources cs
      LEFT JOIN invoices i ON i.id=cs.invoice_id
      LEFT JOIN situations s ON s.id=cs.situation_id
      WHERE cs.certificat_id=c.id AND
        (i.devis_id=${target} OR s.devis_id=${target}
          OR (i.devis_id IS NULL AND s.devis_id IS NULL))
    )
    OR (c.acompte_devis_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM certificat_sources cs WHERE cs.certificat_id=c.id AND cs.late_association IS NULL
    ))
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(c.issuance_snapshot->'sourceInvoiceIds')='array'
          THEN c.issuance_snapshot->'sourceInvoiceIds' ELSE '[]'::jsonb END
      ) evidence(id)
      LEFT JOIN invoices i ON i.id::text=evidence.id
      WHERE i.devis_id=${target} OR i.devis_id IS NULL
    )
  )`;
}
