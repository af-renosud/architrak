CREATE TABLE IF NOT EXISTS client_project_budgets (
  project_id integer PRIMARY KEY CONSTRAINT client_project_budgets_project_id_projects_id_fk REFERENCES projects(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0,
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'client_project_budgets'::regclass AND conname = 'client_project_budgets_project_id_projects_id_fk') THEN
    ALTER TABLE client_project_budgets ADD CONSTRAINT client_project_budgets_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_project_budgets_entries_array') THEN
    ALTER TABLE client_project_budgets ADD CONSTRAINT client_project_budgets_entries_array CHECK (jsonb_typeof(entries) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_project_budgets_revision_positive') THEN
    ALTER TABLE client_project_budgets ADD CONSTRAINT client_project_budgets_revision_positive CHECK (revision >= 0);
  END IF;
END $$;
