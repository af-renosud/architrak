import { randomUUID } from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createArchitectCorrectionService, correctedFinancialBlocker } from "../services/architect-quotation-correction";
import { correctionCents, correctionMoney, previewCorrectionTotals } from "../../shared/architect-quotation";
import { transferCorrectionPassage } from "../../client/src/components/devis/architect-correction-model";

// Entire schema is disposable and isolated. No application project, provider,
// object storage, email, signature or existing user is touched.
const enabled = !!process.env.DATABASE_URL && process.env.RUN_ARCHITECT_DB_TESTS === "1";
const suite = enabled ? describe : describe.skip;
suite("architect correction real PostgreSQL transactions (isolated schema)", () => {
  const schema = `architect_test_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool, pool: pg.Pool, source: Buffer;
  let service: ReturnType<typeof createArchitectCorrectionService>;
  let quoteId = 0;
  const current = () => service.get(quoteId);
  const save = async (mutate: (draft: Awaited<ReturnType<typeof current>>["draft"]) => void) => {
    const snapshot = await current(), draft = structuredClone(snapshot.draft);
    mutate(draft);
    return service.save(quoteId, { ...draft, expectedVersion: snapshot.version }, 1);
  };
  const confirm = async (ttc: string) => {
    const s = await current();
    return service.confirm(quoteId, { expectedVersion: s.version, ttc, page: 1, confirmedFromPdf: true }, 1);
  };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE TABLE users(id integer PRIMARY KEY,first_name text,last_name text,email text);
      CREATE TABLE projects(id integer PRIMARY KEY,archived_at timestamptz);
      CREATE TABLE devis(id serial PRIMARY KEY, project_id integer NOT NULL,contractor_id integer,status text DEFAULT 'draft',
        accounting_state text DEFAULT 'active',sign_off_stage text DEFAULT 'received',closure_state text DEFAULT 'open',
        pdf_storage_key text,pdf_file_name text,ai_extracted_data jsonb,amount_ht numeric(12,2),amount_ttc numeric(12,2),
        description_fr text,updated_at timestamptz DEFAULT now(),signed_pdf_storage_key text,archisign_envelope_id text);
      CREATE TABLE devis_line_items(id serial PRIMARY KEY,devis_id integer,line_number integer,description text,quantity numeric(12,3),
        unit text,unit_price_ht numeric(12,2),total_ht numeric(12,2),check_notes text);
      CREATE TABLE devis_translations(devis_id integer PRIMARY KEY,status text,header_translated jsonb,line_translations jsonb,
        contexts_version integer DEFAULT 0,approved_at timestamptz,approved_by integer,approved_by_email text,
        translated_pdf_storage_key text,combined_pdf_storage_key text,error_message text,updated_at timestamptz DEFAULT now());
      CREATE TABLE invoices(id serial PRIMARY KEY,devis_id integer);
      CREATE TABLE situations(id serial PRIMARY KEY,devis_id integer);
      CREATE TABLE acompte_no_invoice_payments(id serial PRIMARY KEY,devis_id integer);
      CREATE TABLE certificats(id serial PRIMARY KEY,project_id integer,contractor_id integer,status text);
      CREATE TABLE situation_lines(id serial PRIMARY KEY,devis_line_item_id integer);
      CREATE TABLE client_checks(id serial PRIMARY KEY,devis_line_item_id integer,payload text);
      CREATE FUNCTION guard_duplicate_extraction_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'immutable audit'; END; $$ LANGUAGE plpgsql;
      INSERT INTO users VALUES(1,'Camille','Laurent','camille@test.invalid');
      INSERT INTO projects VALUES(1,NULL);`);
    const migration = fs.readFileSync("migrations/0139_architect_quotation_corrections.sql", "utf8");
    await pool.query(migration); await pool.query(migration); // replay-safe
    const pdf = await PDFDocument.create(); pdf.addPage([200, 200]); source = Buffer.from(await pdf.save());
    service = createArchitectCorrectionService({ pool, readPdf: async () => source });
  });
  afterAll(async () => { if (pool) await pool.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); } });
  beforeEach(async () => {
    const row = await pool.query(`INSERT INTO devis(project_id,contractor_id,pdf_storage_key,pdf_file_name,ai_extracted_data,amount_ht,amount_ttc,description_fr)
      VALUES(1,42,'fixture.pdf','original.pdf',$1,4505,4955.50,'Menuiseries') RETURNING id`,
      [JSON.stringify({ tvaRate: 10, quotationVerification: { verified: false }, originalOcr: "unchanged source extraction" })]);
    quoteId = row.rows[0].id;
    await pool.query(`INSERT INTO devis_line_items(devis_id,line_number,description,quantity,unit,unit_price_ht,total_ht)
      VALUES($1,1,'Door A',1,'u',1795,1795),($1,2,'Door B',1,'u',1795,1795),($1,3,'Terminal',1,'u',915,915)`, [quoteId]);
    await pool.query(`INSERT INTO devis_translations(devis_id,status,header_translated,line_translations,contexts_version,approved_at,combined_pdf_storage_key)
      VALUES($1,'finalised','{"description":"Old English"}','[]',7,now(),'old-combined.pdf')`, [quoteId]);
  });
  it("saves unrestricted bilingual/header/context edits and reorder with stable links, audit, cleared approval and source unchanged", async () => {
    const before = await current(), ids = before.draft.lines.map(l => l.id);
    await pool.query("INSERT INTO client_checks(devis_line_item_id,payload) VALUES($1,'evidence')", [ids[0]]);
    const result = await save(d => {
      d.headerFr = "Header corrected"; d.headerEn = "Human English";
      d.explanationFr = "Contexte FR"; d.explanationEn = "Context EN";
      d.lines[0].descriptionFr = "Door A complete specification"; d.lines[0].descriptionEn = "Manual translation";
      d.lines[0].explanationFr = "Explication libre"; d.lines.reverse();
      d.lines.push({ id: null,clientKey: "context-new",kind: "context",descriptionFr: "Contexte",descriptionEn: "Context",
        explanationFr: "",explanationEn: "",quantity: "0",unit: "",unitPriceHt: "0.00",totalHt: "0.00",vatRate: "",included: false });
    });
    expect(result.draft.lines.slice(0, 3).map(l => l.id)).toEqual([...ids].reverse());
    expect((await pool.query("SELECT devis_line_item_id FROM client_checks WHERE payload='evidence'")).rows[0].devis_line_item_id).toBe(ids[0]);
    const q = (await pool.query("SELECT * FROM devis WHERE id=$1", [quoteId])).rows[0];
    expect(q.ai_extracted_data.originalOcr).toBe("unchanged source extraction"); expect(q.pdf_storage_key).toBe("fixture.pdf");
    const t = (await pool.query("SELECT * FROM devis_translations WHERE devis_id=$1", [quoteId])).rows[0];
    expect(t.status).toBe("edited"); expect(t.approved_at).toBeNull(); expect(t.combined_pdf_storage_key).toBeNull(); expect(t.contexts_version).toBe(8);
    expect(result.history[0].actor).toBe("Camille Laurent");
    expect((await pool.query("SELECT before_snapshot,after_snapshot FROM quotation_architect_audit WHERE devis_id=$1", [quoteId])).rows[0].before_snapshot.lines).toHaveLength(3);
    const reload = await current();
    expect(reload.draft.headerEn).toBe("Human English"); expect(reload.draft.explanationFr).toBe("Contexte FR");
  });
  it("creates immutable independently human-transcribed PDF digest baseline, not mutable header totals or bad OCR", async () => {
    const result = await confirm("4963.87");
    expect(result.baseline?.ttc).toBe("4963.87"); expect(result.baseline?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(confirm("4955.50")).rejects.toThrow("already locked");
    await expect(pool.query("UPDATE quotation_source_baselines SET ttc=1 WHERE devis_id=$1", [quoteId])).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM quotation_source_baselines WHERE devis_id=$1", [quoteId])).rejects.toThrow("immutable");
    await expect(pool.query("UPDATE devis SET ai_extracted_data='{}' WHERE id=$1", [quoteId])).rejects.toThrow("preserved");
    await expect(pool.query("UPDATE devis SET pdf_storage_key='replacement.pdf' WHERE id=$1", [quoteId])).rejects.toThrow("preserved");
    expect((await pool.query("SELECT amount_ttc FROM devis WHERE id=$1", [quoteId])).rows[0].amount_ttc).toBe("4955.50");
  });
  it("applies priced additions and actual mixed VAT/discount corrections only as a full exact-TTC batch", async () => {
    const initial = await current(), proposed = structuredClone(initial.draft);
    proposed.lines[0].vatRate = "20"; proposed.lines[1].vatRate = "10"; proposed.lines[2].vatRate = "5.5";
    proposed.discountHt = "63.47";
    proposed.lines.push({ ...proposed.lines[0], id: null, clientKey: "new-priced", totalHt: "43.21",unitPriceHt: "43.21", vatRate: "0" });
    const totals = previewCorrectionTotals(proposed);
    const confirmed = await confirm(totals.ttc);
    const result = await service.save(quoteId, { ...proposed, expectedVersion: confirmed.version }, 1);
    expect(result.draft.lines).toHaveLength(4);
    expect((await pool.query("SELECT amount_ht,amount_ttc FROM devis WHERE id=$1", [quoteId])).rows[0]).toEqual({ amount_ht: totals.ht,amount_ttc: totals.ttc });
    expect(correctedFinancialBlocker(result.draft, result.baseline)).toBeNull();
    const invalid = structuredClone(result.draft); invalid.lines[3].totalHt = "43.22";
    await expect(service.save(quoteId, { ...invalid,expectedVersion: result.version }, 1)).rejects.toMatchObject({ code: "TTC_MISMATCH" });
    expect((await current()).draft.lines[3].totalHt).toBe("43.21");
  });
  it("rolls back every row and translation if audit insertion fails", async () => {
    await pool.query(`CREATE FUNCTION fail_audit_fixture() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_audit_fixture BEFORE INSERT ON quotation_architect_audit FOR EACH ROW EXECUTE FUNCTION fail_audit_fixture();`);
    const before = await current();
    try { await expect(save(d => { d.headerFr = "Must roll back"; d.lines[0].descriptionFr = "Must roll back"; })).rejects.toThrow("fixture audit failure"); }
    finally { await pool.query("DROP TRIGGER fail_audit_fixture ON quotation_architect_audit"); }
    const after = await current(); expect(after.version).toBe(before.version); expect(after.draft).toEqual(before.draft);
  });
  it("rejects concurrent stale full batches without overwriting a winner", async () => {
    const initial = await current();
    const results = await Promise.allSettled([
      service.save(quoteId, { ...initial.draft, headerFr: "Winner A",expectedVersion: initial.version }, 1),
      service.save(quoteId, { ...initial.draft, headerFr: "Winner B",expectedVersion: initial.version }, 1),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await current()).history).toHaveLength(1);
  });
  it("preserves genuinely missing quantity, unit price and VAT on text-only edits rather than inventing extraction figures", async () => {
    await pool.query("UPDATE devis_line_items SET quantity=NULL,unit_price_ht=NULL WHERE devis_id=$1", [quoteId]);
    await pool.query("UPDATE devis SET ai_extracted_data=$2 WHERE id=$1", [quoteId,JSON.stringify({ originalOcr: "unknown VAT" })]);
    const before = await current();
    expect(before.draft.lines[0]).toMatchObject({ quantity: "",unitPriceHt: "",vatRate: "" });
    const result = await save(d => { d.lines[0].descriptionFr = "Human context with unknown extracted figures"; });
    expect(result.draft.lines[0]).toMatchObject({ quantity: "",unitPriceHt: "",vatRate: "" });
    const row = (await pool.query("SELECT quantity,unit_price_ht FROM devis_line_items WHERE id=$1", [result.draft.lines[0].id])).rows[0];
    expect(row).toEqual({ quantity: null,unit_price_ht: null });
  });
  it("protects signed and financially referenced prices while allowing a new contextual interpretation", async () => {
    await pool.query("INSERT INTO situation_lines(devis_line_item_id) SELECT id FROM devis_line_items WHERE devis_id=$1 LIMIT 1", [quoteId]);
    await pool.query("UPDATE devis SET signed_pdf_storage_key='immutable-signed.pdf' WHERE id=$1", [quoteId]);
    await expect(save(d => { d.lines[0].totalHt = "1796.00"; })).rejects.toThrow("protected");
    await save(d => { d.lines[0].descriptionFr = "Reviewed contextual specification"; });
    expect((await pool.query("SELECT signed_pdf_storage_key FROM devis WHERE id=$1", [quoteId])).rows[0].signed_pdf_storage_key).toBe("immutable-signed.pdf");
  });
  it("blocks destructive ID changes and background/direct source, row and translation overwrites", async () => {
    await expect(save(d => { d.lines.splice(0,1); })).rejects.toThrow("retained exactly once");
    await expect(save(d => { d.lines[1].id = d.lines[0].id; })).rejects.toThrow("retained exactly once");
    await save(d => { d.headerFr = "Protected correction"; });
    await expect(pool.query("UPDATE devis_line_items SET description='bad' WHERE devis_id=$1", [quoteId])).rejects.toThrow("correction editor");
    await expect(pool.query("UPDATE devis_translations SET line_translations='[]' WHERE devis_id=$1", [quoteId])).rejects.toThrow("cannot be overwritten");
    await expect(pool.query("UPDATE devis_translations SET status='processing' WHERE devis_id=$1", [quoteId])).rejects.toThrow("cannot be overwritten");
    await expect(pool.query("DELETE FROM quotation_architect_audit WHERE devis_id=$1", [quoteId])).rejects.toThrow("immutable");
    await pool.query("UPDATE devis_line_items SET check_notes='new conversation evidence' WHERE devis_id=$1", [quoteId]);
  });
  it("rejects source-byte mismatch, absent VAT and missing baseline for financial changes without mutation", async () => {
    await expect(save(d => { d.lines[0].totalHt = "1796.00"; })).rejects.toThrow("Confirm the final TTC");
    await confirm("4955.50");
    await expect(save(d => { d.lines[0].vatRate = ""; })).rejects.toThrow("valid decimal");
    const old = source, other = await PDFDocument.create(); other.addPage([220, 200]); source = Buffer.from(await other.save());
    try { await expect(save(d => { d.headerFr = "Changed"; })).rejects.toThrow("locked source receipt"); } finally { source = old; }
    expect(correctionMoney(correctionCents("4955.51") - correctionCents("4955.50"))).toBe("0.01");
  });
  it("corrects the shifted eighteen-item regression through the operator passage workflow without deleting equal-price items", async () => {
    await pool.query("DELETE FROM devis_line_items WHERE devis_id=$1", [quoteId]);
    for (let i = 1; i <= 18; i++) {
      const amount = i === 10 || i === 11 ? "1795.00" : i === 18 ? "915.00" : `${84 + i}.37`;
      const text = i === 10 ? "Legitimate joinery item A, abbreviated."
        : i === 11 ? "Full specification A: glazing, finish and installation."
          : i > 11 ? `Complete independent specification ${i - 1}.` : `Complete independent specification ${i}.`;
      await pool.query(`INSERT INTO devis_line_items(devis_id,line_number,description,quantity,unit,unit_price_ht,total_ht)
        VALUES($1,$2,$3,1,'u',$4,$4)`, [quoteId,i,text,amount]);
    }
    const initial = await current(), ids = initial.draft.lines.map(l => l.id), sourceTotals = previewCorrectionTotals(initial.draft);
    const confirmed = await confirm(sourceTotals.ttc), draft = structuredClone(confirmed.draft);
    // These are the same operations exposed by selected/full passage Move in
    // the editor: only descriptions move, never prices or existing identities.
    for (let from = 10; from < 18; from++) draft.lines = transferCorrectionPassage(draft.lines, from, from - 1, 0, draft.lines[from].descriptionFr.length, true);
    draft.lines[17].descriptionFr = "MEXT205, terminal independent specification, complete.";
    draft.lines[9].descriptionEn = "Complete human English for legitimate joinery item A.";
    draft.lines[10].descriptionEn = "Distinct legitimate joinery item B.";
    const result = await service.save(quoteId, { ...draft,expectedVersion: confirmed.version }, 1);
    expect(result.draft.lines.map(l => l.id)).toEqual(ids);
    expect(result.draft.lines[9].descriptionFr).toContain("Full specification A");
    expect(result.draft.lines[10].descriptionFr).toContain("specification 11");
    expect(result.draft.lines[17].descriptionFr).toContain("MEXT205");
    expect(result.draft.lines.filter(l => l.totalHt === "1795.00")).toHaveLength(2);
    expect(result.draft.lines[17].totalHt).toBe("915.00");
    expect(previewCorrectionTotals(result.draft)).toEqual(sourceTotals);
    expect(result.workingTotals).toEqual({ ht: sourceTotals.ht,ttc: sourceTotals.ttc });
    expect((await current()).draft.lines[17].descriptionFr).toContain("MEXT205");
  });
});
