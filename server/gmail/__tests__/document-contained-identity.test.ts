import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  text: "FACTURE 123\nTotal TTC 120",
  doc: {
    id: 901, storageKey: "retained/original.pdf", extractionStatus: "pending",
    emailReceivedAt: new Date("2026-11-11"), emailSubject: "Jean Martin Villa Martin",
    attachmentFileName: "Jean Martin.pdf", emailFrom: "jean@example.test",
    extractedData: null,
  },
}));
vi.mock("../../storage", () => ({
  storage: {
    getEmailDocument: vi.fn(async () => fixture.doc),
    claimEmailDocumentForProcessing: vi.fn(async () => fixture.doc),
    getProjects: vi.fn(async () => [{ id: 1, name: "Villa Martin", clientName: "Jean Martin" }]),
    getContractors: vi.fn(async () => []),
    updateEmailDocument: vi.fn(async () => undefined),
    setEmailDocumentRetryState: vi.fn(async () => undefined),
    createProjectDocument: vi.fn(),
  },
}));
vi.mock("../../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(async () => Buffer.from("%PDF-1.7 retained")),
  uploadDocument: vi.fn(),
}));
vi.mock("../financial-pdf-triage", async importOriginal => {
  const original = await importOriginal<typeof import("../financial-pdf-triage")>();
  return { ...original, triageFinancialPdf: (buffer: Buffer, email: string, projects: any[], cached: unknown) =>
    original.triageFinancialPdf(buffer, email, projects, cached, async () => ({ text: fixture.text, method: "text" })) };
});
import { storage } from "../../storage";
import { uploadDocument } from "../../storage/object-storage";
import { processEmailDocument } from "../document-parser";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.text = "FACTURE 123\nTotal TTC 120";
});
describe("claimed processing document identity boundary", () => {
  it.each(["pending", "failed"])("parks %s email-only documents before extraction or filing", async status => {
    fixture.doc.extractionStatus = status;
    await processEmailDocument(901);
    expect(storage.setEmailDocumentRetryState).toHaveBeenCalledWith(901, expect.objectContaining({
      extractionStatus: "financial_identity_review", nextProcessAttemptAt: null,
      notes: expect.stringContaining("inside the PDF"),
    }));
    expect(storage.updateEmailDocument).toHaveBeenCalledTimes(1);
    expect(storage.updateEmailDocument).toHaveBeenCalledWith(901, expect.objectContaining({
      extractedData: expect.objectContaining({
        financialTriage: expect.objectContaining({
          decision: expect.objectContaining({ projectId: null, identitySource: null }),
        }),
      }),
    }));
    expect(storage.createProjectDocument).not.toHaveBeenCalled();
    expect(uploadDocument).not.toHaveBeenCalled();
  });
  it("does not let force processing override conflicting PDF identity", async () => {
    fixture.text = "FACTURE 123\nClient : Unknown Person\nTotal TTC 120";
    await processEmailDocument(901, { bypassPrefilter: true });
    expect(storage.setEmailDocumentRetryState).toHaveBeenCalledWith(901, expect.objectContaining({
      extractionStatus: "financial_identity_review",
      notes: expect.stringContaining("Conflicting or unrecognised"),
    }));
    expect(storage.createProjectDocument).not.toHaveBeenCalled();
    expect(uploadDocument).not.toHaveBeenCalled();
  });
});
