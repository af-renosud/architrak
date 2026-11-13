CREATE TABLE IF NOT EXISTS devis_replacements (
  id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  old_devis_id integer NOT NULL REFERENCES devis(id) ON DELETE RESTRICT,
  new_devis_id integer NOT NULL REFERENCES devis(id) ON DELETE RESTRICT,
  actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_name text NOT NULL,
  note text NOT NULL,
  old_label text NOT NULL,
  new_label text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT devis_replacements_valid CHECK (old_devis_id <> new_devis_id AND length(trim(note)) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS devis_replacements_old_unique ON devis_replacements(old_devis_id);
CREATE UNIQUE INDEX IF NOT EXISTS devis_replacements_new_unique ON devis_replacements(new_devis_id);
CREATE INDEX IF NOT EXISTS devis_replacements_project_idx ON devis_replacements(project_id);
