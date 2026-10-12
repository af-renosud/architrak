-- One-time recovery of the confirmed orphan and its blocked re-upload.
-- No financial values or existing invoice records are changed.
WITH released AS (
  UPDATE project_intake_documents d
  SET promoted_kind = NULL, promoted_id = NULL, routing_state = 'parked',
      extracted_data = COALESCE(d.extracted_data, '{}'::jsonb) || '{"releasedInvoiceId":4}'::jsonb,
      notes = concat_ws(E'\n', d.notes, 'Deleted draft invoice #4: source retained; replacement upload queued for fresh extraction.'),
      updated_at = CURRENT_TIMESTAMP
  WHERE d.id = 113 AND d.project_id = 12 AND d.promoted_kind = 'invoice'
    AND d.promoted_id = 4 AND d.routing_state = 'routed' AND d.analysis_state = 'analyzed'
    AND d.file_name = 'Facture d''acompte Mme et M. Massey.pdf'
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = d.project_id AND p.name = 'MASSEY (RUSSAN) 1339' AND p.archived_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = 4 OR i.source_intake_document_id IN (113,114))
    AND NOT EXISTS (SELECT 1 FROM acompte_no_invoice_payments a WHERE a.source_intake_document_id IN (113,114))
    AND NOT EXISTS (SELECT 1 FROM intake_manual_promotions m WHERE m.intake_document_id IN (113,114))
    AND EXISTS (SELECT 1 FROM project_intake_documents n WHERE n.id = 114 AND n.project_id = d.project_id
      AND n.file_name = d.file_name AND n.content_fingerprint = d.content_fingerprint
      AND n.routing_state = 'duplicate' AND n.analysis_state = 'analyzed'
      AND n.promoted_id IS NULL AND n.notes = 'Duplicate of intake document #113.')
  RETURNING d.project_id
), queued AS (
  UPDATE project_intake_documents n
  SET analysis_state = 'pending', routing_state = 'unrouted', updated_at = CURRENT_TIMESTAMP,
      notes = 'Recovery: original draft invoice was deleted. Fresh extraction requested.'
  WHERE n.id = 114 AND n.project_id IN (SELECT project_id FROM released)
  RETURNING n.id
)
INSERT INTO intake_jobs (intake_document_id, state, attempts, next_attempt_at)
SELECT id, 'pending', 0, CURRENT_TIMESTAMP FROM queued
ON CONFLICT (intake_document_id) DO UPDATE SET state = 'pending', attempts = 0,
  last_error = NULL, next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP;
