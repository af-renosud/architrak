-- Data fix: refresh the document_parsing AI model setting from the retired
-- gemini-2.0-flash to gemini-2.5-flash so the parser stops emitting an
-- error-level "auto-upgrading" warning on every call. Idempotent.
UPDATE "ai_model_settings"
SET "model_id" = 'gemini-2.5-flash',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "task_type" = 'document_parsing'
  AND "provider" = 'gemini'
  AND "model_id" IN (
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro',
    'gemini-1.5-pro-latest',
    'gemini-pro',
    'gemini-pro-vision'
  );
