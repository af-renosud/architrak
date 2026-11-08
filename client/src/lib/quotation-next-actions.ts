import type { ProjectNextActions, QuotationNextAction } from "@shared/quotation-next-actions";

export const NEXT_ACTION_MAX_AGE_MS = 65_000;

export function nextActionsFresh(data: ProjectNextActions | undefined, now = Date.now()): boolean {
  if (!data) return false;
  const age = now - Date.parse(data.generatedAt);
  return Number.isFinite(age) && age >= -5_000 && age < NEXT_ACTION_MAX_AGE_MS;
}

export interface NextActionQuotation {
  id: number;
  status: string;
  accountingState?: string | null;
  signOffStage?: string | null;
}

export function nextActionEligible(row: Omit<NextActionQuotation, "id">, archived: boolean): boolean {
  return !archived && !["void", "cancelled", "superseded"].includes(row.status) &&
    row.accountingState !== "superseded" && row.signOffStage !== "void";
}

/** Count quotations, not individual actions: several unknown facts still affect one row. */
export function nextActionCounts(rows: NextActionQuotation[], archived: boolean, data: ProjectNextActions | undefined) {
  let actionable = 0;
  let unknownEvidence = 0;
  for (const row of rows) {
    if (!nextActionEligible(row, archived)) continue;
    const entry = data?.quotations[row.id];
    if (entry?.actionable) actionable += 1;
    if (entry?.actions.some(action => action.tone === "unknown")) unknownEvidence += 1;
  }
  return { actionable, unknownEvidence };
}

export function matchesNextActionFilter(row: NextActionQuotation, archived: boolean, onlyActionable: boolean, data: ProjectNextActions | undefined, unknown: boolean): boolean {
  return !onlyActionable || (!unknown && nextActionEligible(row, archived) && data?.quotations[row.id]?.actionable === true);
}

/** Same id alone is not sufficient: facts or the navigation target may have changed. */
export function currentNextAction(data: ProjectNextActions, action: QuotationNextAction): QuotationNextAction {
  const current = data.quotations[action.devisId]?.actions.find(item => item.id === action.id);
  if (!nextActionsFresh(data) || !current || JSON.stringify(current) !== JSON.stringify(action)) {
    throw new Error("This guidance has changed. Review the refreshed flag before continuing.");
  }
  return current;
}

/** Observe dependencies, never the derived query itself (prevents invalidation loops).
 * Global/scoped detail caches are included: payment and insurance editors often
 * invalidate a certificate/contractor key without knowing the current project. */
export function isNextActionDependency(key: readonly unknown[], projectId: string): boolean {
  const parts = key.filter((part): part is string => typeof part === "string").flatMap(part => part.split("/")).filter(Boolean);
  if (parts.includes("quotation-next-actions")) return false;
  const projectIndex = parts.indexOf("projects");
  if (projectIndex >= 0 && parts[projectIndex + 1] && parts[projectIndex + 1] !== projectId) return false;
  return parts.some(part => /^(projects|devis|devis-checks|devis-readiness|certificats|certificat-payments|certificat-invoice-links|payments|payment-context|payment-suggestions|invoices|financial-summary|accounting-status|contractors|insurance|insurances|lots|signing|signature|translations|translation|communications|supporting-pdfs|marche-documents)$/.test(part));
}

export function nextActionHref(action: QuotationNextAction, projectId: string): string | undefined {
  if (action.certificateId != null) return `/certificats?projectId=${encodeURIComponent(projectId)}&certificatId=${action.certificateId}`;
  // Guidance must never introduce an external, script, or protocol-relative link.
  return /^\/(?!\/)/.test(action.href) && !/[\\\r\n]/.test(action.href) ? action.href : undefined;
}
