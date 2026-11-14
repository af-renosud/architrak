// Explicitly illustrative sample data. Not production records.
// Shared by every dashboard section so project IDs, totals and statuses agree.
export const sampleLabel = "Illustrative sample data · sandbox only · actions do not contact services";
export const sampleNow = new Date().toISOString();
const projectSummaries = [
  { id: 1, name: "Maison des Tilleuls", code: "TIL-024", clientName: "Camille Martin", status: "active", devisCount: 8, devisApprovedCount: 6, devisUnapprovedCount: 2, allDevisSigned: false, invoiceCount: 5, invoiceApprovedCount: 4, invoiceUnapprovedCount: 1, agentStatus: "attention", agentIssueCount: 2 },
  { id: 2, name: "Appartement Voltaire", code: "VOL-025", clientName: "Alex Laurent", status: "active", devisCount: 5, devisApprovedCount: 5, devisUnapprovedCount: 0, allDevisSigned: true, invoiceCount: 3, invoiceApprovedCount: 3, invoiceUnapprovedCount: 0, agentStatus: "ok", agentIssueCount: 0 },
  { id: 3, name: "Atelier des Arts", code: "ART-023", clientName: "Atelier des Arts", status: "completed", devisCount: 4, devisApprovedCount: 4, devisUnapprovedCount: 0, allDevisSigned: true, invoiceCount: 4, invoiceApprovedCount: 4, invoiceUnapprovedCount: 0, agentStatus: "ok", agentIssueCount: 0 },
];
export const dashboardSample = {
  gmailLastCheck: sampleNow, gmailPolling: true, gmailConfigured: true, gmailLastPollStatus: "success", gmailLastPollError: null,
  overview: { activeProjects: 2, totalProjects: 3 }, projectSummaries,
  recentActivity: [
    { type: "invoice", label: "Facture F-2026-042 received — Maison des Tilleuls", date: "12/06/2026", amount: "14400", projectId: 1, contractor: "Menuiserie du Parc" },
    { type: "certificat", label: "Certificat CP-VOL-003 approved", date: "11/06/2026", amount: "9600", projectId: 2, contractor: "Électricité Lumière" },
    { type: "invoice", label: "Facture F-2026-039 approved — Appartement Voltaire", date: "10/06/2026", amount: "9600", projectId: 2, contractor: "Électricité Lumière" },
    { type: "certificat", label: "Certificat CP-TIL-002 ready", date: "09/06/2026", amount: "14400", projectId: 1, contractor: "Menuiserie du Parc" },
    { type: "invoice", label: "Facture F-2026-031 approved — Maison des Tilleuls", date: "05/06/2026", amount: "24000", projectId: 1, contractor: "Maçonnerie Durand" },
  ],
  urgentItems: [
    { type: "overdue_invoice", label: "Overdue invoice F-2026-031 — Maison des Tilleuls", projectId: 1, id: 31, amount: "24000" },
    { type: "cert_draft", label: "Draft certificat CP-TIL-004 — Maison des Tilleuls", projectId: 1, id: 4, amount: "7200" },
    { type: "cert_review", label: "Certificat CP-VOL-004 awaiting review", projectId: 2, id: 4, amount: "4800" },
    { type: "anomaly", label: "2 devis queries need attention — Maison des Tilleuls", projectId: 1, id: 4, amount: "0" },
  ],
};
export interface FeeEntry {
  entryId: number; projectId: number; projectName: string; projectCode: string;
  contractorName: string; invoiceNumber: string; devisCode: string; amountHt: number;
  amountTtc: number; feePercentage: number; feeAmountHt: number; ageDays: number;
}
export const feeEntries: FeeEntry[] = [
  { entryId: 1, projectId: 1, projectName: "Maison des Tilleuls", projectCode: "TIL-024", contractorName: "Maçonnerie Durand", invoiceNumber: "F-2026-031", devisCode: "D-TIL-001", amountHt: 20000, amountTtc: 24000, feePercentage: 10, feeAmountHt: 2000, ageDays: 96 },
  { entryId: 2, projectId: 1, projectName: "Maison des Tilleuls", projectCode: "TIL-024", contractorName: "Menuiserie du Parc", invoiceNumber: "F-2026-042", devisCode: "D-TIL-006", amountHt: 12000, amountTtc: 14400, feePercentage: 10, feeAmountHt: 1200, ageDays: 72 },
  { entryId: 3, projectId: 2, projectName: "Appartement Voltaire", projectCode: "VOL-025", contractorName: "Électricité Lumière", invoiceNumber: "F-2026-039", devisCode: "D-VOL-003", amountHt: 8000, amountTtc: 9600, feePercentage: 10, feeAmountHt: 800, ageDays: 18 },
];
export const outstandingSample = {
  totalCount: 3, totalFeeHt: 4000,
  buckets: [{ label: "0-30", count: 1, totalFeeHt: 800 }, { label: "31-60", count: 0, totalFeeHt: 0 }, { label: "61-90", count: 1, totalFeeHt: 1200 }, { label: "90+", count: 1, totalFeeHt: 2000 }],
  byProject: [{ projectId: 1, projectCode: "TIL-024", projectName: "Maison des Tilleuls", count: 2, totalFeeHt: 3200, oldestAgeDays: 96 }, { projectId: 2, projectCode: "VOL-025", projectName: "Appartement Voltaire", count: 1, totalFeeHt: 800, oldestAgeDays: 18 }],
  entries: feeEntries,
};
export const unsentSample = [
  { certificatId: 2, certificateRef: "CP-TIL-002", certificateStatus: "ready", netToPayTtc: "14400", isSolde: false, projectId: 1, projectName: "Maison des Tilleuls", contractorId: 2, contractorName: "Menuiserie du Parc" },
  { certificatId: 3, certificateRef: "CP-VOL-003", certificateStatus: "sent", netToPayTtc: "9600", isSolde: true, projectId: 2, projectName: "Appartement Voltaire", contractorId: 3, contractorName: "Électricité Lumière" },
];
export const designActionsSample = [
  { milestoneId: 1, contractId: 1, projectId: 1, projectName: "Maison des Tilleuls", projectCode: "TIL-024", labelFr: "Validation de l’avant-projet définitif", amountTtc: "3600", reachedAt: "2026-06-10", triggerEvent: "milestone_reached" },
];
export const stuckMessagesSample = [{ userId: 1, messageId: "illustrative-message-001", failCount: 6, lastFailedAt: sampleNow }];
export function burnupSample(projectId: number) {
  const value = projectId === 1 ? 240000 : projectId === 2 ? 120000 : 80000;
  return {
    contractValueHistory: [{ date: "2026-01-01", value: value * 0.8 }, { date: "2026-03-01", value }],
    certifiedHistory: [{ date: "2026-01-01", value: 0 }, { date: "2026-02-01", value: value * 0.12 }, { date: "2026-03-01", value: value * 0.24 }, { date: "2026-04-01", value: value * 0.36 }, { date: "2026-05-01", value: value * 0.48 }, { date: "2026-06-01", value: value * 0.6 }],
    currentContractValue: value, currentCertifiedTotal: value * 0.6, percentComplete: 60,
  };
}
