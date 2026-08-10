import { saveCostAnalysisText, confirmCostAnalysis, removeCostAnalysis } from "./server/services/devis-cost-analysis";
import { storage } from "./server/storage";
import { generateDevisTranslationPdf } from "./server/communications/devis-translation-generator";
import { readFileSync, writeFileSync } from "fs";

const DEVIS_ID = 2;

async function main() {
  const real = readFileSync("/tmp/379-raw.md", "utf8");
  // Edge case: fragmented table row (line breaks inside a row) + a very long
  // table (60 rows, long cells) appended to the REAL Gemini output.
  const longRows = Array.from({ length: 60 }, (_, i) =>
    `| Extra Center ${i + 1} | ${"Sub-work with a fairly long description of trades and materials; ".repeat(3)}item ${i + 1} | Mixed | ${(1000 + i).toFixed(2)} € | Medium |`,
  ).join("\n");
  const edited = real +
    `\n\n## Stress Table\n| Cost Center | Included Sub-Works | Necessity | Est. Cost (TTC) | Savings Opportunity |\n| --- | --- | --- | --- | --- |\n| Fragmented Row | part one\n| Mandatory | 123.00 €\n| Low |\n${longRows}\n`;

  const existing = await storage.getDevisCostAnalysis(DEVIS_ID);
  const saved = await saveCostAnalysisText(DEVIS_ID, edited, existing!.revision, "task379-verify@renosud.test");
  if (saved.outcome !== "saved") throw new Error("save outcome: " + saved.outcome);
  console.log("EDGE warnings:", JSON.stringify(saved.warnings, null, 1));
  const doc: any = saved.analysis.document;
  const stress = doc.blocks.find((b: any) => b.type === "table" && b.rows.length > 10);
  console.log("stress table rows:", stress?.rows.length, "cols:", stress?.header.length);
  const frag = stress?.rows.find((r: any) => r.some((c: any) => c.some((n: any) => n.text.includes("Fragmented Row") || n.text.includes("part one"))));
  console.log("fragmented row preserved:", !!frag, JSON.stringify(frag?.map((c: any) => c.map((n: any) => n.text).join("")).slice(0, 5)));
  const last = stress?.rows[stress.rows.length - 1]?.map((c: any) => c.map((n: any) => n.text).join(""))[0];
  console.log("last stress row first cell:", last);

  const conf = await confirmCostAnalysis(DEVIS_ID, saved.analysis.revision, "task379-verify@renosud.test");
  if (conf.outcome !== "saved") throw new Error("confirm outcome: " + conf.outcome);
  console.log("confirm warnings persisted:", JSON.stringify(conf.analysis.warnings));

  const pdf = await generateDevisTranslationPdf(DEVIS_ID);
  writeFileSync("/tmp/379-edge.pdf", pdf.pdfBuffer);
  console.log("edge pdf bytes:", pdf.pdfBuffer.length);

  // Cleanup: remove the analysis so the dev devis is left as we found it.
  const rm = await removeCostAnalysis(DEVIS_ID, conf.analysis.revision);
  console.log("cleanup remove:", rm.outcome);
  const tr = await storage.getDevisTranslation(DEVIS_ID);
  console.log("cached keys after remove:", tr?.translatedPdfStorageKey, tr?.combinedPdfStorageKey, "contextsVersion:", tr?.contextsVersion);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e); process.exit(1); });
