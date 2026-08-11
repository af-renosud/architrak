// Task #425 — integration coverage for the firm's own fee invoices caught
// by Gmail polling.
//
// Exercises the REAL processEmailDocument pipeline (real PDF rasterisation,
// real prefilter, real firm-identity gate, real capture service) with an
// in-memory storage layer. The AI call is stubbed at the OpenAI SDK
// boundary so extraction deterministically returns a firm-issued facture
// d'honoraires.
//
// Proves the two review-critical invariants:
//   * an otherwise-unmatched firm invoice (unknown sender path uses the
//     firm-domain prefilter allowance) is parsed, gated, and captured into
//     architect_fee_invoices as pending_review;
//   * the doc NEVER enters contractor routing: no project document filing,
//     no Drive enqueue, no intake mirroring (projectId stays null), and the
//     email doc lands terminal with documentType=architect_fee_invoice.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmailDocument } from "@shared/schema";

// Firm-issued honoraires invoice: issuer (contractorName) is the firm.
const PARSED_FIXTURE = {
  documentType: "invoice", // deliberately mistyped by "AI" — the gate must rescue it
  contractorName: "SAS ARCHITECTS-FRANCE",
  clientName: "Heinz Hermann TRÜTKEN",
  invoiceNumber: "F-2026-138",
  date: "2026-08-10",
  amountHt: 1000.0,
  amountTtc: 1200.0,
  tvaAmount: 200.0,
  tvaRate: 20,
  description: "Honoraires — ouverture administrative de dossier",
};

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: JSON.stringify(PARSED_FIXTURE) } }],
        })),
      },
    };
  },
}));

const { state, storageSpy, objectStorageSpy, driveSpy } = vi.hoisted(() => {
  const state = {
    emailDocs: new Map<number, Record<string, unknown>>(),
    feeInvoices: [] as Array<Record<string, unknown>>,
    nextFeeInvoiceId: 1,
    projectDocs: [] as Array<Record<string, unknown>>,
    retryWrites: [] as Array<Record<string, unknown>>,
  };

  const storageSpy = {
    getEmailDocument: vi.fn(async (id: number) => state.emailDocs.get(id)),
    claimEmailDocumentForProcessing: vi.fn(async (id: number) => {
      const doc = state.emailDocs.get(id);
      if (!doc || doc.extractionStatus === "processing") return undefined;
      doc.extractionStatus = "processing";
      return { ...doc };
    }),
    updateEmailDocument: vi.fn(async (id: number, data: Record<string, unknown>) => {
      const doc = state.emailDocs.get(id);
      if (!doc) return undefined;
      Object.assign(doc, data);
      return { ...doc };
    }),
    setEmailDocumentRetryState: vi.fn(async (id: number, data: Record<string, unknown>) => {
      state.retryWrites.push({ id, ...data });
      const doc = state.emailDocs.get(id);
      if (doc) doc.extractionStatus = data.extractionStatus;
    }),
    getProjectDocumentBySourceEmailDocumentId: vi.fn(async () => undefined),
    createProjectDocument: vi.fn(async () => {
      throw new Error("createProjectDocument must NEVER be called for a firm fee invoice");
    }),
    getProjects: vi.fn(async () => [
      {
        id: 7,
        name: "TRÜTKEN (VERFEUIL) 1358",
        clientName: "Heinz Hermann TRÜTKEN",
        siteAddress: "Verfeuil",
        clientAddress: null,
      },
    ]),
    getContractors: vi.fn(async () => [{ id: 42, name: "AT PISCINES", siret: "82046676100021" }]),
    listGmailPollingUsers: vi.fn(async () => []),
    getAiModelSetting: vi.fn(async () => ({ provider: "openai", modelId: "gpt-4o" })),
    getLotCatalogByCode: vi.fn(async () => undefined),
    // Architect fee-invoice evidence store (in-memory mirror of the DB
    // partial-unique contracts).
    getArchitectFeeInvoiceByEmailDocumentId: vi.fn(async (id: number) =>
      state.feeInvoices.find((r) => r.emailDocumentId === id),
    ),
    getArchitectFeeInvoiceByIntakeDocumentId: vi.fn(async (id: number) =>
      state.feeInvoices.find((r) => r.intakeDocumentId === id),
    ),
    getArchitectFeeInvoiceByNormalizedRef: vi.fn(async (ref: string) =>
      state.feeInvoices.find((r) => r.invoiceNumberNormalized === ref && r.status !== "dismissed"),
    ),
    createArchitectFeeInvoice: vi.fn(async (data: Record<string, unknown>) => {
      const conflict = state.feeInvoices.some(
        (r) =>
          (data.emailDocumentId != null && r.emailDocumentId === data.emailDocumentId) ||
          (data.intakeDocumentId != null && r.intakeDocumentId === data.intakeDocumentId) ||
          (data.invoiceNumberNormalized != null &&
            r.invoiceNumberNormalized === data.invoiceNumberNormalized &&
            r.status !== "dismissed"),
      );
      if (conflict) return undefined; // ON CONFLICT DO NOTHING
      const row = { id: state.nextFeeInvoiceId++, status: "pending_review", ...data };
      state.feeInvoices.push(row);
      return row;
    }),
    updateArchitectFeeInvoice: vi.fn(async (id: number, data: Record<string, unknown>) => {
      const row = state.feeInvoices.find((r) => r.id === id);
      if (row) Object.assign(row, data);
      return row;
    }),
    getDesignContractByProject: vi.fn(async (projectId: number) =>
      projectId === 7 ? { id: 70, projectId: 7, totalTtc: "6000.00" } : undefined,
    ),
    getDesignContractMilestones: vi.fn(async () => [
      { id: 700, contractId: 70, sequence: 1, labelFr: "OUVERTURE ADMINISTRATIVE DE DOSSIER", labelEn: null, amountTtc: "1200.00", status: "pending" },
      { id: 701, contractId: 70, sequence: 2, labelFr: "AVANT-PROJET SOMMAIRE", labelEn: null, amountTtc: "3600.00", status: "pending" },
    ]),
  };

  const objectStorageSpy = {
    getDocumentBuffer: vi.fn(async () => Buffer.from(MINIMAL_PDF, "latin1")),
    uploadDocument: vi.fn(async () => {
      throw new Error("uploadDocument must NEVER be called for a firm fee invoice");
    }),
  };

  const driveSpy = {
    enqueueDriveUpload: vi.fn(async () => undefined),
  };

  const MINIMAL_PDF = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    "4 0 obj<</Length 48>>stream",
    "BT /F1 12 Tf 20 100 Td (Facture honoraires) Tj ET",
    "endstream endobj",
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
  ].join("\n");

  return { state, storageSpy, objectStorageSpy, driveSpy };
});

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../storage/object-storage", () => objectStorageSpy);
vi.mock("../services/drive/upload-queue.service", () => driveSpy);

