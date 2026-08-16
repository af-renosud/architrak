-- Task #554 — data-only backfill: certificats whose client email was already
-- dispatched successfully (project_communications row type='certificat_sent'
-- with status='sent') but whose own status is still 'draft'/'ready'. From now
-- on the dispatch success update advances the certificat in the same
-- transaction; this repairs rows sent before the fix (e.g. C1 in production).
-- Idempotent and tightly guarded: only advances draft/ready, never touches
-- sent/paid/superseded.
UPDATE certificats c
SET status = 'sent', version = c.version + 1
WHERE c.status IN ('draft', 'ready')
  AND EXISTS (
    SELECT 1 FROM project_communications pc
    WHERE pc.related_certificat_id = c.id
      AND pc.type = 'certificat_sent'
      AND pc.status = 'sent'
  );
