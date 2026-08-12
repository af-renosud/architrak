-- Task #457 — closed vocabulary for certificat lifecycle statuses.
--
-- `superseded` is terminal and written only by the atomic reissue
-- transaction; the routes reject it on create/PATCH. The DB check makes the
-- vocabulary authoritative so no code path can invent a status. Verified
-- before adding: dev holds only draft/ready/sent/paid, prod holds none.
ALTER TABLE "certificats" ADD CONSTRAINT "certificats_status_check"
  CHECK ("status" IN ('draft', 'ready', 'sent', 'paid', 'superseded'));
