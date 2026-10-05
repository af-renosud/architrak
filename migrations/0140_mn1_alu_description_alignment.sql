-- User-authorized one-time description repair from the marked contractor PDF.
-- No financial columns, row identities, source bytes or signed artifacts change.
DO $repair$
DECLARE
  before_rows jsonb;
  before_translation jsonb;
  item record;
  repaired text;
  terminal text := 'La fourniture et pose d''une menuiserie aluminium : composé de 018 - MEXT 205, ouvrant à la française 1 vantail, repère 018 - MEXT 205, série VSX 866 Kalory, dimensions L x H 600 mm x 700 mm, pose en tunnel, hauteur d''allège 0 mm, profils et accessoires RAL 7005S, profils alu et accessoires gris souris satiné (RAL 7005S), joint noir, gamme minimaliste essentiel ouvrant discret RPT 62, design droit, n° 1 ouvrant à la française 1 vantail, ouvrant principal tirant droit (vue intérieure), béquille simple « Chromatik Carré », axe à 266 mm du bas dormant, ouvrant tirant droit (vue intérieure), 2 paumelles simples, couvre-joint 70 mm déporté RAL 7005S sur 4 côtés, bavette 62,5 mm extérieure RAL 7005S en bas, vitrage isolant 44.2 / 16 Argon / 4 FE warm edge, intercalaire noir, surface 0,27 m², poids 8,1 kg. Livraison et pose par notre équipe sans reprise éventuelle d''enduit ou de peinture.';
BEGIN
  PERFORM 1 FROM devis WHERE id=35 AND devis_code='MN.1.ALU'
    AND pdf_file_name='Devis n260309.pdf' AND status='draft'
    AND amount_ht=32405 AND amount_ttc=34187.28
    AND archisign_envelope_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM devis_line_items WHERE devis_id=35 ORDER BY id FOR UPDATE;
  PERFORM 1 FROM devis_translations WHERE devis_id=35 FOR UPDATE;
  IF EXISTS(SELECT 1 FROM quotation_extraction_events WHERE devis_id=35 AND category='mn1-alu-marked-pdf-alignment')
    OR EXISTS(SELECT 1 FROM quotation_architect_state WHERE devis_id=35)
    OR EXISTS(SELECT 1 FROM devis_translations WHERE devis_id=35 AND status IN ('processing','approved'))
    OR (SELECT md5(line_translations::text) FROM devis_translations WHERE devis_id=35) IS DISTINCT FROM '1479bf25d9ab6e0fcf7ea6818f514b59'
    OR (SELECT md5(string_agg(id||':'||line_number||':'||description||':'||quantity||':'||unit_price_ht||':'||total_ht,'|' ORDER BY line_number))
        FROM devis_line_items WHERE devis_id=35) IS DISTINCT FROM '82a98d8e65130a7c5ba25b0185b2f10b'
  THEN RETURN; END IF;
  SELECT jsonb_agg(to_jsonb(l) ORDER BY line_number) INTO before_rows FROM devis_line_items l WHERE devis_id=35;
  SELECT to_jsonb(t) INTO before_translation FROM devis_translations t WHERE devis_id=35;
  -- Ascending updates read the next row before it is changed.
  FOR item IN SELECT line_number FROM devis_line_items WHERE devis_id=35 AND line_number BETWEEN 10 AND 17 ORDER BY line_number LOOP
    SELECT description INTO repaired FROM devis_line_items WHERE devis_id=35 AND line_number=item.line_number+1;
    repaired := regexp_replace(repaired, E'\nla fourniture et pose d''une menuiserie aluminium :\n- composé de$', '', 'i');
    IF item.line_number>10 THEN repaired := 'La fourniture et pose d''une menuiserie aluminium : composé de ' || repaired; END IF;
    UPDATE devis_line_items SET description=repaired WHERE devis_id=35 AND line_number=item.line_number;
  END LOOP;
  UPDATE devis_line_items SET description=terminal WHERE devis_id=35 AND line_number=18;
  -- Move the corresponding English specifications as well; translations 11..18
  -- were inspected and carry the same displaced MEXT identities.
  UPDATE devis_translations SET
    line_translations=(SELECT jsonb_agg(CASE WHEN (x->>'lineNumber')::int>=10 THEN
      COALESCE((SELECT y FROM jsonb_array_elements(before_translation->'line_translations') y
        WHERE (y->>'lineNumber')::int=(x->>'lineNumber')::int+1),x)
      || jsonb_build_object('lineNumber',(x->>'lineNumber')::int,
      'originalDescription',(SELECT description FROM devis_line_items WHERE devis_id=35 AND line_number=(x->>'lineNumber')::int),
      'translation', CASE WHEN (x->>'lineNumber')::int=18 THEN
        'Supply and installation of aluminium joinery, 018 - MEXT 205, single-leaf inward-opening casement, reference 018 - MEXT 205, VSX 866 Kalory series, width 600 mm x height 700 mm, tunnel installation, sill height 0 mm, profiles and accessories in satin mouse grey RAL 7005S, black seal, minimalist Essential concealed-sash RPT 62 range, straight design, main leaf opening to the right viewed from inside, simple Chromatik Carré handle with axis 266 mm above the bottom frame, 2 simple hinges, 70 mm offset cover trim in RAL 7005S on all four sides, external 62.5 mm bottom sill flashing in RAL 7005S, insulating glazing 44.2 / 16 Argon / 4 FE warm edge, black spacer, area 0.27 m², weight 8.1 kg. Delivery and installation by our team, excluding any plaster/render or paint repairs.'
      ELSE (SELECT regexp_replace(y->>'translation', E'\n(Supply|supply) and installation of aluminu[m]? joinery[:]?\\s*[-]? composed of\\s*$', '', 'i')
        FROM jsonb_array_elements(before_translation->'line_translations') y WHERE (y->>'lineNumber')::int=(x->>'lineNumber')::int+1) END,
      'explanation','','explanationFr','','edited',true) ELSE x END ORDER BY (x->>'lineNumber')::int)
      FROM jsonb_array_elements(line_translations) x),
    status='edited', approved_at=NULL,approved_by=NULL,approved_by_email=NULL,
    translated_pdf_storage_key=NULL,combined_pdf_storage_key=NULL,
    contexts_version=contexts_version+1,updated_at=now()
  WHERE devis_id=35;
  UPDATE devis SET updated_at=now() WHERE id=35;
  INSERT INTO quotation_extraction_events(devis_id,kind,outcome,category,reason,snapshot)
  VALUES(35,'replacement','completed_unreviewed','mn1-alu-marked-pdf-alignment',
    'User-authorized manual French/English alignment using red section boundaries; immutable financial rows retained. Final MEXT205 manually transcribed from marked PDF page 10. Approval cleared for review.',
    jsonb_build_object('beforeLines',before_rows,'beforeTranslation',before_translation,
      'afterLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY line_number) FROM devis_line_items l WHERE devis_id=35)));
END
$repair$;
