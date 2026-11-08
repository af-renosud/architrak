/** Server-derived guidance only. Never an authorization to mutate a record. */
export type QuotationActionTarget = "lot" | "description" | "stage" | "checks" | "translation" | "source" | "insurance" | "contact" | "signature" | "deposit";
export interface QuotationNextAction {
  id: string;
  code: string;
  label: string;
  why: string;
  nextStep: string;
  actor: "architect" | "client" | "contractor" | "system";
  tone: "action" | "blocked" | "waiting" | "unknown";
  priority: number;
  devisId: number;
  certificateId?: number;
  certificateRef?: string;
  outstandingTtc?: string;
  href: string;
  target?: QuotationActionTarget;
}
export interface QuotationNextActions {
  devisId: number;
  actions: QuotationNextAction[];
  actionable: boolean;
}
export interface ProjectNextActions {
  projectId: number;
  generatedAt: string;
  quotations: Record<number, QuotationNextActions>;
  actionableCount: number;
}
export interface NextActionExplanation {
  actionId: string;
  source: "ai" | "fallback";
  explanation: string;
}
