// Integration tests for the Task #310 double-filing guards on
// processEmailDocument (Task #312).
//
// Exercises the REAL processEmailDocument pipeline end-to-end (real PDF
// rasterisation via poppler, real matchToProject / validateExtraction) with
// an in-memory storage layer whose claimEmailDocumentForProcessing mirrors
// the SQL conditional-UPDATE contract (status != 'processing' — atomic
// check-and-set before any await). The AI call is stubbed at the OpenAI SDK
// boundary so extraction is deterministic.
//
// Covered:
//   * two concurrent processEmailDocument calls on the same doc — the claim
//     loser no-ops (no second buffer fetch, no second project document, no
//     second Drive upload);
//   * a crash-retry where the attachment was already filed — the
//     getProjectDocumentBySourceEmailDocumentId probe skips re-filing;
//   * a doc already wedged on "processing" — a manual process click no-ops.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmailDocument, ProjectDocument } from "@shared/schema";

// Deterministic extraction result returned by the stubbed OpenAI SDK.
// clientName/projectAddress line up with the seeded project so
// matchToProject clears the confidence>=30 bar and files the attachment.
const PARSED_FIXTURE = {
  documentType: "quotation",
  contractorName: "AT PISCINES",
  clientName: "Famille Smith",
  projectAddress: "12 rue des Lilas, 75011 Paris",
  siret: "82046676100021",
  devisNumber: "DEV-2026-042",
  amountHt: 1000.0,
  amountTtc: 1200.0,
  tvaAmount: 200.0,
  tvaRate: 20,
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
    projectDocs: [] as Array<Record<string, unknown>>,
    nextProjectDocId: 1,
    retryWrites: [] as Array<Record<string, unknown>>,
  };

  const storageSpy = {
    getEmailDocument: vi.fn(async (id: number) => state.emailDocs.get(id)),
    // Mirrors the SQL conditional UPDATE: the status check and the write
    // happen synchronously (no await in between), so interleaved callers
    // observe the same winner-takes-all semantics as the real
    // `UPDATE ... WHERE status != 'processing' RETURNING *`.
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
    getProjectDocumentBySourceEmailDocumentId: vi.fn(async (sourceId: number) =>
      state.projectDocs.find((d) => d.sourceEmailDocumentId === sourceId),
    ),
    createProjectDocument: vi.fn(async (data: Record<string, unknown>) => {
      // Enforce the migration-0056 partial unique index contract in the
      // in-memory layer too: a second insert for the same source email
      // document must fail loudly, never silently duplicate.
      if (
        data.sourceEmailDocumentId != null &&
        state.projectDocs.some((d) => d.sourceEmailDocumentId === data.sourceEmailDocumentId)
      ) {
        throw new Error(
          'duplicate key value violates unique constraint "project_documents_source_email_doc_idx"',
        );
      }
      const row = { id: state.nextProjectDocId++, ...data };
      state.projectDocs.push(row);
      return row as unknown as ProjectDocument;
    }),
    getProjects: vi.fn(async () => [
      {
        id: 7,
        name: "Famille Smith",
        clientName: "Famille Smith",
        siteAddress: "12 rue des Lilas, 75011 Paris",
      },
    ]),
    getContractors: vi.fn(async () => [
      {
        id: 42,
        name: "AT PISCINES",
        siret: "82046676100021",
      },
    ]),
    getAiModelSetting: vi.fn(async () => ({ provider: "openai", modelId: "gpt-4o" })),
    getLotCatalogByCode: vi.fn(async () => undefined),
  };

  const objectStorageSpy = {
    getDocumentBuffer: vi.fn(async () => Buffer.from(MINIMAL_PDF, "latin1")),
    uploadDocument: vi.fn(
      async (projectId: number, fileName: string) => `projects/${projectId}/${fileName}`,
    ),
  };

  const driveSpy = {
    enqueueDriveUpload: vi.fn(async () => undefined),
  };

  // Minimal but well-formed one-page PDF ("Hello") — enough for qpdf,
  // poppler rasterisation, and pdftotext to succeed for real.
  const MINIMAL_PDF = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    "4 0 obj<</Length 44>>stream",
    "BT /F1 12 Tf 20 100 Td (Hello devis) Tj ET",
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
    // Task #503 — the prefilter is now evidence-tiered: a generic keyword
    // alone no longer reaches AI. Mention the live project so the doc is
    // high-tier; this suite is about double-filing guards, not relevance.
    emailSubject: "Devis piscine Famille Smith",
    attachmentFileName: "devis.pdf",
    storageKey: "email-docs/devis.pdf",
    extractionStatus: "pending",
    // Task #322 — must be on/after the intake watermark (2026-08-10 07:00Z)
    // or processEmailDocument refuses the document at the boundary guard.
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
  state.projectDocs.length = 0;
  state.retryWrites.length = 0;
  state.nextProjectDocId = 1;
  vi.clearAllMocks();
});

