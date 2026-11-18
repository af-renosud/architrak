/**
 * Read-only check of the private seven-page incident original.
 * Usage: npx tsx scripts/verify-quotation-poste-original.ts /path/to/source.pdf
 * No source text, identity, bank details or PDF is written to the repository.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { recoverPosteTable } from "../server/services/quotation-poste-table";
import { collectPricedEvidence } from "../server/services/quotation-priced-evidence";
import { createHash } from "node:crypto";

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Pass the private original PDF path.");
  const bytes = readFileSync(path);
  const count = (await PDFDocument.load(bytes)).getPageCount();
  assert.equal(count, 7);
  const pages = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8", timeout: 30000 }).split("\f");
  if (!pages.at(-1)?.trim()) pages.pop();
  assert.equal(pages.length, count);
  const result = recoverPosteTable(pages);
  assert.ok(result, "Exact source table must recover");
  assert.deepEqual(result.rows.map(row => row.total), [
    4680, 2730, 400, 1820, 12630, 9477, 5720, 1040, 780, 2106, 4850, 2450, 900, 7606, 2800, 3211,
  ]);
  assert.equal(result.amountHt, 63200);
  assert.equal(result.amountTtc, 75059);
  const heatPump = result.rows[13];
  assert.match(heatPump.description, /^PS\.27 POMPE À CHALEUR/);
  assert.match(heatPump.description, /L'APPAREIL/);
  assert.match(heatPump.description, /FORMATION DE L'UTILISATEUR/);
  assert.match(heatPump.description, /ÉVACUATION DES EMBALLAGES/);
  assert.deepEqual(result.evidence[13].pages, [5, 6]);
  assert.ok(!result.rows.some(row => /PS\.28/i.test(row.description)));
  const audit = collectPricedEvidence({
    documentType: "quotation", lineItems: result.rows, nativeTableRecovery: {
      parser: "poste-table-v1", sourceDigest: createHash("sha256").update(bytes).digest("hex"),
      initialLineItems: [], evidence: result.evidence, amountHt: result.amountHt, amountTtc: result.amountTtc,
    },
  }, bytes);
  assert.equal(audit.issues.length, 0);
  console.log("PASS: seven-page source, all 16 ordered prices, complete cross-page heat pump, no PS.28, independent HT/TTC totals and source receipt.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
