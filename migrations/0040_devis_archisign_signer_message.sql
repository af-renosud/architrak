-- Persist the architect's optional personalised note for the signer.
--
-- The "Envoyer à la signature" dialog lets the architect attach a free-text
-- message that is forwarded to Archisign `/create` as the envelope `body`.
-- Archisign does not echo it back and may not render it in the signer email,
-- so we store our own copy here to close the audit loop. Written one-shot on
-- first send; the resume branch skips /create and never overwrites it. NULL
-- when the architect left the field empty.

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS archisign_signer_message text;
