CREATE TABLE IF NOT EXISTS external_works (
 id serial PRIMARY KEY,
 project_id integer NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 reference text NOT NULL,
 normalized_reference text NOT NULL,
 description text NOT NULL,
 amount_ht numeric(12,2) NOT NULL,
 amount_ttc numeric(12,2) NOT NULL,
 company_name text, lot text, completion_date date,
 status text NOT NULL DEFAULT 'active',
 version integer NOT NULL DEFAULT 1,
 void_reason text,
 created_at timestamp NOT NULL DEFAULT now(),
 updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS external_works_project_reference_unique ON external_works(project_id, normalized_reference);
ALTER TABLE external_works DROP CONSTRAINT IF EXISTS external_works_values_check;
ALTER TABLE external_works ADD CONSTRAINT external_works_values_check CHECK (amount_ht >= 0 AND amount_ttc >= amount_ht);
ALTER TABLE external_works DROP CONSTRAINT IF EXISTS external_works_state_check;
ALTER TABLE external_works ADD CONSTRAINT external_works_state_check CHECK (status IN ('active','void') AND version > 0 AND (status <> 'void' OR (void_reason IS NOT NULL AND length(trim(void_reason)) > 0)));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS external_work_audit (
 id serial PRIMARY KEY,
 entry_id integer NOT NULL REFERENCES external_works(id) ON DELETE RESTRICT,
 project_id integer NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 action text NOT NULL,
 actor_id integer NOT NULL REFERENCES users(id),
 actor_name text NOT NULL,
 "before" jsonb,
 "after" jsonb NOT NULL,
 reason text,
 created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_work_audit_project_idx ON external_work_audit(project_id);
--> statement-breakpoint
-- Repair partial schema recovery as well as fresh installs.
DO $$
DECLARE item record;
BEGIN
 FOR item IN SELECT * FROM (VALUES
   ('external_works', 'external_works_pkey', 'PRIMARY KEY (id)'),
   ('external_works', 'external_works_project_id_fkey', 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT'),
   ('external_work_audit', 'external_work_audit_pkey', 'PRIMARY KEY (id)'),
   ('external_work_audit', 'external_work_audit_entry_id_fkey', 'FOREIGN KEY (entry_id) REFERENCES external_works(id) ON DELETE RESTRICT'),
   ('external_work_audit', 'external_work_audit_project_id_fkey', 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT'),
   ('external_work_audit', 'external_work_audit_actor_id_fkey', 'FOREIGN KEY (actor_id) REFERENCES users(id)')
 ) AS guards(table_name, constraint_name, definition)
 LOOP
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = item.table_name::regclass AND conname = item.constraint_name) THEN
     EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', item.table_name, item.constraint_name, item.definition);
   END IF;
 END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_external_work_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'External works history is permanent; void an entry instead';
END;
$$;
DROP TRIGGER IF EXISTS external_work_audit_immutable ON external_work_audit;
CREATE TRIGGER external_work_audit_immutable BEFORE UPDATE OR DELETE ON external_work_audit FOR EACH ROW EXECUTE FUNCTION protect_external_work_history();
DROP TRIGGER IF EXISTS external_works_no_delete ON external_works;
CREATE TRIGGER external_works_no_delete BEFORE DELETE ON external_works FOR EACH ROW EXECUTE FUNCTION protect_external_work_history();
