-- DATA-ONLY one-shot (Task #357): run the Task #356 line-fragment merge on the
-- live devis DVP0000661 (prod devis id 21). The AI split the PDF's item 6 into
-- two rows: the continuation paragraph "Inspection, relevé de cotes…" became a
-- phantom 0,00 € line 7 and every later line shifted by one. Task agents
-- cannot press Publish or operate the prod Settings UI, so the repair ships as
-- a migration and fires exactly once at the first prod boot after publish.
--
-- This mirrors server/services/line-fragment-repair.service.ts step for step:
--   1. move the (skimmer-related) context document off the fragment row so the
--      row delete cannot CASCADE it away — its text plainly belongs to the
--      skimmers line ("Ps.25 pose de deux skimmers"), which becomes line 7
--      after the renumber;
--   2. merge the fragment description into line 6; delete the fragment row;
--   3. renumber lines 8..33 down by one (32 lines remain, matching the PDF);
--   4. mirror the merge into devis.ai_extracted_data->lineItems;
--   5. realign devis_translations: drop the blank line-7 entry, replace the
--      line-6 translation with the operator-cleaned text (the manual edit
--      minus the stray trailing "asasin"), fold the line-7 glossary
--      explanation into line 6, decrement later lineNumbers, drop cached
--      rendered PDFs and bump contexts_version so they regenerate.
--
-- Every statement is guarded on exact ids + row state (devis number, status
-- pending / sign-off stage received, 0-amount fragment, exact descriptions,
-- no situations/assets on the fragment) so the whole file is a no-op in dev,
-- in replay DBs, and if the prod rows have moved on. Statements 2-6 each
-- additionally require the previous step's outcome, so a failed guard early
-- on makes the rest no-ops instead of corrupting state.

-- 1. Re-home the context document (id 21) from the fragment row (192) to the
--    skimmers row (193). Only when the full repair precondition holds and the
--    target row has no context of its own (unique devis_line_item_id).
UPDATE devis_line_contexts c
SET devis_line_item_id = 193, updated_at = CURRENT_TIMESTAMP
WHERE c.id = 21
  AND c.devis_line_item_id = 192
  AND c.devis_id = 21
  AND c.document::text LIKE '%skimmers%'
  AND EXISTS (
    SELECT 1 FROM devis d
    WHERE d.id = 21 AND d.devis_number = 'DVP0000661'
      AND d.status = 'pending' AND d.sign_off_stage = 'received')
  AND EXISTS (
    SELECT 1 FROM devis_line_items f
    WHERE f.id = 192 AND f.devis_id = 21 AND f.line_number = 7
      AND f.total_ht = 0 AND f.unit_price_ht = 0 AND f.percent_complete = 0
      AND f.description LIKE 'Inspection, relevé de cotes%')
  AND EXISTS (
    SELECT 1 FROM devis_line_items s
    WHERE s.id = 193 AND s.devis_id = 21 AND s.line_number = 8
      AND s.description LIKE 'Ps.25%')
  AND NOT EXISTS (
    SELECT 1 FROM devis_line_contexts c2 WHERE c2.devis_line_item_id = 193);
--> statement-breakpoint

-- 2. Merge the fragment description into line 6 (id 191).
UPDATE devis_line_items p
SET description = trim(p.description) || E'\n' || trim(f.description)
FROM devis_line_items f
WHERE p.id = 191 AND p.devis_id = 21 AND p.line_number = 6
  AND p.description LIKE 'Ps.11-ps.22 préparation bassin%'
  AND p.description NOT LIKE '%Ragréage/lissage%'
  AND f.id = 192 AND f.devis_id = 21 AND f.line_number = 7
  AND f.total_ht = 0 AND f.unit_price_ht = 0 AND f.percent_complete = 0
  AND f.description LIKE 'Inspection, relevé de cotes%'
  AND f.description LIKE '%Ragréage/lissage%'
  AND EXISTS (
    SELECT 1 FROM devis d
    WHERE d.id = 21 AND d.devis_number = 'DVP0000661'
      AND d.status = 'pending' AND d.sign_off_stage = 'received')
  AND NOT EXISTS (SELECT 1 FROM situation_lines sl WHERE sl.devis_line_item_id = 192)
  AND NOT EXISTS (SELECT 1 FROM devis_line_contexts dc WHERE dc.devis_line_item_id = 192)
  -- Explicit dependency on step 1's outcome: if context doc 21 still exists,
  -- it MUST have been re-homed to the skimmers row. If step 1 could not move
  -- it (e.g. row 193 acquired its own context), the whole repair no-ops
  -- rather than cascade-deleting the document.
  AND NOT EXISTS (SELECT 1 FROM devis_line_contexts dc WHERE dc.id = 21 AND dc.devis_line_item_id <> 193)
  AND NOT EXISTS (SELECT 1 FROM devis_line_context_assets a WHERE a.devis_line_item_id = 192);
--> statement-breakpoint

-- 3. Delete the fragment row — only once its text provably lives on line 6.
DELETE FROM devis_line_items f
WHERE f.id = 192 AND f.devis_id = 21 AND f.line_number = 7 AND f.total_ht = 0
  AND NOT EXISTS (SELECT 1 FROM situation_lines sl WHERE sl.devis_line_item_id = 192)
  AND NOT EXISTS (SELECT 1 FROM devis_line_contexts dc WHERE dc.devis_line_item_id = 192)
  -- Same explicit re-home dependency as step 2 (see comment there).
  AND NOT EXISTS (SELECT 1 FROM devis_line_contexts dc WHERE dc.id = 21 AND dc.devis_line_item_id <> 193)
  AND NOT EXISTS (SELECT 1 FROM devis_line_context_assets a WHERE a.devis_line_item_id = 192)
  AND EXISTS (
    SELECT 1 FROM devis_line_items p
    WHERE p.id = 191 AND p.line_number = 6
      AND p.description LIKE 'Ps.11-ps.22 préparation bassin%'
      AND p.description LIKE '%Ragréage/lissage%');
--> statement-breakpoint

-- 4. Renumber the following lines down by one (33 -> 32 rows total).
UPDATE devis_line_items
SET line_number = line_number - 1
WHERE devis_id = 21 AND line_number > 7
  AND EXISTS (SELECT 1 FROM devis d WHERE d.id = 21 AND d.devis_number = 'DVP0000661')
  AND NOT EXISTS (SELECT 1 FROM devis_line_items x WHERE x.id = 192)
  AND EXISTS (
    SELECT 1 FROM devis_line_items p
    WHERE p.id = 191 AND p.line_number = 6 AND p.description LIKE '%Ragréage/lissage%')
  AND (SELECT count(*) FROM devis_line_items c WHERE c.devis_id = 21) = 32;
--> statement-breakpoint

-- 5. Mirror the merge into the persisted extraction JSON (audit consistency).
--    ordinality is 1-based: ord 6 = primary, ord 7 = fragment.
UPDATE devis d
SET ai_extracted_data = jsonb_set(d.ai_extracted_data, '{lineItems}', (
  SELECT jsonb_agg(
    CASE WHEN t.ord = 6 THEN jsonb_set(
      t.item, '{description}',
      to_jsonb(trim(t.item->>'description') || E'\n' || trim(d.ai_extracted_data->'lineItems'->6->>'description')))
    ELSE t.item END ORDER BY t.ord)
  FROM jsonb_array_elements(d.ai_extracted_data->'lineItems') WITH ORDINALITY AS t(item, ord)
  WHERE t.ord <> 7))
WHERE d.id = 21 AND d.devis_number = 'DVP0000661'
  AND jsonb_array_length(d.ai_extracted_data->'lineItems') = 33
  AND lower(d.ai_extracted_data->'lineItems'->6->>'description') LIKE 'inspection, relevé de cotes%'
  AND coalesce((d.ai_extracted_data->'lineItems'->6->>'total')::numeric, 0) = 0
  AND (SELECT count(*) FROM devis_line_items c WHERE c.devis_id = 21) = 32
  AND EXISTS (
    SELECT 1 FROM devis_line_items p
    WHERE p.id = 191 AND p.line_number = 6 AND p.description LIKE '%Ragréage/lissage%');
--> statement-breakpoint

-- 6. Realign the translation: drop the blank line-7 entry, clean the line-6
--    translation (strip the stray trailing "asasin" from the manual edit),
--    fold the line-7 glossary explanation into line 6, set the merged French
--    as originalDescription, decrement later lineNumbers, invalidate cached
--    rendered PDFs.
UPDATE devis_translations t
SET line_translations = (
    SELECT jsonb_agg(
      CASE
        WHEN (elem->>'lineNumber')::int = 6 THEN elem || jsonb_build_object(
          'originalDescription', (SELECT p.description FROM devis_line_items p WHERE p.id = 191),
          'translation', trim(regexp_replace(elem->>'translation', 'asasin$', '')),
          'edited', true,
          'explanation', trim(
            coalesce(elem->>'explanation', '') || ' ' ||
            coalesce((SELECT e7->>'explanation'
                      FROM jsonb_array_elements(t.line_translations) e7
                      WHERE (e7->>'lineNumber')::int = 7), '')))
        WHEN (elem->>'lineNumber')::int > 7 THEN
          jsonb_set(elem, '{lineNumber}', to_jsonb((elem->>'lineNumber')::int - 1))
        ELSE elem
      END
      ORDER BY (elem->>'lineNumber')::int)
    FROM jsonb_array_elements(t.line_translations) elem
    WHERE (elem->>'lineNumber')::int <> 7),
  translated_pdf_storage_key = NULL,
  combined_pdf_storage_key = NULL,
  contexts_version = contexts_version + 1,
  updated_at = CURRENT_TIMESTAMP
WHERE t.devis_id = 21
  AND t.status <> 'finalised'
  AND jsonb_array_length(t.line_translations) = 33
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(t.line_translations) e
    WHERE (e->>'lineNumber')::int = 7 AND trim(coalesce(e->>'translation', '')) = '')
  -- NOTE: deliberately NOT guarded on the "asasin" typo still being present —
  -- the operator may fix it by hand before publishing; regexp_replace is a
  -- no-op then, and the realignment must still happen.
  AND EXISTS (SELECT 1 FROM devis d WHERE d.id = 21 AND d.devis_number = 'DVP0000661')
  AND (SELECT count(*) FROM devis_line_items c WHERE c.devis_id = 21) = 32
  AND EXISTS (
    SELECT 1 FROM devis_line_items p
    WHERE p.id = 191 AND p.line_number = 6 AND p.description LIKE '%Ragréage/lissage%');