describe("processEmailDocument — double-filing guards (Task #312)", () => {
  it("files the attachment exactly once when two servers race on the same doc", async () => {
    seedEmailDoc();

    await Promise.all([processEmailDocument(1), processEmailDocument(1)]);

    // Both callers attempted the claim; exactly one won.
    expect(storageSpy.claimEmailDocumentForProcessing).toHaveBeenCalledTimes(2);
    const claims = await Promise.all(
      storageSpy.claimEmailDocumentForProcessing.mock.results.map((r) => r.value),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    // The loser did no work: one buffer fetch, one upload, one filing.
    expect(objectStorageSpy.getDocumentBuffer).toHaveBeenCalledTimes(1);
    expect(objectStorageSpy.uploadDocument).toHaveBeenCalledTimes(1);
    expect(storageSpy.createProjectDocument).toHaveBeenCalledTimes(1);
    expect(state.projectDocs).toHaveLength(1);
    expect(state.projectDocs[0].sourceEmailDocumentId).toBe(1);

    // One Drive enqueue for the quotation.
    expect(driveSpy.enqueueDriveUpload).toHaveBeenCalledTimes(1);

    // The winner completed normally — no failure/retry write happened.
    expect(state.retryWrites).toHaveLength(0);
    const doc = state.emailDocs.get(1)!;
    expect(["completed", "needs_review"]).toContain(doc.extractionStatus);
    expect(doc.projectId).toBe(7);
  }, 120_000);

  it("skips re-filing on a crash-retry when the attachment was already filed", async () => {
    // Simulate a crash AFTER the project-document insert but BEFORE the
    // final status write: the filing exists, the doc is back on "pending".
    seedEmailDoc();
    state.projectDocs.push({
      id: state.nextProjectDocId++,
      projectId: 7,
      fileName: "devis.pdf",
      storageKey: "projects/7/devis.pdf",
      sourceEmailDocumentId: 1,
    });

    await processEmailDocument(1);

    // The idempotency probe found the prior filing — no second upload, no
    // second project document, no second Drive enqueue.
    expect(storageSpy.getProjectDocumentBySourceEmailDocumentId).toHaveBeenCalledWith(1);
    expect(objectStorageSpy.uploadDocument).not.toHaveBeenCalled();
    expect(storageSpy.createProjectDocument).not.toHaveBeenCalled();
    expect(driveSpy.enqueueDriveUpload).not.toHaveBeenCalled();
    expect(state.projectDocs).toHaveLength(1);

    // The retry still refreshed the extraction result and terminal status.
    const doc = state.emailDocs.get(1)!;
    expect(["completed", "needs_review"]).toContain(doc.extractionStatus);
  }, 120_000);

  it("refuses to process a dumped ('skipped') document — even manually (Task #322)", async () => {
    seedEmailDoc({ extractionStatus: "skipped" });

    await expect(processEmailDocument(1)).rejects.toThrow(/abandonné/);

    // No claim, no AI extraction, no side effects.
    expect(storageSpy.claimEmailDocumentForProcessing).not.toHaveBeenCalled();
    expect(objectStorageSpy.getDocumentBuffer).not.toHaveBeenCalled();
    expect(state.emailDocs.get(1)!.extractionStatus).toBe("skipped");
  });

  it("refuses documents received before the intake watermark (Task #322)", async () => {
    seedEmailDoc({ emailReceivedAt: new Date("2026-08-07T10:00:00Z") });

    await expect(processEmailDocument(1)).rejects.toThrow(/point de reprise/);
    expect(storageSpy.claimEmailDocumentForProcessing).not.toHaveBeenCalled();
    expect(objectStorageSpy.getDocumentBuffer).not.toHaveBeenCalled();
  });

  it("no-ops a manual process click on a doc another worker holds", async () => {
    seedEmailDoc({ extractionStatus: "processing" });

    await processEmailDocument(1);

    // Claim lost — nothing downstream ran and no state was clobbered.
    expect(objectStorageSpy.getDocumentBuffer).not.toHaveBeenCalled();
    expect(storageSpy.createProjectDocument).not.toHaveBeenCalled();
    expect(storageSpy.setEmailDocumentRetryState).not.toHaveBeenCalled();
    expect(state.emailDocs.get(1)!.extractionStatus).toBe("processing");
  });

  it("still throws for a missing document (route surfaces a 500)", async () => {
    await expect(processEmailDocument(999)).rejects.toThrow("not found");
  });
});
