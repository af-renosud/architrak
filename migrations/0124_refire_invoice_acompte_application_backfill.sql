-- DATA-ONLY, rerunnable historical repair (Task #691).
-- 0123 may have been tracker-stamped after its schema landed without running
-- its backfill. Re-run only its guarded, source-bound DML; do not alter the
-- immutable application schema or relax any arithmetic proof.
WITH ledger AS (
  SELECT cp.certificat_id, round(sum(cp.amount)::numeric, 2) AS paid_ttc,
    max(cp.date_paid) AS paid_at,
    string_agg(DISTINCT NULLIF(btrim(cp.reference), ''), ', ' ORDER BY NULLIF(btrim(cp.reference), '')) AS refs
  FROM certificat_payments cp
  GROUP BY cp.certificat_id
), candidates AS (
  SELECT i.id AS invoice_id, i.devis_id, c.id AS certificat_id,
    i.source_intake_document_id, aip.id AS no_invoice_payment_id,
    src.storage_key, src.file_name, src.content_fingerprint,
    round(COALESCE(NULLIF(d.acompte_amount_ht, 0), d.amount_ht * d.acompte_percent / 100)::numeric, 2) AS applied_ht,
    round(CASE WHEN src.extracted_data->>'acomptePaidAmountTtc' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (src.extracted_data->>'acomptePaidAmountTtc')::numeric END, 2) AS applied_ttc,
    i.amount_ht AS invoice_gross_ht, i.amount_ttc AS invoice_gross_ttc,
    round(CASE WHEN src.extracted_data->>'netAPayer' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (src.extracted_data->>'netAPayer')::numeric END, 2) AS invoice_net_payable_ttc,
    l.paid_at AS payment_ledger_paid_at, aip.paid_at AS payment_audit_paid_at,
    l.refs AS payment_ledger_references, aip.payment_reference AS payment_audit_reference,
    CASE
      WHEN l.paid_at IS NOT NULL AND aip.paid_at IS NOT NULL
        AND l.paid_at <> (aip.paid_at AT TIME ZONE 'UTC')::date THEN true
      WHEN l.refs IS NOT NULL AND aip.payment_reference IS NOT NULL
        AND btrim(aip.payment_reference) <> '' AND position(btrim(aip.payment_reference) in l.refs) = 0 THEN true
      ELSE false
    END AS payment_conflict,
    src.extracted_data->>'acomptePaidEvidenceText' AS evidence_text
  FROM invoices i
  JOIN devis d ON d.id = i.devis_id
  JOIN project_intake_documents src ON src.id = i.source_intake_document_id
  LEFT JOIN email_documents source_email ON source_email.id = src.source_email_document_id
  LEFT JOIN invoices source_email_invoice ON source_email_invoice.id = source_email.invoice_id
  JOIN certificats c ON c.acompte_devis_id = d.id AND c.status <> 'superseded'
  LEFT JOIN acompte_no_invoice_payments aip ON aip.devis_id = d.id
    AND aip.certificat_id = c.id AND aip.source_intake_document_id = src.id
    AND aip.source_content_fingerprint = src.content_fingerprint
  LEFT JOIN ledger l ON l.certificat_id = c.id
  WHERE i.source_intake_document_id IS NOT NULL
    AND src.project_id = i.project_id AND i.project_id = d.project_id
    AND i.contractor_id = d.contractor_id AND c.project_id = d.project_id
    AND c.contractor_id = d.contractor_id AND src.content_fingerprint IS NOT NULL
    AND src.extracted_data->>'documentType' = 'invoice'
    -- Unpromoted intake remains eligible. Any promotion metadata, however,
    -- must be a complete pointer to this exact invoice.
    AND (
      (src.promoted_kind IS NULL AND src.promoted_id IS NULL)
      OR (src.promoted_kind = 'invoice' AND src.promoted_id = i.id)
    )
    -- Email linkage is optional. If present, every populated identity field
    -- and its optional linked invoice must agree with the candidate.
    AND (
      src.source_email_document_id IS NULL
      OR (
        source_email.id IS NOT NULL
        AND (source_email.project_id IS NULL OR source_email.project_id = i.project_id)
        AND (source_email.contractor_id IS NULL OR source_email.contractor_id = i.contractor_id)
        AND (source_email.devis_id IS NULL OR source_email.devis_id = i.devis_id)
        AND (
          source_email.invoice_id IS NULL
          OR (
            source_email_invoice.id IS NOT NULL
            AND source_email_invoice.id = i.id
            AND source_email_invoice.project_id = i.project_id
            AND source_email_invoice.contractor_id = i.contractor_id
            AND source_email_invoice.devis_id = i.devis_id
          )
        )
      )
    )
    -- Missing extracted identity labels are legitimate. Present labels are
    -- assertions: malformed values and contradictions must not be inferred.
    AND (
      NOT (src.extracted_data ? 'projectId')
      OR (
        jsonb_typeof(src.extracted_data->'projectId') = 'number'
        AND src.extracted_data->>'projectId' ~ '^[0-9]+([.]0+)?$'
        AND (CASE WHEN src.extracted_data->>'projectId' ~ '^[0-9]+([.]0+)?$'
          THEN (src.extracted_data->>'projectId')::numeric END) = i.project_id
      )
      OR (
        jsonb_typeof(src.extracted_data->'projectId') = 'string'
        AND src.extracted_data->>'projectId' ~ '^[0-9]+$'
        AND (CASE WHEN src.extracted_data->>'projectId' ~ '^[0-9]+$'
          THEN (src.extracted_data->>'projectId')::numeric END) = i.project_id
      )
    )
    AND (
      NOT (src.extracted_data ? 'contractorId')
      OR (
        jsonb_typeof(src.extracted_data->'contractorId') = 'number'
        AND src.extracted_data->>'contractorId' ~ '^[0-9]+([.]0+)?$'
        AND (CASE WHEN src.extracted_data->>'contractorId' ~ '^[0-9]+([.]0+)?$'
          THEN (src.extracted_data->>'contractorId')::numeric END) = i.contractor_id
      )
      OR (
        jsonb_typeof(src.extracted_data->'contractorId') = 'string'
        AND src.extracted_data->>'contractorId' ~ '^[0-9]+$'
        AND (CASE WHEN src.extracted_data->>'contractorId' ~ '^[0-9]+$'
          THEN (src.extracted_data->>'contractorId')::numeric END) = i.contractor_id
      )
    )
    AND (
      NOT (src.extracted_data ? 'devisId')
      OR (
        jsonb_typeof(src.extracted_data->'devisId') = 'number'
        AND src.extracted_data->>'devisId' ~ '^[0-9]+([.]0+)?$'
        AND (CASE WHEN src.extracted_data->>'devisId' ~ '^[0-9]+([.]0+)?$'
          THEN (src.extracted_data->>'devisId')::numeric END) = i.devis_id
      )
      OR (
        jsonb_typeof(src.extracted_data->'devisId') = 'string'
        AND src.extracted_data->>'devisId' ~ '^[0-9]+$'
        AND (CASE WHEN src.extracted_data->>'devisId' ~ '^[0-9]+$'
          THEN (src.extracted_data->>'devisId')::numeric END) = i.devis_id
      )
    )
    AND (
      NOT (src.extracted_data ? 'devisCode')
      OR (
        jsonb_typeof(src.extracted_data->'devisCode') = 'string'
        AND btrim(src.extracted_data->>'devisCode') = d.devis_code
      )
    )
    AND lower(COALESCE(src.extracted_data->>'acomptePaidEvidenceText', ''))
        ~ '(acompte vers(e|é)|acompte d(e|é)j(a|à) pay(e|é)|d(e|é)duction acompte)'
    -- Never cast untrusted JSON text before proving it is numeric.
    AND (src.extracted_data->>'acomptePaidAmountTtc') ~ '^-?[0-9]+([.][0-9]+)?$'
    AND (src.extracted_data->>'netAPayer') ~ '^-?[0-9]+([.][0-9]+)?$'
    AND (src.extracted_data->>'retenueDeGarantie' IS NULL
      OR src.extracted_data->>'retenueDeGarantie' ~ '^-?[0-9]+([.][0-9]+)?$')
    AND round(CASE WHEN src.extracted_data->>'acomptePaidAmountTtc' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (src.extracted_data->>'acomptePaidAmountTtc')::numeric END, 2) = round(c.net_to_pay_ttc::numeric, 2)
    AND round(c.net_to_pay_ht::numeric, 2) =
      round(COALESCE(NULLIF(d.acompte_amount_ht, 0), d.amount_ht * d.acompte_percent / 100)::numeric, 2)
    AND round(i.amount_ttc::numeric - (CASE WHEN src.extracted_data->>'acomptePaidAmountTtc' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (src.extracted_data->>'acomptePaidAmountTtc')::numeric END)
      - COALESCE(CASE WHEN src.extracted_data->>'retenueDeGarantie' ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN (src.extracted_data->>'retenueDeGarantie')::numeric END, 0), 2)
      = round(CASE WHEN src.extracted_data->>'netAPayer' ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN (src.extracted_data->>'netAPayer')::numeric END, 2)
    AND (aip.id IS NOT NULL OR COALESCE(l.paid_ttc, 0) >= round(c.net_to_pay_ttc::numeric, 2))
)
INSERT INTO invoice_acompte_applications (
  invoice_id, devis_id, certificat_id, source_intake_document_id, no_invoice_payment_id,
  source_storage_key, source_file_name, source_content_fingerprint,
  applied_ht, applied_ttc, invoice_gross_ht, invoice_gross_ttc, invoice_net_payable_ttc,
  payment_ledger_paid_at, payment_audit_paid_at, payment_ledger_references,
  payment_audit_reference, payment_conflict, evidence_text
)
SELECT invoice_id, devis_id, certificat_id, source_intake_document_id, no_invoice_payment_id,
  storage_key, file_name, content_fingerprint,
  applied_ht, applied_ttc, invoice_gross_ht, invoice_gross_ttc, invoice_net_payable_ttc,
  payment_ledger_paid_at, payment_audit_paid_at, payment_ledger_references,
  payment_audit_reference, payment_conflict, evidence_text
FROM (
  SELECT DISTINCT ON (devis_id) * FROM candidates ORDER BY devis_id, invoice_id
) exact_once
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- State is derived only from an immutable application, and changes once.
UPDATE devis d
SET acompte_state = 'applied', updated_at = now()
WHERE d.acompte_state <> 'applied'
  AND EXISTS (SELECT 1 FROM invoice_acompte_applications iaa WHERE iaa.devis_id = d.id);--> statement-breakpoint

-- Remove only netAPayer warning objects from invoices with an immutable,
-- source-fingerprint-bound application whose current JSON arithmetic still
-- proves the warning false. Keep every other warning snapshot verbatim.
WITH qualified AS (
  SELECT i.id AS invoice_id
  FROM invoice_acompte_applications iaa
  JOIN invoices i ON i.id = iaa.invoice_id
  JOIN devis d ON d.id = i.devis_id
  JOIN project_intake_documents src ON src.id = i.source_intake_document_id
  LEFT JOIN email_documents source_email ON source_email.id = src.source_email_document_id
  LEFT JOIN invoices source_email_invoice ON source_email_invoice.id = source_email.invoice_id
  WHERE iaa.source_intake_document_id = src.id
    AND iaa.devis_id = i.devis_id
    AND iaa.source_content_fingerprint = src.content_fingerprint
    AND (
      (src.promoted_kind IS NULL AND src.promoted_id IS NULL)
      OR (src.promoted_kind = 'invoice' AND src.promoted_id = i.id)
    )
    AND (
      src.source_email_document_id IS NULL
      OR (
        source_email.id IS NOT NULL
        AND (source_email.project_id IS NULL OR source_email.project_id = i.project_id)
        AND (source_email.contractor_id IS NULL OR source_email.contractor_id = i.contractor_id)
        AND (source_email.devis_id IS NULL OR source_email.devis_id = i.devis_id)
        AND (source_email.invoice_id IS NULL OR (
          source_email_invoice.id IS NOT NULL
          AND source_email_invoice.id = i.id
          AND source_email_invoice.project_id = i.project_id
          AND source_email_invoice.contractor_id = i.contractor_id
          AND source_email_invoice.devis_id = i.devis_id
        ))
      )
    )
    AND (
      NOT (src.extracted_data ? 'projectId')
      OR (jsonb_typeof(src.extracted_data->'projectId') = 'number'
        AND src.extracted_data->>'projectId' ~ '^[0-9]+([.]0+)?$'
        AND (CASE WHEN src.extracted_data->>'projectId' ~ '^[0-9]+([.]0+)?$'
          THEN (src.extracted_data->>'projectId')::numeric END) = i.project_id)
      OR (jsonb_typeof(src.extracted_data->'projectId') = 'string'
        AND src.extracted_data->>'projectId' ~ '^[0-9]+$'
        AND (CASE WHEN src.extracted_data->>'projectId' ~ '^[0-9]+$'
          THEN (src.extracted_data->>'projectId')::numeric END) = i.project_id)
    )
    AND (
      NOT (src.extracted_data ? 'contractorId')
      OR (jsonb_typeof(src.extracted_data->'contractorId') = 'number'
        AND src.extracted_data->>'contractorId' ~ '^[0-9]+([.]0+)?$'
        AND (CASE WHEN src.extracted_data->>'contractorId' ~ '^[0-9]+([.]0+)?$'
          THEN (src.extracted_data->>'contractorId')::numeric END) = i.contractor_id)
      OR (jsonb_typeof(src.extracted_data->'contractorId') = 'string'
        AND src.extracted_data->>'contractorId' ~ '^[0-9]+$'
        AND (CASE WHEN src.extracted_data->>'contractorId' ~ '^[0-9]+$'
          THEN (src.extracted_data->>'contractorId')::numeric END) = i.contractor_id)
    )
    AND (
      NOT (src.extracted_data ? 'devisId')
      OR (jsonb_typeof(src.extracted_data->'devisId') = 'number'
        AND src.extracted_data->>'devisId' ~ '^[0-9]+([.]0+)?$'
        AND (CASE WHEN src.extracted_data->>'devisId' ~ '^[0-9]+([.]0+)?$'
          THEN (src.extracted_data->>'devisId')::numeric END) = i.devis_id)
      OR (jsonb_typeof(src.extracted_data->'devisId') = 'string'
        AND src.extracted_data->>'devisId' ~ '^[0-9]+$'
        AND (CASE WHEN src.extracted_data->>'devisId' ~ '^[0-9]+$'
          THEN (src.extracted_data->>'devisId')::numeric END) = i.devis_id)
    )
    AND (
      NOT (src.extracted_data ? 'devisCode')
      OR (jsonb_typeof(src.extracted_data->'devisCode') = 'string'
        AND btrim(src.extracted_data->>'devisCode') = d.devis_code)
    )
    AND (src.extracted_data->>'acomptePaidAmountTtc') ~ '^-?[0-9]+([.][0-9]+)?$'
    AND (src.extracted_data->>'netAPayer') ~ '^-?[0-9]+([.][0-9]+)?$'
    AND (src.extracted_data->>'retenueDeGarantie' IS NULL
      OR src.extracted_data->>'retenueDeGarantie' ~ '^-?[0-9]+([.][0-9]+)?$')
    AND round(iaa.applied_ttc::numeric, 2) = round(CASE WHEN src.extracted_data->>'acomptePaidAmountTtc' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (src.extracted_data->>'acomptePaidAmountTtc')::numeric END, 2)
    AND round(iaa.invoice_gross_ttc::numeric, 2) = round(i.amount_ttc::numeric, 2)
    AND round(iaa.invoice_net_payable_ttc::numeric, 2) = round(CASE WHEN src.extracted_data->>'netAPayer' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (src.extracted_data->>'netAPayer')::numeric END, 2)
    AND round(i.amount_ttc::numeric - (CASE WHEN src.extracted_data->>'acomptePaidAmountTtc' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (src.extracted_data->>'acomptePaidAmountTtc')::numeric END)
      - COALESCE(CASE WHEN src.extracted_data->>'retenueDeGarantie' ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN (src.extracted_data->>'retenueDeGarantie')::numeric END, 0), 2)
      = round(CASE WHEN src.extracted_data->>'netAPayer' ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN (src.extracted_data->>'netAPayer')::numeric END, 2)
)
UPDATE invoices i
SET validation_warnings = (
  SELECT COALESCE(jsonb_agg(warning), '[]'::jsonb)
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(i.validation_warnings) = 'array'
      THEN i.validation_warnings ELSE '[]'::jsonb END
  ) AS warning
  WHERE (warning->>'field') IS DISTINCT FROM 'netAPayer'
)
FROM qualified q
WHERE i.id = q.invoice_id
  AND jsonb_typeof(i.validation_warnings) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(i.validation_warnings) = 'array'
        THEN i.validation_warnings ELSE '[]'::jsonb END
    ) AS warning
    WHERE warning->>'field' = 'netAPayer'
  );--> statement-breakpoint

