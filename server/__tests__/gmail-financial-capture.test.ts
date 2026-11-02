import { beforeEach, describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "googleapis";
const fixture = vi.hoisted(() => ({
  text: "FACTURE 123\nTotal HT 1000\nTotal TTC 1200",
  ocrFailure: false, lookupFailure: false,
  saved: [] as any[],
}));
vi.mock("../storage", () => ({
  storage: {
    getEmailDocumentByMessageId: vi.fn(async () => undefined),
    getEmailDocumentByFingerprint: vi.fn(async () => undefined),
    getProjects: vi.fn(async () => {
      if (fixture.lookupFailure) throw new Error("Database temporarily unavailable");
      return [{ id: 1, name: "Villa Martin", clientName: "Jean Martin" }];
    }),
    createEmailDocument: vi.fn(async (doc: any) => { fixture.saved.push(doc); return { ...doc, id: 1 }; }),
  },
}));
vi.mock("../storage/object-storage", () => ({
  uploadDocument: vi.fn(async () => "email/retained.pdf"),
  isObjectStorageConfigured: vi.fn(() => true),
}));
vi.mock("../gmail/financial-pdf-triage", async importOriginal => {
  const original = await importOriginal<typeof import("../gmail/financial-pdf-triage")>();
  return { ...original, triageFinancialPdf: (buffer: Buffer, email: string, projects: any[], cached: unknown) =>
    original.triageFinancialPdf(buffer, email, projects, cached, async () => {
      if (fixture.ocrFailure) throw new Error("[503] OCR temporarily unavailable");
      return { text: fixture.text, method: "ocr" };
    }) };
});
import { processMessage, GMAIL_PDF_QUERY } from "../gmail/monitor";
import { triageFinancialPdf } from "../gmail/financial-pdf-triage";

function gmail(htmlOnly = false, sent = false): gmail_v1.Gmail {
  const textPart = { mimeType: htmlOnly ? "text/html" : "text/plain", body: {
    data: Buffer.from(htmlOnly ? "<p>Pour Jean Martin</p>" : "Pour Jean Martin").toString("base64url"),
  } };
  return { users: { messages: {
    get: vi.fn(async () => ({ data: {
      labelIds: sent ? ["SENT"] : ["INBOX"],
      internalDate: String(new Date("2026-11-01").getTime()), threadId: "thread",
      payload: { mimeType: "multipart/mixed", headers: [
        { name: "From", value: sent ? "compta@renosud.com" : "new-contractor@example.fr" }, { name: "Subject", value: "Document joint" },
      ], parts: [
        { mimeType: "multipart/alternative", parts: [textPart] },
        { mimeType: "application/pdf", filename: "piece.pdf", body: { attachmentId: "attachment" } },
      ] },
    } })),
    attachments: { get: vi.fn(async () => ({ data: { data: Buffer.from("%PDF-1.7 fixture").toString("base64url") } })) },
  } } } as unknown as gmail_v1.Gmail;
}
beforeEach(() => {
  fixture.saved.length = 0; fixture.ocrFailure = false; fixture.lookupFailure = false;
  fixture.text = "FACTURE 123\nTotal HT 1000\nTotal TTC 1200";
});
describe("real multipart capture boundary", () => {
  it("keeps Sent fee-invoice coverage and applies the same content gate", async () => {
    expect(GMAIL_PDF_QUERY).not.toContain("-in:sent");
    fixture.text = "FACTURE D'HONORAIRES\nClient : Jean Martin\nTotal HT 1000\nTTC 1200";
    await processMessage(gmail(false, true), "sent-fee", false, 1);
    expect(fixture.saved[0].extractionStatus).toBe("pending");
    expect(fixture.saved[0].extractedData.financialTriage.decision.projectId).toBe(1);
    fixture.text = "CERTIFICAT DE PAIEMENT\nJean Martin\nFACTURE 123\nTotal TTC 1200";
    await processMessage(gmail(false, true), "sent-echo", false, 1);
    expect(fixture.saved[1].extractionStatus).toBe("financial_excluded");
  });
  it.each([false, true])("admits PDF with identity only in multipart email body (HTML=%s)", async htmlOnly => {
    await processMessage(gmail(htmlOnly), "message", false, 1);
    expect(fixture.saved).toHaveLength(1);
    expect(fixture.saved[0].extractionStatus).toBe("pending");
    expect(fixture.saved[0].extractedData.financialTriage.decision.identitySource).toBe("email");
    expect(fixture.saved[0].extractedData.financialTriage.decision.projectId).toBe(1);
  });
  it.each(["ocr", "projects"])("retains attachment for automatic retry after a temporary %s outage", async dependency => {
    fixture.ocrFailure = dependency === "ocr"; fixture.lookupFailure = dependency === "projects";
    await processMessage(gmail(), "message", false, 1);
    const doc = fixture.saved[0];
    expect(doc.extractionStatus).toBe("pending");
    expect(doc.storageKey).toBe("email/retained.pdf");
    expect(doc.extractedData.financialTriage.emailText).toContain("Jean Martin");
    fixture.ocrFailure = false; fixture.lookupFailure = false;
    const recovered = await triageFinancialPdf(Buffer.from("%PDF-1.7 fixture"),
      doc.extractedData.financialTriage.emailText, [{ id: 1, name: "Villa Martin", clientName: "Jean Martin" }],
      doc.extractedData.financialTriage);
    expect(recovered.decision.status).toBe("eligible");
  });
  it("parks actual unreadable text, rather than treating it as irrelevant", async () => {
    fixture.text = "";
    await processMessage(gmail(), "message", false, 1);
    expect(fixture.saved[0].extractionStatus).toBe("financial_unreadable");
  });
});
