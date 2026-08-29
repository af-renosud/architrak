-- Planning reviews remain collaborative through every unpromoted stage, but
-- become immutable evidence once the candidate enters Live Delivery.
CREATE OR REPLACE FUNCTION guard_planning_line_review_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_line_id integer;
  new_line_id integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_line_id := OLD.line_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_line_id := NEW.line_id;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM planning_revision_lines l
      JOIN planning_revisions r ON r.id = l.revision_id
      JOIN planning_envelopes e ON e.id = r.envelope_id
      JOIN projects p ON p.id = e.project_id
     WHERE l.id IN (old_line_id, new_line_id)
       AND r.promoted_devis_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'reviews of a promoted planning revision are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS planning_line_review_promotion_guard_trg
  ON planning_revision_line_reviews;--> statement-breakpoint
CREATE TRIGGER planning_line_review_promotion_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON planning_revision_line_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_planning_line_review_mutation();--> statement-breakpoint