import { storage } from "../storage";
import { isContextDocEmpty } from "@shared/context-doc";
import { LineContextError, saveLineContext } from "./devis-line-context";
import { ContextResearchError, researchQuotationContext } from "./quotation-context-research";

export interface ContextGenerationStatus {
  running: boolean; completed: number; skipped: number; failed: number; error: string | null;
}
const jobs = new Map<number, ContextGenerationStatus>();
const activeLines = new Set<string>();
const idle = (): ContextGenerationStatus => ({ running: false, completed: 0, skipped: 0, failed: 0, error: null });

export async function requireContextGenerationAllowed(devisId: number) {
  const quotation = await storage.getDevis(devisId);
  if (!quotation) throw new LineContextError("Quotation not found.", 404);
  const project = await storage.getProject(quotation.projectId);
  if (!project || project.archivedAt || ["void", "superseded"].includes(quotation.status)) {
    throw new LineContextError("Archived, void or replaced quotations cannot receive new context.", 409);
  }
  const translation = await storage.getDevisTranslation(devisId);
  if (!translation || !["draft", "edited"].includes(translation.status)) {
    throw new LineContextError("Prepare the English translation, or reopen it for review, before generating context.", 409);
  }
  return translation;
}

export async function generateEmptyLineContext(devisId: number, lineItemId: number) {
  const key = `${devisId}:${lineItemId}`;
  if (activeLines.has(key)) throw new LineContextError("An explanation is already being generated for this item.", 409);
  if (activeLines.size >= 3) throw new LineContextError("Context research is busy. Please retry shortly.", 409);
  activeLines.add(key);
  try {
    const translation = await requireContextGenerationAllowed(devisId);
    const lines = await storage.getDevisLineItems(devisId);
    const line = lines.find(l => l.id === lineItemId);
    if (!line) throw new LineContextError("Quotation item not found.", 404);
    const before = (await storage.getDevisLineContexts(devisId)).find(c => c.devisLineItemId === lineItemId);
    if (before && !isContextDocEmpty(before.document as any)) throw new LineContextError("Existing context is protected. Only empty fields can be filled.", 409);
    if ((await storage.getDevisLineContextAssets(lineItemId)).length) throw new LineContextError("This item has uploaded images. Its context has been left unchanged.", 409);
    const english = (translation.lineTranslations as any[] | null)?.find(l => l.lineNumber === line.lineNumber)?.translation ?? "";
    const result = await researchQuotationContext(line.description, english);
    await requireContextGenerationAllowed(devisId);
    const latest = (await storage.getDevisLineItems(devisId)).find(l => l.id === lineItemId);
    if (!latest || latest.description !== line.description) throw new LineContextError("Item wording changed during research. Retry against the latest wording.", 409);
    const context = await saveLineContext({
      devisId, devisLineItemId: lineItemId, baseRevision: before?.revision ?? 0, document: result.document,
      generatedFromDescription: line.description,
    });
    return { context, sources: result.sources, warning: result.warning };
  } finally {
    activeLines.delete(key);
  }
}

export function contextGenerationStatus(devisId: number): ContextGenerationStatus {
  return { ...(jobs.get(devisId) ?? idle()) };
}

/** Best-effort enrichment: translation succeeds independently; failed empty fields can be retried. */
export async function startContextGeneration(devisId: number): Promise<ContextGenerationStatus> {
  await requireContextGenerationAllowed(devisId);
  const existing = jobs.get(devisId);
  if (existing?.running) return { ...existing };
  if (Array.from(jobs.values()).filter(j => j.running).length >= 2) {
    throw new LineContextError("Context research is busy. Please retry shortly.", 409);
  }
  const state = { ...idle(), running: true };
  jobs.set(devisId, state);
  void (async () => {
    try {
      const lines = await storage.getDevisLineItems(devisId);
      for (const line of lines) {
        await requireContextGenerationAllowed(devisId);
        const context = (await storage.getDevisLineContexts(devisId)).find(c => c.devisLineItemId === line.id);
        if (!line.description.trim() || (context && !isContextDocEmpty(context.document as any))) {
          state.skipped++; continue;
        }
        try {
          await generateEmptyLineContext(devisId, line.id);
          state.completed++;
        } catch (error) {
          state.failed++;
          state.error = error instanceof LineContextError || error instanceof ContextResearchError ? error.message : "Some explanations could not be generated. Retry the remaining empty fields.";
          // An account-level refusal cannot be resolved by charging through
          // the remaining quotation items.
          if (error instanceof ContextResearchError && /402|configured/.test(error.message)) break;
        }
      }
    } catch {
      state.error = "Research stopped. Reopen this quotation for review before retrying empty fields.";
    } finally {
      state.running = false;
      const timer = setTimeout(() => { if (jobs.get(devisId) === state) jobs.delete(devisId); }, 60 * 60 * 1000);
      timer.unref();
    }
  })();
  return { ...state };
}
