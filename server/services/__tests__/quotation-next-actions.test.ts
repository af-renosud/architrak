import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../storage", () => ({ storage: {
  getProject: vi.fn(), getDevisByProject: vi.fn(), getCertificatsByProject: vi.fn(), getCertificatPaymentsByProject: vi.fn(),
} }));
vi.mock("../devis-readiness", () => ({ getProjectDevisReadiness: vi.fn() }));
const { queryRows, select } = vi.hoisted(() => ({ queryRows: [] as unknown[][], select: vi.fn() }));
vi.mock("../../db", () => ({ db: { select } }));
import { storage } from "../../storage";
import { getProjectDevisReadiness } from "../devis-readiness";
import { getProjectQuotationNextActions } from "../quotation-next-actions";
const d = { id: 1, projectId: 9, contractorId: 2, signOffStage: "client_signed_off",
  status: "pending", acompteRequired: true, acompteState: "pending", acompteInvoiceId: null };
const c = { id: 10, projectId: 9, contractorId: 2, acompteDevisId: 1, certificateRef: "C1",
  status: "ready", netToPayTtc: "120.00" };
beforeEach(() => {
  vi.clearAllMocks();
  queryRows.splice(0, queryRows.length, [], [], []);
  select.mockImplementation(() => {
    const rows = queryRows.shift() ?? [];
    const chain: any = { from: () => chain, innerJoin: () => chain, leftJoin: () => chain,
      where: vi.fn().mockResolvedValue(rows) };
    return chain;
  });
  vi.mocked(storage.getProject).mockResolvedValue({ id: 9, archivedAt: null } as any);
  vi.mocked(storage.getDevisByProject).mockResolvedValue([d] as any);
  vi.mocked(storage.getCertificatsByProject).mockResolvedValue([c] as any);
  vi.mocked(storage.getCertificatPaymentsByProject).mockResolvedValue([]);
  vi.mocked(getProjectDevisReadiness).mockResolvedValue({});
});
describe("batched next action data", () => {
  it("binds exact deposit certificates and loads payment/delivery evidence in batches", async () => {
    queryRows[2] = [{ certificateId: 10, status: "sent", sentAt: new Date(), recipientEmail: "client@example.test" }];
    vi.mocked(storage.getCertificatPaymentsByProject).mockResolvedValue([{ certificatId: 10, amount: "20.00" }] as any);
    const result = await getProjectQuotationNextActions(9);
    expect(result?.quotations[1].actions[0]).toMatchObject({ code: "await_payment", outstandingTtc: "100.00" });
    expect(storage.getCertificatPaymentsByProject).toHaveBeenCalledExactlyOnceWith(9);
    expect(select).toHaveBeenCalledTimes(3);
  });
  it("maps invoice sources precisely instead of guessing by contractor", async () => {
    vi.mocked(storage.getDevisByProject).mockResolvedValue([{ ...d, acompteState: "invoiced", acompteInvoiceId: 20 }, { ...d, id: 2, acompteRequired: false }] as any);
    vi.mocked(storage.getCertificatsByProject).mockResolvedValue([{ ...c, acompteDevisId: null }] as any);
    queryRows[1] = [{ certificateId: 10, invoiceId: 20, invoiceDevisId: 1, situationDevisId: null }];
    const result = await getProjectQuotationNextActions(9);
    expect(result?.quotations[1].actions[0].label).toBe("Send deposit certificate");
    expect(result?.quotations[2].actions).toEqual([]);
    expect(result?.actionableCount).toBe(1);
  });
  it("does not bind a mismatching contractor's certificate", async () => {
    vi.mocked(storage.getCertificatsByProject).mockResolvedValue([{ ...c, contractorId: 3 }] as any);
    expect((await getProjectQuotationNextActions(9))?.quotations[1].actions[0].certificateId).toBeUndefined();
  });
  it("uses unreviewed replies without exposing email text or addresses", async () => {
    queryRows[0] = [{ certificatId: 10 }];
    const result = await getProjectQuotationNextActions(9);
    expect(result?.quotations[1].actions[0].code).toBe("verify_payment");
    expect(JSON.stringify(result)).not.toContain("recipientEmail");
  });
  it("returns no recommendations for an archived project and performs no child queries", async () => {
    vi.mocked(storage.getProject).mockResolvedValue({ id: 9, archivedAt: new Date() } as any);
    expect(await getProjectQuotationNextActions(9)).toMatchObject({ actionableCount: 0, quotations: {} });
    expect(select).not.toHaveBeenCalled();
    expect(storage.getDevisByProject).not.toHaveBeenCalled();
  });
  it("propagates unavailable evidence instead of returning an all-clear", async () => {
    vi.mocked(storage.getCertificatPaymentsByProject).mockRejectedValueOnce(new Error("unavailable"));
    await expect(getProjectQuotationNextActions(9)).rejects.toThrow("unavailable");
  });
  it("returns null for a missing project", async () => {
    vi.mocked(storage.getProject).mockResolvedValue(undefined);
    expect(await getProjectQuotationNextActions(999)).toBeNull();
  });
});
