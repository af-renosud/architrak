CREATE TABLE IF NOT EXISTS jobs_jotters (
  user_id integer PRIMARY KEY,
  content text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'jobs_jotters'::regclass AND conname = 'jobs_jotters_user_id_users_id_fk') THEN
    ALTER TABLE jobs_jotters ADD CONSTRAINT jobs_jotters_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'jobs_jotters'::regclass AND conname = 'jobs_jotters_content_length') THEN
    ALTER TABLE jobs_jotters ADD CONSTRAINT jobs_jotters_content_length CHECK (char_length(content) <= 100000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'jobs_jotters'::regclass AND conname = 'jobs_jotters_revision_positive') THEN
    ALTER TABLE jobs_jotters ADD CONSTRAINT jobs_jotters_revision_positive CHECK (revision >= 0);
  END IF;
END $$;
