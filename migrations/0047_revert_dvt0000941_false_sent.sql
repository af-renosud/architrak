-- Task #257 — one-shot production data correction.
--
-- Devis id 11 (DVT0000941, project AD-46E43CC7) was manually clicked to
-- `sent_to_client` on the workflow stepper WITHOUT any Archisign envelope,
-- email or client notification: the system recorded "sent" while the client
-- received nothing. The generic-PATCH path that allowed this is now sealed
-- (server/services/devis-stage-guard.service.ts); this migration reverts the
-- one known false record back to `approved_for_signing` so the architect can
-- send it properly through the guarded signing flow.
--
-- Every predicate is a safety guard so this can NEVER touch anything else:
--   * d.id = 11 AND the devis reference matches DVT0000941
--   * the project is the expected ArchiDoc project AD-46E43CC7
--   * the stage is still the false `sent_to_client`
--   * archisign_envelope_id IS NULL — if an envelope exists, the send was
--     real (or has since been done properly) and we must NOT revert.
-- If any condition fails (already fixed, legitimately sent since, different
-- environment), the UPDATE simply matches 0 rows and is a no-op.
UPDATE devis d
SET sign_off_stage = 'approved_for_signing'
FROM projects p
WHERE d.project_id = p.id
  AND d.id = 11
  AND (d.devis_number = 'DVT0000941' OR d.devis_code = 'DVT0000941')
  AND p.archidoc_id = 'AD-46E43CC7'
  AND d.sign_off_stage = 'sent_to_client'
  AND d.archisign_envelope_id IS NULL;
