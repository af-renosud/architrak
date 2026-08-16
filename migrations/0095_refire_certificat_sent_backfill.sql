-- Task #561 — re-fire the 0094 certificat backfill. In production, 0094 was
-- stamped as applied by the tracker self-heal without its SQL ever running
-- (the reconcile blanket-inserted its tracker row), so C1 stayed 'ready'
-- despite a sent client email. Same guarded, idempotent UPDATE as 0094:
-- only draft/ready rows with a sent 'certificat_sent' communication advance;
-- sent/paid/superseded are never touched. No-op wherever 0094 actually ran.
UPDATE certificats c
SET status = 'sent', version = c.version + 1
WHERE c.status IN ('draft', 'ready')
  AND EXISTS (
    SELECT 1 FROM project_communications pc
    WHERE pc.related_certificat_id = c.id
      AND pc.type = 'certificat_sent'
      AND pc.status = 'sent'
  );
