import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../storage", () => ({ storage: {
  getCertificat: vi.fn(), getContractor: vi.fn(), getCertificatSources: vi.fn(),
  getSituation: vi.fn(), getInvoice: vi.fn(), getDevis: vi.fn(), getLot: vi.fn(),
} }));
import { storage } from "../../storage";
import { getCertificateInvoiceDescription } from "../certificate-invoice-description.service";
import { buildCertificateInvoiceDescription } from "@shared/certificate-invoice-description";
const mocked = vi.mocked(storage);
beforeEach(() => {
  vi.resetAllMocks();
  mocked.getCertificat.mockResolvedValue({ id: 1, projectId: 2, contractorId: 3,
    certificateRef: "C4", netToPayHt: "950", totalWorksHt: "9000",
    acompteDevisId: null } as any);
  mocked.getContractor.mockResolvedValue({ name: "Company" } as any);
  mocked.getCertificatSources.mockResolvedValue([{ invoiceId: 4 }, { invoiceId: 4 }, { invoiceId: 5 }] as any);
  mocked.getInvoice.mockImplementation(async id => ({ id, projectId: 2, contractorId: 3, devisId: id, invoiceNumber: `F${id}` }) as any);
  mocked.getDevis.mockImplementation(async id => ({ id, projectId: 2, contractorId: 3, lotId: id, descriptionUk: `Work ${id}` }) as any);
  mocked.getLot.mockImplementation(async id => ({ projectId: 2, lotNumber: `L${id}` }) as any);
});
describe("certificate accounting description", () => {
  it("uses only linked deduplicated invoices and period net HT with associated lots", async () => {
    const result = await getCertificateInvoiceDescription(1);
    expect(result?.description).toContain("F4, F5");
    expect(result?.description).toContain("Lot L4 — Work 4; Lot L5 — Work 5");
    expect(result?.description).toContain("950,00");
    expect(result?.description).not.toContain("9\u202f000");
    expect(mocked.getInvoice).toHaveBeenCalledTimes(2);
  });
  it("uses exact requested opening wording only for explicit deposit identity", async () => {
    mocked.getCertificatSources.mockResolvedValue([]);
    const cert = await mocked.getCertificat(1);
    mocked.getCertificat.mockResolvedValue({ ...cert, acompteDevisId: 4 } as any);
    expect((await getCertificateInvoiceDescription(1))?.description).toContain("Opening Deposit - No accompanying contractor invoice.");
    mocked.getCertificat.mockResolvedValue(cert);
    const description = (await getCertificateInvoiceDescription(1))!.description;
    expect(description).not.toContain("Opening Deposit");
    expect(description).toContain("references unavailable");
  });
  it("rejects foreign invoice and quotation identities without leaking their text", async () => {
    mocked.getInvoice.mockResolvedValue({ projectId: 77, invoiceNumber: "PRIVATE" } as any);
    expect((await getCertificateInvoiceDescription(1))?.description).not.toContain("PRIVATE");
    expect(mocked.getDevis).not.toHaveBeenCalled();
  });
  it("resolves situation-only sources", async () => {
    mocked.getCertificatSources.mockResolvedValue([{ situationId: 9 }] as any);
    mocked.getSituation.mockResolvedValue({ devisId: 4, invoiceId: 4 } as any);
    expect((await getCertificateInvoiceDescription(1))?.description).toContain("F4");
  });
  it("prefers sealed invoice identity and supplier number", async () => {
    const cert = await mocked.getCertificat(1);
    mocked.getCertificat.mockResolvedValue({ ...cert, issuanceSnapshot: {
      sourceInvoiceIds: [5], supplierDirectPayment: { sources: { invoices: [{ invoiceId: 5, invoiceNumber: "SEALED" }] } },
    } } as any);
    const text = (await getCertificateInvoiceDescription(1))!.description;
    expect(text).toContain("SEALED");
    expect(text).not.toContain("F4");
  });
  it("returns null for missing certificates", async () => {
    mocked.getCertificat.mockResolvedValue(undefined);
    expect(await getCertificateInvoiceDescription(1)).toBeNull();
  });
  it("keeps a deposit identical before and after sealing despite unrelated rendered invoices", async () => {
    const base = await mocked.getCertificat(1);
    const deposit = { ...base, acompteDevisId: 8 };
    mocked.getCertificatSources.mockResolvedValue([]);
    mocked.getCertificat.mockResolvedValue(deposit as any);
    const before = await getCertificateInvoiceDescription(1);
    mocked.getCertificat.mockResolvedValue({ ...deposit, issuanceSnapshot: { sourceInvoiceIds: [4, 5] } } as any);
    // Some old seals also wrote these contextual IDs as source rows.
    mocked.getCertificatSources.mockResolvedValue([{ invoiceId: 4 }, { invoiceId: 5 }] as any);
    const after = await getCertificateInvoiceDescription(1);
    expect(after).toEqual(before);
    expect(after?.description).toContain("Opening Deposit - No accompanying contractor invoice.");
    expect(after?.description).toContain("Lot L8 — Work 8");
    expect(after?.description).not.toContain("F4");
    expect(mocked.getInvoice).not.toHaveBeenCalled();
  });
  it("normalizes paragraphs, deduplicates numbers, preserves titles and labels missing money", () => {
    const text = buildCertificateInvoiceDescription({ certificateRef: "C1", contractorName: "A\n B",
      netToPayHt: null, quotations: [{ lotNumber: "L", title: "Architect's title\nsecond line" }],
      invoiceNumbers: ["F1", " F1 "], openingDeposit: false });
    expect(text).not.toContain("\n");
    expect(text).toContain("Architect's title second line");
    expect(text.match(/F1/g)).toHaveLength(1);
    expect(text).toContain("(amount unavailable)");
  });
});
