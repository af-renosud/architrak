-- Task #450 (review follow-up) — a draft situation must carry at most ONE
-- line per devis line item. The route-level duplicate check is a
-- check-then-write; two concurrent POSTs could both pass it and insert
-- duplicate lines, corrupting the confirmed baseline the NEXT situation's
-- previous-amounts are read from. Enforce the pair at the DB level so the
-- loser of the race rolls back (surfaced as 409 by the route).

CREATE UNIQUE INDEX IF NOT EXISTS "situation_lines_situation_devis_line_unique"
  ON "situation_lines" ("situation_id", "devis_line_item_id");
