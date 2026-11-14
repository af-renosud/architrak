import { describe, expect, it } from "vitest";
import { emailHasFinancialAdmission, emailNeedsAttention, emailVisibleByDefault, evaluateFinancialPdf } from "../../shared/email-financial-gate";
import { unverifiedPdfCleanupReason, UNVERIFIED_PDF_RETENTION_MS } from "../../shared/email-admission-retention";
const project = { id: 7, name: "TEST PROJECT", clientName: "Jane Example", status: "active" };
const decision = evaluateFinancialPdf("DEVIS\nClient: Jane Example\nTotal TTC 1000", "", [project]);
const admitted = { extractionStatus: "failed", extractedData: { financialTriage: { decision } } };
const unknown = { extractionStatus: "failed", extractedData: { financialTriage: { decision: evaluateFinancialPdf("", "", [project]) } } };
describe("positive-evidence-only financial review", () => {
  it("does not surface unreadable or pre-admission failures", () => {
    for (const extractionStatus of ["failed", "pending", "processing", "financial_unreadable"]) {
      expect(emailNeedsAttention({ ...unknown, extractionStatus })).toBe(false);
      expect(emailVisibleByDefault({ ...unknown, extractionStatus })).toBe(false);
    }
  });
  it("retains attention for admitted extraction failures and linked legacy evidence", () => {
    expect(emailNeedsAttention(admitted)).toBe(true);
    expect(emailVisibleByDefault(admitted)).toBe(true);
    expect(emailHasFinancialAdmission({ extractionStatus: "failed", devisId: 1 })).toBe(true);
  });
  it("email identity and financial siblings cannot admit a plan", () => {
    const plan = evaluateFinancialPdf("PLAN\nClient: Jane Example\nLiving room layout", "DEVIS TTC", [project]);
    expect(emailHasFinancialAdmission({ extractionStatus: "failed", extractedData: { financialTriage: { decision: plan } } })).toBe(false);
    expect(emailHasFinancialAdmission({ ...admitted, extractedData: { financialTriage: { decision: { ...decision, identitySource: "email" } } } })).toBe(false);
  });
  it("expires unverified copies only after seven days and never admitted or linked evidence", () => {
    const now = Date.now();
    const old = { ...unknown, createdAt: new Date(now - UNVERIFIED_PDF_RETENTION_MS - 1) };
    expect(unverifiedPdfCleanupReason(old, now)).toBe("unverified_retention_expired");
    expect(unverifiedPdfCleanupReason({ ...old, createdAt: new Date(now) }, now)).toBeNull();
    expect(unverifiedPdfCleanupReason({ ...old, ...admitted }, now)).toBeNull();
    expect(unverifiedPdfCleanupReason({ ...old, projectId: 7 }, now)).toBeNull();
    expect(unverifiedPdfCleanupReason({ ...old, extractionStatus: "processing" }, now)).toBeNull();
  });
  it("requires exact user-confirmed plan bytes and filename", () => {
    const plan = { ...unknown, createdAt: new Date(), attachmentFileName: "V14_LIVERMORE_opt.pdf",
      contentFingerprint: "f95dbff4dd9875ea010c9f60416beed7230d38755db1c55f3c479c9be7227ce9" };
    expect(unverifiedPdfCleanupReason(plan)).toBe("confirmed_plan");
    expect(unverifiedPdfCleanupReason({ ...plan, contentFingerprint: "changed" })).toBeNull();
    expect(unverifiedPdfCleanupReason({ ...plan, invoiceId: 12 })).toBeNull();
  });
});
