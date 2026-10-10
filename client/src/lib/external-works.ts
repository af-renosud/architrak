export interface ExternalWork {
  id: number;
  projectId: number;
  reference: string;
  description: string;
  amountHt: string;
  amountTtc: string;
  companyName: string | null;
  lot: string | null;
  completionDate: string | null;
  status: "active" | "void";
  version: number;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalWorkAudit {
  id: number;
  entryId: number;
  action: string;
  actorName: string | null;
  createdAt: string;
  before: Partial<ExternalWork> | null;
  after: Partial<ExternalWork> | null;
  reason: string | null;
}

export interface ExternalWorksResponse {
  entries: ExternalWork[];
  history: ExternalWorkAudit[];
}

export interface ExternalWorkForm {
  reference: string;
  description: string;
  amountHt: string;
  amountTtc: string;
  companyName: string;
  lot: string;
  completionDate: string;
  confirmedCompleted: boolean;
}

export function externalWorkForm(entry?: ExternalWork): ExternalWorkForm {
  return {
    reference: entry?.reference ?? "",
    description: entry?.description ?? "",
    amountHt: entry?.amountHt ?? "",
    amountTtc: entry?.amountTtc ?? "",
    companyName: entry?.companyName ?? "",
    lot: entry?.lot ?? "",
    completionDate: entry?.completionDate ?? "",
    confirmedCompleted: false,
  };
}

export function validateExternalWork(form: ExternalWorkForm): string | null {
  if (!form.reference.trim() || !form.description.trim()) return "Reference and description are required.";
  const money = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
  if (!money.test(form.amountHt) || !money.test(form.amountTtc)) {
    return "Enter both HT and TTC explicitly: 0 to 9999999999.99, with at most two decimal places.";
  }
  if (Number(form.amountTtc) < Number(form.amountHt)) return "TTC must be greater than or equal to HT.";
  if (form.completionDate) {
    const date = new Date(`${form.completionDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.completionDate) ||
      Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== form.completionDate) {
      return "Enter a valid completion date (yyyy-mm-dd).";
    }
  }
  if (!form.confirmedCompleted) return "Confirm that these are agreed, completed works outside ArchiTrak.";
  return null;
}
