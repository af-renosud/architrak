CREATE TABLE archidoc_payment_suppliers (
  payment_supplier_id varchar(255) PRIMARY KEY, name text NOT NULL, normalized_name text NOT NULL,
  siret varchar(14), iban varchar(34), bic varchar(11), account_holder_name text, banking_verification_status text, rib_metadata jsonb NOT NULL,
  source_hash varchar(64) NOT NULL, source_sequence bigint NOT NULL, is_active boolean NOT NULL, is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamp, source_base_url text NOT NULL, archidoc_updated_at timestamp NOT NULL, synced_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT archidoc_payment_suppliers_siret_chk CHECK (siret IS NULL OR siret ~ '^[0-9]{14}$'),
  CONSTRAINT archidoc_payment_suppliers_lifecycle_chk CHECK ((is_deleted = false AND deleted_at IS NULL) OR is_deleted = true)
);--> statement-breakpoint
CREATE INDEX archidoc_payment_suppliers_siret_idx ON archidoc_payment_suppliers(siret);--> statement-breakpoint
CREATE INDEX archidoc_payment_suppliers_active_idx ON archidoc_payment_suppliers(is_deleted, normalized_name);--> statement-breakpoint
CREATE TABLE archidoc_payment_supplier_assignments (
  payment_supplier_id varchar(255) NOT NULL REFERENCES archidoc_payment_suppliers(payment_supplier_id),
  archidoc_project_id varchar(255) NOT NULL, assignment_id varchar(255) NOT NULL,
  direct_payment_status text NOT NULL, valid_from text, valid_until text, reason text, source_hash varchar(64) NOT NULL,
  source_sequence bigint NOT NULL, is_deleted boolean NOT NULL DEFAULT false, deleted_at timestamp,
  updated_at timestamp NOT NULL, synced_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT archidoc_payment_supplier_assignment_unique UNIQUE(payment_supplier_id, archidoc_project_id, assignment_id)
);--> statement-breakpoint
CREATE INDEX archidoc_payment_supplier_assignments_project_idx ON archidoc_payment_supplier_assignments(archidoc_project_id, is_deleted);--> statement-breakpoint
CREATE TABLE archidoc_payment_supplier_sync_state (
  stream varchar(64) PRIMARY KEY, sequence bigint NOT NULL DEFAULT 0, updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT archidoc_payment_supplier_sync_state_sequence_chk CHECK (sequence >= 0)
);--> statement-breakpoint
CREATE TABLE supplier_direct_payment_quotations (
  id serial PRIMARY KEY, project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  archidoc_project_id varchar(255) NOT NULL,
  source_document_id text NOT NULL, source_sha256 varchar(64) NOT NULL, file_name text NOT NULL,
  source_pdf bytea NOT NULL, extracted_payment_supplier_id varchar(255),
  extracted_supplier_name text, extracted_supplier_siret varchar(14), match_status text NOT NULL DEFAULT 'review_required',
  match_reason text, match_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  appointed_payment_supplier_id varchar(255) REFERENCES archidoc_payment_suppliers(payment_supplier_id),
  appointed_at timestamp, appointed_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT supplier_direct_payment_quotations_source_unique UNIQUE(project_id, source_document_id),
  CONSTRAINT supplier_direct_payment_quotations_sha256_chk CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT supplier_direct_payment_quotations_siret_chk CHECK (extracted_supplier_siret IS NULL OR extracted_supplier_siret ~ '^[0-9]{14}$'),
  CONSTRAINT supplier_direct_payment_quotations_status_chk CHECK (match_status IN ('review_required', 'matched', 'appointed'))
);--> statement-breakpoint
CREATE INDEX supplier_direct_payment_quotations_supplier_idx ON supplier_direct_payment_quotations(appointed_payment_supplier_id);