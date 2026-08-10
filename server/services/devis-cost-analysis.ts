import { storage } from "../storage";
import { generateWithGemini } from "./gemini";
import {
  parseCostAnalysisMarkdown,
  type CostAnalysisDocument,
} from "@shared/cost-analysis-doc";
import type { DevisCostAnalysis, DevisTranslationLine } from "@shared/schema";

/**
 * Cost-analysis / value-engineering appendix service (Task #378).
 *
 * Workflow (mirrors the AI data-entry convention):
 *   generate (Gemini) → draft rawText → architect edits/reviews → confirm.
 * Only CONFIRMED analyses render into outbound PDFs. All mutations are
 * blocked while the translation is finalised (same lock as line contexts);
 * the architect must unlock the translation first.
 */

// Bump when the prompt text below changes materially — persisted per
// analysis so we can tell which prompt produced a stored draft.
export const COST_ANALYSIS_PROMPT_VERSION = 1;

/**
 * System prompt — the user's Construction Cost Analyst "Gem" prompt with
 * strict markdown-only output formatting rules (attached_assets upload,
 * 2026-08-06). Keep the formatting contract in sync with
 * shared/cost-analysis-doc.ts.
 */
export const COST_ANALYSIS_SYSTEM_PROMPT = `Role & Objective
You are an expert Construction Cost Analyst and Value Engineering Advisor. Your job is to review contractors' quotations, group individual line items into functional bodies of work ("Cost Centers"), and explain them to clients in clear, non-technical language. You help clients understand where their money is being spent, which components are mandatory versus optional, and where practical, real-world cost savings can be achieved.

Core Instructions
- Aggregate into Cost Centers: Group individual trades and materials into complete, functional packages (e.g., group earthworks, concrete, membranes, and tiling together under "Exterior Terrace").
- Determine Necessity: Distinguish between structural/building code requirements (e.g., structural slabs, mandatory waterproofing) and optional enhancements (e.g., uncoupling membranes like Ditra Drain, decorative trims, advanced automation).
- Propose Real-World Cost Savings: Identify alternative methods or material swaps that lower costs without compromising structural safety.
- Translate Technical Jargon: Explain standard construction methods, acronyms, and trade terminology using plain, conversational language.

Strict Output Formatting & Parsing Rules
To ensure strict software compatibility, you must adhere to the following formatting requirements:
- Plain Text Markdown Only: Do NOT use HTML tags, images, hyperlinks, or horizontal rule separators (---). Use formal Markdown headings (##) to separate sections.
- Table Row Formatting: Every table row MUST be output as a single, continuous line (| cell | cell | cell |). NEVER insert line breaks, carriage returns, or blank lines inside a table cell.
- In-Cell Delimiters: If a table cell contains multiple items, separate them using semicolons or commas (e.g., Site setup; draining; fittings removal). Do NOT use bullet points or line breaks within table cells.
- Character Restrictions: Do NOT use pipe characters (|) inside cell text unless escaped as \\|.
- Value Engineering Structure: Use bold inline labels for each breakdown block.

Standard Response Template

## Summary
[1-2 direct paragraphs introducing the analysis, overall budget breakdown, and primary findings.]

## Cost Center Summary
| Cost Center | Included Sub-Works | Necessity | Est. Cost (TTC) | Savings Opportunity |
| --- | --- | --- | --- | --- |
| [Package Name] | [Sub-item 1; Sub-item 2; Sub-item 3] | [Mandatory / Optional / Mixed] | [Amount in €] | [High / Medium / Low] |

## Value Engineering
[One block per opportunity using bold inline labels, e.g. **Opportunity:** ... **Estimated Saving:** ... **Trade-off:** ...]`;

/**
 * Assembles the quotation payload sent to the model: line items with FR
 * descriptions, EN translations when available, quantities and amounts,
 * plus header totals / TVA / lot. Amounts are reproduced verbatim from the
 * devis — the model must analyse, never recompute.
 */
export async function buildQuotationPayload(devisId: number): Promise<string> {
  const devis = await storage.getDevis(devisId);
  if (!devis) throw new Error(`Devis ${devisId} not found`);
  const project = await storage.getProject(devis.projectId);
  const contractor = await storage.getContractor(devis.contractorId);
  const lines = await storage.getDevisLineItems(devisId);
  const translation = await storage.getDevisTranslation(devisId);

  const byLineNumber = new Map<number, DevisTranslationLine>();
  for (const t of (translation?.lineTranslations as DevisTranslationLine[] | null) ?? []) {
    byLineNumber.set(t.lineNumber, t);
  }

  const parts: string[] = [];
  parts.push(`QUOTATION (devis) ${devis.devisCode}${devis.devisNumber ? ` — n° ${devis.devisNumber}` : ""}`);
  if (project) parts.push(`Project: ${project.name} (${project.code})`);
  if (contractor) parts.push(`Contractor: ${contractor.name}`);
  if (devis.lotId) {
    const lot = await storage.getLot(devis.lotId);
    if (lot) parts.push(`Lot ${lot.lotNumber}: ${lot.descriptionUk || lot.descriptionFr}`);
  }
  if (devis.descriptionFr) parts.push(`Scope (FR): ${devis.descriptionFr}`);
  parts.push(
    `Totals: HT ${devis.amountHt ?? "?"} € | TTC ${devis.amountTtc ?? "?"} €`,
  );
  parts.push("");
  parts.push("LINE ITEMS (amounts verbatim from the quotation; do not recompute):");
  for (const li of lines) {
    const t = byLineNumber.get(li.lineNumber);
    const seg = [
      `#${li.lineNumber}`,
      `FR: ${li.description}`,
      t?.translation ? `EN: ${t.translation}` : null,
      li.quantity ? `qty ${li.quantity}${li.unit ? ` ${li.unit}` : ""}` : null,
      li.unitPriceHt ? `unit HT ${li.unitPriceHt} €` : null,
      `total HT ${li.totalHt} €`,
    ].filter(Boolean);
    parts.push(seg.join(" | "));
  }
  return parts.join("\n");
}

