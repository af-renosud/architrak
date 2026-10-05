// Read-only production fixture supplied separately; all test writes are TEMP and rolled back.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { Client } = require("pg");
async function main() {
  const data = JSON.parse(Buffer.from(fs.readFileSync(process.argv[2], "utf8").trim(), "hex").toString("utf8"));
  const sql = fs.readFileSync("migrations/0140_mn1_alu_description_alignment.sql", "utf8");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    for (const name of ["devis", "devis_line_items", "devis_translations", "quotation_extraction_events", "quotation_architect_state"]) {
      await db.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING DEFAULTS) ON COMMIT DROP`);
    }
    for (const [table, rows] of [["devis", [data.devis]], ["devis_line_items", data.lines], ["devis_translations", [data.translation]]]) {
      for (const row of rows) await db.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)]);
    }
    // Avoid even advancing a public sequence for the temporary audit.
    await db.query("ALTER TABLE quotation_extraction_events ALTER COLUMN id SET DEFAULT 1");
    const original = (await db.query("SELECT * FROM devis_line_items ORDER BY line_number")).rows;
    await db.query(sql);
    const rows = (await db.query("SELECT * FROM devis_line_items ORDER BY line_number")).rows;
    assert.equal(rows.length, 18);
    for (let i=0; i<18; i++) {
      for (const key of ["id","quantity","unit_price_ht","total_ht"]) assert.equal(String(rows[i][key]),String(original[i][key]));
    }
    assert.match(rows[9].description,/010 - mext 104/i);
    assert.match(rows[10].description,/011 - mext 105/i);
    assert.match(rows[16].description,/017 - mext 204/i);
    assert.match(rows[17].description,/018 - MEXT 205/);
    const translated = (await db.query("SELECT line_translations FROM devis_translations")).rows[0].line_translations;
    assert.match(translated.find(x=>x.lineNumber===10).translation,/010 - mext 104/i);
    assert.match(translated.find(x=>x.lineNumber===11).translation,/011 - mext 105/i);
    assert.match(translated.find(x=>x.lineNumber===18).translation,/018 - MEXT 205/);
    const audit = await db.query("SELECT count(*)::int AS n FROM quotation_extraction_events");
    assert.equal(audit.rows[0].n,1);
    await db.query(sql);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM quotation_extraction_events")).rows[0].n,1);
    assert.deepEqual((await db.query("SELECT * FROM devis_line_items ORDER BY line_number")).rows,rows);
    console.log("PASS: production fixture repaired, 18 IDs and all figures preserved; audit and repeat no-op verified.");
    await db.query("ROLLBACK");
  } finally { await db.end(); }
}
main().catch(e=>{ console.error(e.message);process.exitCode=1; });