-- Resolution preserves the advisory row and its raised history.
WITH qualified AS (
  SELECT i.id AS invoice_id
  FROM invoice_acompte_applications iaa
  JOIN invoices i ON i.id = iaa.invoice_id
  JOIN devis d ON d.id = i.devis_id
  JOIN project_intake_documents src ON src.id = i.source_intake_document_id
  LEFT JOIN email_documents source_email ON source_email.id = src.source_email_document_id
  LEFT JOIN invoices source_email_invoice ON source_email_invoice.id = source_email.invoice_id
  WHERE iaa.source_intake_document_id = src.id
    AND iaa.devis_id = i.devis_id
    AND iaa.source_content_fingerprint = src.content_fingerprint
    AND (
      (src.promoted_kind IS NULL AND src.promoted_id IS NULL)
      OR (src.promoted_kind = 'invoice' AND src.promoted_id = i.id)
    )
    AND (
      src.source_email_document_id IS NULL
      OR (
        source_email.id IS NOT NULL
        AND (source_email.project_id IS NULL OR source_email.project_id = i.project_id)
        AND (source_email.contractor_id IS NULL OR source_email.contractor_id = i.contractor_id)
        AND (source_email.devis_id IS NULL OR source_email.devis_id = i.devis_id)
        AND (source_email.invoice_id IS NULL OR (
          source_email_invoice.id IS NOT NULL
          AND source_email_invoice.id = i.id
          AND source_email_invoice.project_id = i.project_id
          AND source_email_invoice.contractor_id = i.contractor_id
          AND source_email_invoice.devis_id = i.devis_id
        ))
      )
    )
    AND (
      NOT (src.extracted_data ? 'projectId')
      OR (jsonb_typeof(src.extracted_data->'projectId') = 'number'
        AND src.extracted_data->>'projectId' ~ '^[0-9]+([.]0+)?$'
        AND (CASE WHEN src.extracted_data->>'projectId' ~ '^[0-9]+([.]0+)?$'
          THEN (src.extracted_data->>'projectId')::numeric END) = i.project_id)
      OR (jsonb_typeof(src.extracted_data->'projectId') = 'string'
        AND src.extracted_data->>'projectId' ~ '^[0-9]+$'
        AND (CASE WHEN src.extracted_data->>'projectId' ~ '^[0-9]+$'
          THEN (src.extracted_data->>'projectId')::numeric END) = i.project_id)
    )
    AND (
      NOT (src.extracted_data ? 'contractorId')
      OR (jsonb_typeof(src.extracted_data->'contractorId') = 'number'
        AND src.extracted_data->>'contractorId' ~ '^[0-9]+([.]0+)?$'
        AND (CASE WHEN src.extracted_data->>'contractorId' ~ '^[0-9]+([.]0+)?$'
          THEN (src.extracted_data->>'contractorId')::numeric END) = i.contractor_id)
      OR (jsonb_typeof(src.extracted_data->'contractorId') = 'string'
        AND src.extracted_data->>'contractorId' ~ '^[0-9]+$'
        AND (CASE WHEN src.extracted_data->>'contractorId' ~ '^[0-9]+$'
          THEN (src.extracted_data->>'contractorId')::numeric END) = i.contractor_id)
    )
    AND (
      NOT (src.extracted_data ? 'devisId')
      OR (jsonb_typeof(src.extracted_data->'devisId') = 'number'
        AND src.extracted_data->>'devisId' ~ '^[0-9]+([.]0+)?$'
        AND (CASE WHEN src.extracted_data->>'devisId' ~ '^[0-9]+([.]0+)?$'
          THEN (src.extracted_data->>'devisId')::numeric END) = i.devis_id)
      OR (jsonb_typeof(src.extracted_data->'devisId') = 'string'
        AND src.extracted_data->>'devisId' ~ '^[0-9]+$'
        AND (CASE WHEN src.extracted_data->>'devisId' ~ '^[0-9]+$'
          THEN (src.extracted_data->>'devisId')::numeric END) = i.devis_id)
    )
    AND (
      NOT (src.extracted_data ? 'devisCode')
      OR (jsonb_typeof(src.extracted_data->'devisCode') = 'string'
        AND btrim(src.extracted_data->>'devisCode') = d.devis_code)
    )
    AND (src.extracted_data->>'acomptePaidAmountTtc') ~ '^-?[0-9]+([.][0-9]+)?$'
    AND (src.extracted_data->>'netAPayer') ~ '^-?[0-9]+([.][0-9]+)?$'
    AND (src.extracted_data->>'retenueDeGarantie' IS NULL
      OR src.extracted_data->>'retenueDeGarantie' ~ '^-?[0-9]+([.][0-9]+)?$')
    AND round(iaa.applied_ttc::numeric, 2) = round(CASE WHEN src.extracted_data->>'acomptePaidAmountTtc' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (src.extracted_data->>'acomptePaidAmountTtc')::numeric END, 2)
    AND round(iaa.invoice_gross_ttc::numeric, 2) = round(i.amount_ttc::numeric, 2)
    AND round(iaa.invoice_net_payable_ttc::numeric, 2) = round(CASE WHEN src.extracted_data->>'netAPayer' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (src.extracted_data->>'netAPayer')::numeric END, 2)
    AND round(i.amount_ttc::numeric - (CASE WHEN src.extracted_data->>'acomptePaidAmountTtc' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (src.extracted_data->>'acomptePaidAmountTtc')::numeric END)
      - COALESCE(CASE WHEN src.extracted_data->>'retenueDeGarantie' ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN (src.extracted_data->>'retenueDeGarantie')::numeric END, 0), 2)
      = round(CASE WHEN src.extracted_data->>'netAPayer' ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN (src.extracted_data->>'netAPayer')::numeric END, 2)
)
UPDATE document_advisories da
SET resolved_at = CURRENT_TIMESTAMP
FROM qualified q
WHERE da.invoice_id = q.invoice_id
  AND da.code = 'net_a_payer_mismatch'
  AND da.resolved_at IS NULL;