export type CostAnalysisMutationResult =
  | { outcome: "saved"; analysis: DevisCostAnalysis; warnings: string[] }
  | { outcome: "stale" }
  | { outcome: "finalised" }
  | { outcome: "not_found" };

async function assertNotFinalised(devisId: number): Promise<boolean> {
  const translation = await storage.getDevisTranslation(devisId);
  return translation?.status !== "finalised";
}

/**
 * Generates (or regenerates) the draft analysis via Gemini. Regeneration
 * replaces the existing DRAFT content; a confirmed analysis is demoted to
 * draft (it must be re-reviewed) — the caller's UI warns before this.
 */
export async function generateCostAnalysisDraft(
  devisId: number,
  actorEmail: string | null,
): Promise<CostAnalysisMutationResult> {
  const devis = await storage.getDevis(devisId);
  if (!devis) return { outcome: "not_found" };
  if (!(await assertNotFinalised(devisId))) return { outcome: "finalised" };

  const payload = await buildQuotationPayload(devisId);
  const { text, modelId } = await generateWithGemini({
    systemPrompt: COST_ANALYSIS_SYSTEM_PROMPT,
    userContent: `Analyse the following contractor quotation and produce the standard response.\n\n${payload}`,
  });

  const { document, warnings } = parseCostAnalysisMarkdown(text);
  const existing = await storage.getDevisCostAnalysis(devisId);
  const result = await storage.upsertDevisCostAnalysisIfRevision({
    devisId,
    rawText: text,
    document,
    warnings,
    status: "draft",
    expectedRevision: existing?.revision ?? null,
    modelId,
    promptVersion: COST_ANALYSIS_PROMPT_VERSION,
    generatedAt: new Date(),
    updatedByEmail: actorEmail,
  });
  if (result.outcome !== "saved") return result;
  return { outcome: "saved", analysis: result.analysis, warnings };
}

/** Saves an architect edit of the raw text; always lands as a DRAFT. */
export async function saveCostAnalysisText(
  devisId: number,
  rawText: string,
  expectedRevision: number,
  actorEmail: string | null,
): Promise<CostAnalysisMutationResult> {
  if (!(await assertNotFinalised(devisId))) return { outcome: "finalised" };
  const { document, warnings } = parseCostAnalysisMarkdown(rawText);
  const result = await storage.upsertDevisCostAnalysisIfRevision({
    devisId,
    rawText,
    document,
    warnings,
    status: "draft",
    expectedRevision,
    updatedByEmail: actorEmail,
  });
  if (result.outcome !== "saved") return result;
  return { outcome: "saved", analysis: result.analysis, warnings };
}

/** Confirms the draft — re-parses server-side so the stored AST is trusted. */
export async function confirmCostAnalysis(
  devisId: number,
  expectedRevision: number,
  actorEmail: string | null,
): Promise<CostAnalysisMutationResult> {
  if (!(await assertNotFinalised(devisId))) return { outcome: "finalised" };
  const existing = await storage.getDevisCostAnalysis(devisId);
  if (!existing) return { outcome: "not_found" };
  const { document, warnings } = parseCostAnalysisMarkdown(existing.rawText);
  const result = await storage.upsertDevisCostAnalysisIfRevision({
    devisId,
    rawText: existing.rawText,
    document,
    warnings,
    status: "confirmed",
    expectedRevision,
    updatedByEmail: actorEmail,
  });
  if (result.outcome !== "saved") return result;
  return { outcome: "saved", analysis: result.analysis, warnings };
}

export async function removeCostAnalysis(
  devisId: number,
  expectedRevision: number,
): Promise<{ outcome: "deleted" | "stale" | "finalised" | "not_found" }> {
  if (!(await assertNotFinalised(devisId))) return { outcome: "finalised" };
  return storage.deleteDevisCostAnalysisIfRevision(devisId, expectedRevision);
}

/** Loads the confirmed analysis document for PDF rendering (or null). */
export async function getConfirmedCostAnalysisDocument(
  devisId: number,
): Promise<CostAnalysisDocument | null> {
  const row = await storage.getDevisCostAnalysis(devisId);
  if (!row || row.status !== "confirmed") return null;
  const parsed = await import("@shared/cost-analysis-doc").then((m) =>
    m.costAnalysisDocumentSchema.safeParse(row.document),
  );
  if (!parsed.success) {
    console.warn(
      `[CostAnalysis] Stored document for devis ${devisId} failed validation — skipping in PDF:`,
      parsed.error.issues[0]?.message,
    );
    return null;
  }
  return parsed.data;
}
