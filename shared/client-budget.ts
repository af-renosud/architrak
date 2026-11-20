export interface ClientBudgetEntry {
  devisId: number;
  title: string;
  reference: string;
  contractor: string;
  amountHt: string;
  amountTtc: string;
}
export interface ClientBudgetCandidate {
  devisId: number;
  current: ClientBudgetEntry | null;
  shared: ClientBudgetEntry | null;
  changed: boolean;
  signed: boolean;
  excluded: boolean;
  blockedReason: string | null;
}
export interface ClientBudgetState {
  version: string;
  candidates: ClientBudgetCandidate[];
  signedHt: number;
  signedTtc: number;
  readOnly: boolean;
}
export interface ClientBudgetSave {
  version: string;
  entries: { devisId: number; title: string; refresh: boolean }[];
  alternativesReviewed: true;
}
export interface PublicClientBudget {
  entries: (ClientBudgetEntry & { status: "signed" | "under_consideration" })[];
  unsignedHt: number;
  unsignedTtc: number;
}