import { processEmailDocument } from "../gmail/document-parser";

function seedEmailDoc(overrides: Partial<EmailDocument> = {}): void {
  state.emailDocs.set(1, {
    id: 1,
    // Unknown sender relative to contractors/clients — but the firm's own
    // domain (FIRM_EMAIL_DOMAINS default renosud.com), so the prefilter
    // firm allowance must let it through. Subject/filename deliberately
    // carry NO construction keyword and NO known project/client name.
    emailFrom: "Compta <compta@renosud.com>",
    emailSubject: "Document",
    attachmentFileName: "piece-jointe.pdf",
    storageKey: "email-docs/piece-jointe.pdf",
    extractionStatus: "pending",
    emailReceivedAt: new Date("2026-08-11T09:00:00Z"),
    processingAttempts: 0,
    projectId: null,
    contractorId: null,
    notes: null,
    ...overrides,
  });
}

beforeEach(() => {
  state.emailDocs.clear();
  state.feeInvoices.length = 0;
  state.projectDocs.length = 0;
  state.retryWrites.length = 0;
  state.nextFeeInvoiceId = 1;
  vi.clearAllMocks();
});

describe("processEmailDocument — architect fee invoices (Task #425)", () => {
  it("captures an otherwise-unmatched firm invoice and never enters contractor routing", async () => {
    seedEmailDoc();

    await processEmailDocument(1);

    // Prefilter let the firm-domain mail through; the gate rescued the
    // mistyped "invoice" and the capture service recorded evidence.
    expect(state.feeInvoices).toHaveLength(1);
    const evidence = state.feeInvoices[0];
    expect(evidence.status).toBe("pending_review");
    expect(evidence.emailDocumentId).toBe(1);
    expect(evidence.amountTtc).toBe("1200.00");
    const candidates = evidence.candidates as {
      projects: Array<{ projectId: number }>;
      highConfidenceProjectId: number | null;
      milestones: Record<string, Array<{ milestoneId: number }>>;
    };
    expect(candidates.projects[0]?.projectId).toBe(7);
    expect(candidates.highConfidenceProjectId).toBe(7);
    expect(candidates.milestones["7"][0].milestoneId).toBe(700); // exact TTC + first in sequence

    // NEVER contractor routing: no filing, no upload, no Drive, no mirror.
    expect(storageSpy.createProjectDocument).not.toHaveBeenCalled();
    expect(objectStorageSpy.uploadDocument).not.toHaveBeenCalled();
    expect(driveSpy.enqueueDriveUpload).not.toHaveBeenCalled();

    // Terminal email-doc state: typed, completed, and NOT project-assigned
    // (projectId null keeps the intake mirror a no-op by contract).
    const doc = state.emailDocs.get(1)!;
    expect(doc.documentType).toBe("architect_fee_invoice");
    expect(doc.extractionStatus).toBe("completed");
    expect(doc.projectId ?? null).toBeNull();
    expect(String(doc.notes)).toContain("fee-invoice queue");
    expect(state.retryWrites).toHaveLength(0);
  }, 120_000);

  it("re-processing the same doc dedups instead of creating a second evidence row", async () => {
    seedEmailDoc();
    await processEmailDocument(1);
    // Simulate operator re-analysis: back to pending, run again.
    state.emailDocs.get(1)!.extractionStatus = "pending";
    await processEmailDocument(1);

    expect(state.feeInvoices).toHaveLength(1);
    expect(storageSpy.createProjectDocument).not.toHaveBeenCalled();
  }, 120_000);
});
