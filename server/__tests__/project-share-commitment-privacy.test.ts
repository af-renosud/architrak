import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../storage", () => ({ storage: {
  getProject: vi.fn(), listProjectShareDevisIds: vi.fn(), getLotsByProject: vi.fn(),
  getDevis: vi.fn(), getDevisTranslation: vi.fn(), getDevisCostAnalysis: vi.fn(), listClientChecks: vi.fn(),
}}));
vi.mock("../services/financial-summary.service", () => ({ getProjectFinancialSummary: vi.fn() }));
import { storage } from "../storage";
import { getProjectFinancialSummary } from "../services/financial-summary.service";
import { buildProjectSharePayload } from "../routes/public-client-project-share";
const mock = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  vi.clearAllMocks();
  mock.getProject.mockResolvedValue({id:1,name:"Project"});
  mock.listProjectShareDevisIds.mockResolvedValue([1]);
  mock.getLotsByProject.mockResolvedValue([]);
  mock.getDevis.mockImplementation(async (id:number) => ({
    id,projectId:1,devisCode:id===1?"PUBLISHED":"PRIVATE",status:"draft",accountingState:"active",
    signOffStage:id===1?"client_signed_off":"received", amountHt:id===1?"100":"98765",
  }));
  mock.getDevisTranslation.mockResolvedValue(null);
  mock.getDevisCostAnalysis.mockResolvedValue(null);
  mock.listClientChecks.mockResolvedValue([]);
});
it("does not disclose pending prices or evidence of an unpublished draft through project totals", async () => {
  vi.mocked(getProjectFinancialSummary).mockResolvedValue({ success:true,status:200,data:{
    projectName:"Project",projectCode:"P",devis:[],totalContractedHt:100,totalContractedTtc:120,
    totalCertifiedHt:0,totalCertifiedTtc:0,totalResteARealiser:100,totalResteARealiserTtc:120,
    totalPendingHt:98765,totalPendingTtc:118518,totalExcludedCertifiedHt:12345,totalExcludedCertifiedTtc:14814,
    financialExceptions:[{devisCode:"PRIVATE",certifiedHt:12345}],
  }} as any);
  const payload = await buildProjectSharePayload({id:1,projectId:1,clientName:null,clientEmail:"client@example.test"});
  expect(payload.quotations.map(q=>q.id)).toEqual([1]);
  expect(payload.financials?.totalContractedHt).toBe(100);
  expect(payload.financials).not.toHaveProperty("totalPendingHt");
  expect(payload.financials).not.toHaveProperty("totalExcludedCertifiedHt");
  expect(JSON.stringify(payload)).not.toMatch(/98765|118518|12345|14814|PRIVATE/);
  expect(mock.getDevis).not.toHaveBeenCalledWith(2);
});
