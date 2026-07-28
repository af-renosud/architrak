-- DATA-ONLY one-shot: resolve the false line_items_total_mismatch advisory on
-- prod devis DVP0000785 (advisory id 6). Investigation showed the extracted
-- line totals sum to the document TTC (6443.51 ≈ 6443.52), i.e. VAT-inclusive
-- line amounts — the quotation is arithmetically correct. The validator now
-- recognises this pattern; this clears the already-raised phantom warning.
-- Tightly guarded (id + code + exact message + unresolved) so it is a no-op
-- in dev, replay DBs, and if an operator already resolved it.
UPDATE document_advisories
SET resolved_at = CURRENT_TIMESTAMP
WHERE id = 6
  AND code = 'line_items_total_mismatch'
  AND resolved_at IS NULL
  AND message = 'Line items total (6443.51) differs from HT (5369.6) by 1073.91';
