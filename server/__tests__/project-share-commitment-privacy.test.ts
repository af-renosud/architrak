import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../storage", () => ({ storage: {
  getProject: vi.fn(), listProjectShareDevisIds: vi.fn(), getLotsByProject: vi.fn(), getDevisByProject: vi.fn(),
  getDevis: vi.fn(), getDevisTranslation: vi.fn(), getDevisCostAnalysis: vi.fn(), listClientChecks: vi.fn(),
}}));
vi.mock("../services/financial-summary.service", () => ({ getProjectFinancialSummary: vi.fn() }));
vi.mock("../services/client-budget", () => ({
  getPublicClientBudget: vi.fn(async () => ({ entries: [], unsignedHt: 0, unsignedTtc: 0 })),
}));
import { storage } from "../storage";
import { getProjectFinancialSummary } from "../services/financial-summary.service";
import { buildProjectSharePayload } from "../routes/public-client-project-share";
const mock = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  vi.clearAllMocks();
  mock.getProject.mockResolvedValue({id:1,name:"Project"});
  mock.listProjectShareDevisIds.mockResolvedValue([1]);
  mock.getLotsByProject.mockResolvedValue([]);
  mock.getDevisByProject.mockResolvedValue([]);
  vi.mocked(getProjectFinancialSummary).mockResolvedValue({ success:false,status:404 } as any);
  mock.getDevis.mockImplementation(async (id:number) => ({
    id,projectId:1,devisCode:id===1?"PUBLISHED":"PRIVATE",status:"draft",accountingState:"active",
    signOffStage:id===1?"client_signed_off":"received", amountHt:id===1?"100":"98765",
  }));
  mock.getDevisTranslation.mockResolvedValue(null);
  mock.getDevisCostAnalysis.mockResolvedValue(null);
  mock.listClientChecks.mockResolvedValue([]);
});
it("includes active signed work without explicit sharing, once, without exposing later edits", async () => {
  const signed = { id:3, projectId:1, devisCode:"SIGNED", status:"draft", accountingState:"active",
    signOffStage:"client_signed_off", amountHt:"100", amountTtc:"120",
    descriptionUk:"UNREVIEWED EDIT", descriptionFr:"INTERNAL", signedOffVia:null,
    signedPdfStorageKey:"private-signed", archisignEnvelopeId:"env", signedPdfArchisignEnvelopeId:"env" };
  mock.getDevisByProject.mockResolvedValue([signed]);
  mock.listProjectShareDevisIds.mockResolvedValue([3]);
  mock.getDevis.mockResolvedValue(signed);
  const payload = await buildProjectSharePayload({id:1,projectId:1,clientName:null,clientEmail:"client@example.test"});
  expect(payload.quotations).toHaveLength(1);
  expect(payload.quotations[0]).toMatchObject({id:3,signedRecordOnly:true,signedDocumentAvailable:true,translationAvailable:false});
  expect(JSON.stringify(payload)).not.toMatch(/UNREVIEWED EDIT|INTERNAL|private-signed/);
  expect(mock.getDevisTranslation).not.toHaveBeenCalled();
  mock.listProjectShareDevisIds.mockResolvedValue([]);
  expect((await buildProjectSharePayload({id:1,projectId:1,clientName:null,clientEmail:"client@example.test"})).quotations).toHaveLength(1);
});
it("retains signed cards without an available signed document, but excludes replaced or void work", async () => {
  const base = {id:3,projectId:1,devisCode:"SIGNED",status:"draft",accountingState:"active",signOffStage:"client_signed_off"};
  const rows = [base,{...base,id:4,accountingState:"superseded"},{...base,id:5,signOffStage:"void"}];
  mock.getDevisByProject.mockResolvedValue(rows);
  mock.listProjectShareDevisIds.mockResolvedValue([3,4,5]);
  mock.getDevis.mockImplementation(async id=>rows.find(d=>d.id===id));
  const payload = await buildProjectSharePayload({id:1,projectId:1,clientName:null,clientEmail:"client@example.test"});
  expect(payload.quotations.map(q=>q.id)).toEqual([3]);
  expect(payload.quotations[0].signedDocumentAvailable).toBe(false);
});
it("does not disclose pending prices or evidence of an unpublished draft through project totals", async () => {
  vi.mocked(getProjectFinancialSummary).mockResolvedValue({ success:true,status:200,data:{
    projectName:"Project",projectCode:"P",devis:[],totalContractedHt:100,totalContractedTtc:120,
    totalCertifiedHt:0,totalCertifiedTtc:0,totalResteARealiser:100,totalResteARealiserTtc:120,
    totalPendingHt:98765,totalPendingTtc:118518,totalExcludedCertifiedHt:12345,totalExcludedCertifiedTtc:14814,
    financialExceptions:[{devisCode:"PRIVATE",certifiedHt:12345}],
    externalWorks:[{id:7,reference:"PRIVATE-HISTORY",description:"Historical",amountHt:"6543.21",amountTtc:"7851.85"}],
    totalExternalHt:6543.21,totalExternalTtc:7851.85,totalCombinedCostHt:6643.21,totalCombinedCostTtc:7971.85,
  }} as any);
  const payload = await buildProjectSharePayload({id:1,projectId:1,clientName:null,clientEmail:"client@example.test"});
  expect(payload.quotations.map(q=>q.id)).toEqual([1]);
  expect(payload.financials?.totalContractedHt).toBe(100);
  expect(payload.financials).not.toHaveProperty("totalPendingHt");
  expect(payload.financials).not.toHaveProperty("totalCombinedCostHt");
  expect(payload.financials).not.toHaveProperty("externalWorks");
  expect(payload.financials).not.toHaveProperty("totalExcludedCertifiedHt");
  expect(JSON.stringify(payload)).not.toMatch(/98765|118518|12345|14814|PRIVATE|6543|7851|6643|7971/);
  expect(mock.getDevis).not.toHaveBeenCalledWith(2);
});
