import { buildQuotationPayload, generateCostAnalysisDraft, confirmCostAnalysis, saveCostAnalysisText } from "./server/services/devis-cost-analysis";
import { storage } from "./server/storage";
import { generateDevisTranslationPdf, generateCombinedPdf } from "./server/communications/devis-translation-generator";
import { writeFileSync } from "fs";

const DEVIS_ID = 2;

async function main() {
  const payload = await buildQuotationPayload(DEVIS_ID);
  console.log("=== PAYLOAD (first 1200 chars) ===\n" + payload.slice(0, 1200));
  console.log("payload length:", payload.length);

  console.log("\n=== GENERATE (real Gemini) ===");
  const t0 = Date.now();
  const gen = await generateCostAnalysisDraft(DEVIS_ID, "task379-verify@renosud.test");
  console.log("elapsed ms:", Date.now() - t0);
  if (gen.outcome !== "saved") throw new Error("generate outcome: " + gen.outcome);
  console.log("modelId:", gen.analysis.modelId, "revision:", gen.analysis.revision, "status:", gen.analysis.status);
  console.log("warnings:", JSON.stringify(gen.warnings));
  writeFileSync("/tmp/379-raw.md", gen.analysis.rawText);
  console.log("rawText length:", gen.analysis.rawText.length);
  const doc: any = gen.analysis.document;
  const blockTypes = doc.blocks.map((b: any) => b.type + (b.type === "heading" ? `:${b.content.map((c:any)=>c.text).join("")}` : b.type === "table" ? `:${b.rows.length}rows/${b.header.length}cols` : ""));
  console.log("blocks:", JSON.stringify(blockTypes, null, 1));

  console.log("\n=== CONFIRM ===");
  const conf = await confirmCostAnalysis(DEVIS_ID, gen.analysis.revision, "task379-verify@renosud.test");
  if (conf.outcome !== "saved") throw new Error("confirm outcome: " + conf.outcome);
  console.log("confirmed, revision:", conf.analysis.revision, "warnings:", JSON.stringify(conf.warnings));

  console.log("\n=== TRANSLATED PDF ===");
  const pdf = await generateDevisTranslationPdf(DEVIS_ID);
  writeFileSync("/tmp/379-translated.pdf", pdf.pdfBuffer);
  console.log("translated pdf bytes:", pdf.pdfBuffer.length, "key:", pdf.storageKey);

  console.log("\n=== COMBINED PDF ===");
  const comb = await generateCombinedPdf(DEVIS_ID);
  writeFileSync("/tmp/379-combined.pdf", comb.pdfBuffer);
  console.log("combined pdf bytes:", comb.pdfBuffer.length);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e); process.exit(1); });
