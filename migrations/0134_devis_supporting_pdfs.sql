CREATE TABLE IF NOT EXISTS devis_supporting_pdfs (
 id serial PRIMARY KEY,
 devis_id integer NOT NULL REFERENCES devis(id) ON DELETE CASCADE,
 label text NOT NULL,
 file_name text NOT NULL,
 storage_key text NOT NULL,
 page_count integer NOT NULL,
 byte_size integer NOT NULL,
 position integer NOT NULL
);