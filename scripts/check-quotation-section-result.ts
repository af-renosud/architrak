/** Local-only regression inspection; never writes application data. */
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { illustratedPriceRows } from "../server/services/illustrated-quotation";
import { verifyQuotationManifest, canonicalProductReference } from "../server/services/quotation-source-manifest";
import type { QuotationSourceManifest } from "../server/services/quotation-source-manifest";
import type { ParsedDocument } from "../server/gmail/document-parser";
import { classifyQuotationSegments } from "../server/services/quotation-segment-classification";

async function main() {
  const [pdf, inventoryPath] = process.argv.slice(2);
  if (!pdf || !inventoryPath?.startsWith("/tmp/")) throw new Error("Provide PDF and /tmp inventory");
  let inventory: QuotationSourceManifest = JSON.parse(await readFile(inventoryPath, "utf8"));
  if (process.argv.includes("--classify")) inventory = await classifyQuotationSegments(inventory, "gemini-2.5-flash");
  inventory.sections.forEach(s => { s.reference = canonicalProductReference(s.reference); });
  const { stdout } = await promisify(execFile)("pdftotext", ["-layout", pdf, "-"]);
  const pages = stdout.split("\f");
  if (!pages[pages.length - 1].trim()) pages.pop();
  const rows = illustratedPriceRows(pages);
  // Native document fields retained separately from graphic product segments.
  inventory.segments = inventory.segments.filter(s => !s.id.startsWith("document-"));
  inventory.documentText = [...pages, ...inventory.segments.filter(s => s.disposition === "document").map(s => s.text)].join("\n");
  pages.forEach((text, i) => inventory.segments.push({ id: `document-${i + 1}`, section: "document",
    page: i + 1, text, disposition: text.trim() ? "document" : "uncertain",
    region: { page: i + 1, x: 0, y: 0, w: 1, h: 1 } }));
  inventory.inventoriedPages = pages.map((_, i) => i + 1);
  const candidate: ParsedDocument = { documentType: "quotation", rawText: inventory.documentText,
    lineItems: inventory.sections.map((s, i) => ({ ...rows[i],
      description: inventory.segments.filter(t => t.section === s.id && t.disposition === "item").map(t => t.text).join("\n"),
    })) };
  const result = verifyQuotationManifest(inventory, rows, candidate, pages.length);
  await writeFile("/tmp/quotation-checked-candidate.json", JSON.stringify({ inventory, candidate, result }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ verified: result.verified, failures: result.failures, issues: result.coverage?.issues,
    rows: rows.length, totalHt: rows.reduce((sum, r) => sum + r.total, 0),
    critical: [9, 10, 17].map(i => ({ reference: inventory.sections[i]?.reference,
      introductionPage: rows[i]?.page, total: rows[i]?.total })) }, null, 2));
}
main().catch(() => { console.error("Disposable verification failed; no application data changed."); process.exitCode = 1; });