/** Disposable, read-only source experiment. Never accesses stored quotations. */
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collectQuotationSourceInventory } from "../server/services/quotation-source-inventory";
import { collectSectionInventory } from "../server/services/quotation-section-inventory";
import { illustratedPriceRows } from "../server/services/illustrated-quotation";

async function main() {
  const [path, out] = process.argv.slice(2);
  if (!path || !out?.startsWith("/tmp/") || out.includes("..")) throw new Error("Provide a local PDF and /tmp/ output path");
  const pdf = await readFile(path);
  const { stdout } = await promisify(execFile)("pdfinfo", [path], { timeout: 30000 });
  const pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(pages) || pages < 1) throw new Error("Unverified page count");
  const { stdout: text } = await promisify(execFile)("pdftotext", ["-layout", path, "-"], { timeout: 30000 });
  const pageTexts = text.split("\f").slice(0, pages);
  const priorPath = process.argv.find(arg => arg.startsWith("--prior="))?.slice("--prior=".length);
  if (priorPath && (!priorPath.startsWith("/tmp/") || priorPath.includes(".."))) throw new Error("Prior must be a disposable /tmp file");
  const prior = priorPath ? JSON.parse(await readFile(priorPath, "utf8")).inventory : undefined;
  const inventory = process.argv.includes("--sections")
    ? await collectSectionInventory(pdf, illustratedPriceRows(pageTexts), "gemini-2.5-flash", prior)
    : await collectQuotationSourceInventory(pdf, pages, "gemini-2.5-flash");
  await writeFile(out, JSON.stringify(inventory, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ pages, sections: inventory.sections.length, segments: inventory.segments.length,
    uncertain: inventory.segments.filter(s => s.disposition === "uncertain").length }));
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const category = error && typeof error === "object" && "issues" in error ? "invalid_inventory_shape"
    : error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? `provider_http_${error.status}`
      : /fetch failed|network|ENOTFOUND|ECONN/i.test(message) ? "provider_network"
      : /timeout|timed out|abort/i.test(message) ? "provider_timeout"
      : /not valid JSON|Unexpected token|Unterminated/i.test(message) ? "invalid_provider_json"
      : message === "Source inventory provider is unavailable" ? "provider_not_configured"
      : /^section_inventory_failed:(layout|render_section_\d+|transcribe_section_\d+):(invalid_crop|invalid_shape|invalid_json|http_\d+|timeout|network|unavailable|response_blocked|authorization|rate_limit|model_unavailable)$/.test(message) ? message
      : "inventory_unavailable";
  console.error(`Independent source inventory failed (${category}); no quotation was changed.`);
  process.exitCode = 1;
});