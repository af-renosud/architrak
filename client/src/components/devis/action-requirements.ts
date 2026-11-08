import { focusActionTarget, type ActionRequirement } from "@/components/ui/blocked-action";
import type { WorkflowGroup } from "./devis-workflow-model";

export type QuotationTarget = "lot" | "description" | "stage" | "checks" | "translation" | "source" | "insurance" | "contact" | "signature" | "deposit";
export type ContractorQuestionAuthorization = { reason: string; snapshot: string };

/** Only the contractor-question blocker can be waived; unknown blockers fail closed. */
export function signatureSendRequirements(requirements: ActionRequirement[], authorized: boolean): ActionRequirement[] {
  return authorized ? requirements.filter(requirement => requirement.id !== "checks") : requirements;
}
export function goToQuotationTarget(devisId: number, target: QuotationTarget, projectId?: number | string) {
  if (target === "contact") {
    window.dispatchEvent(new CustomEvent("architrak:edit-project-contact", { detail: { projectId } }));
    return;
  }
  if (target === "deposit") {
    // AcompteBadge is in the quotation header, outside the workflow root.
    // Focus the exact existing control; never click it or open another section.
    const root = document.querySelector(`[data-testid="card-devis-${devisId}"]`) ?? document;
    focusActionTarget(`[data-testid="button-acompte-generate-cert-${devisId}"]`, root);
    return;
  }
  const targets: Record<Exclude<QuotationTarget, "contact" | "deposit">, { group: WorkflowGroup; testId: string; tab?: string }> = {
    lot: { group: "review", testId: `select-lot-${devisId}` },
    description: { group: "review", testId: `input-description-uk-${devisId}` },
    stage: { group: "review", testId: `stepper-signoff-${devisId}` },
    checks: { group: "send", testId: `section-checks-${devisId}` },
    translation: { group: "prepare", tab: "translation", testId: `section-translation-${devisId}` },
    source: { group: "review", testId: `quotation-extraction-review-${devisId}` },
    insurance: { group: "send", testId: `section-insurance-panel-${devisId}` },
    signature: { group: "send", testId: `panel-signing-${devisId}` },
  };
  const destination = targets[target];
  window.dispatchEvent(new CustomEvent("architrak:workflow-target", {
    detail: { devisId, ...destination, selector: target === "lot" ? `[data-testid="select-lot-${devisId}"], [data-testid="input-new-lot-number-${devisId}"]` : `[data-testid="${destination.testId}"]` },
  }));
}

export function quotationRequirement(id: QuotationTarget, message: string, devisId: number, projectId?: number | string): ActionRequirement {
  return { id, message, linkLabel: id === "contact" ? "Go to project contact" : `Go to ${id === "description" ? "English description" : id}`, onResolve: () => goToQuotationTarget(devisId, id, projectId) };
}

/** Kept separate from send readiness: approval does not require a translated PDF or cleared questions. */
export function stageRequirements(devis: { id: number; lotId?: number | null; lotRefText?: string | null; descriptionUk?: string | null }): ActionRequirement[] {
  return [
    ...(devis.lotId != null || devis.lotRefText?.trim() ? [] : [quotationRequirement("lot", "Assign a lot or save a lot reference.", devis.id)]),
    ...(devis.descriptionUk?.trim() ? [] : [quotationRequirement("description", "Save an English works description.", devis.id)]),
  ];
}

/** Compatibility boundary for the server's string-only readiness contract.
 * Targets are typed everywhere else; unknown future blockers remain visible, with no guessed link. */
export function readinessRequirements(blockers: string[], devisId: number, projectId?: number | string): ActionRequirement[] {
  return blockers.map((message, index) => {
    let target: QuotationTarget | undefined;
    if (message.startsWith("Stage is ")) target = "stage";
    else if (/^\d+ contractor check/.test(message)) target = "checks";
    else if (message.startsWith("Translated PDF ") || message.startsWith("Translation not ")) target = "translation";
    else if (message === "Lot reference missing") target = "lot";
    else if (message === "English description missing") target = "description";
    else if (message === "Client contact name/email missing on the project") target = "contact";
    else if (message.startsWith("Insurance:")) target = "insurance";
    else if (message === "Source specification coverage is unverified") target = "source";
    else if (message.startsWith("Already signed")) target = "signature";
    return target ? quotationRequirement(target, message, devisId, projectId) : { id: `server-${index}`, message };
  });
}

export async function fetchOpenQuotationChecks(devisId: number): Promise<number> {
  const response = await fetch(`/api/devis/${devisId}/checks`, { credentials: "include" });
  if (!response.ok) throw new Error("Contractor checks unavailable. Retry before sending.");
  const list: unknown = await response.json();
  if (!Array.isArray(list) || list.some(row => !row || typeof row.status !== "string")) throw new Error("Contractor check response unavailable. Retry before sending.");
  return list.filter(row => ["open", "awaiting_contractor", "awaiting_architect"].includes(row.status)).length;
}
