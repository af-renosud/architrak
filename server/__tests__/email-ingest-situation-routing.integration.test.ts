import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #450 — Situation intake routing.
//
// Drives the REAL intake pipeline (attemptIntakeJob → runPipeline →
// case "situation" → createDraftSituationFromParsed) with a pre-parsed
// situation document and asserts:
//   1. unique mode_b devis match → DRAFT situation with claimed % per line,
//      server-computed rounded money, source-PDF provenance, and the intake
//      doc promoted with promotedKind "situation";
//   2. a non-mode_b devis match parks the doc (deterministic, no retry);
//   3. an ambiguous devis match (two candidates) parks the doc.

const { storageSpy } = vi.hoisted(() => ({
  storageSpy: {
    // Intake queue plumbing
    claimIntakeJobForAttempt: vi.fn(),
    markIntakeJobSucceeded: vi.fn(async () => undefined),
    markIntakeJobDeadLettered: vi.fn(async () => undefined),
    markIntakeJobPendingRetry: vi.fn(async () => undefined),
    getProjectIntakeDocument: vi.fn(),
    updateProjectIntakeDocument: vi.fn(async () => undefined),
    findProcessedIntakeDuplicateByFingerprint: vi.fn(async () => null),
    findProcessedIntakeDuplicateByTextHash: vi.fn(async () => null),
    // Dedup inputs (situation is NOT deduped by business identity)
    getDevisByProject: vi.fn(async () => []),
    getMarcheDocumentsByProject: vi.fn(async () => []),
    getInvoicesByProject: vi.fn(async () => []),
    getContractors: vi.fn(async () => [{ id: 11, name: "Acme" }]),
    // Situation routing
    getProjects: vi.fn(async () => [{ id: 3, name: "Maison Durand" }]),
    getDevisByProjectAndContractor: vi.fn(),
    // Situation creation
    getDevisLineItems: vi.fn(),
    getSituationsByDevis: vi.fn(async () => []),
    getSituationLines: vi.fn(async () => []),
    createSituation: vi.fn(async (row: Record<string, unknown>) => ({ id: 88, ...row })),
    createSituationLine: vi.fn(async (row: Record<string, unknown>) => ({ id: 1, ...row })),
    attachSituationSourcePdf: vi.fn(async () => ({})),
    attachSituationSourceAndRouteIntake: vi.fn(async () => ({ situation: { id: 32 } })),
  },
}));

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(async () => Buffer.from("%PDF-1.4 fake situation attachment")),
  uploadDocument: vi.fn(async (_p: number, name: string) => `mock-key/${name}`),
}));
vi.mock("../middleware/upload", () => ({ assertPdfMagic: vi.fn() }));
vi.mock("../services/reconciliation/reconciliation-queue.service", () => ({
  enqueueReconciliation: vi.fn(async () => undefined),
}));
vi.mock("../gmail/document-parser", async (importOriginal) => {
  const original = await importOriginal<typeof import("../gmail/document-parser")>();
  return {
    ...original,
    parseDocument: vi.fn(async () => {
      throw new Error("parseDocument must NOT be called — email pre-parse should be reused");
    }),
    matchToProject: vi.fn(async () => ({ projectId: 3, contractorId: 11 })),
  };
});

import { attemptIntakeJob } from "../services/intake/ingest-queue.service";

const DEVIS_MODE_B = {
  id: 7,
  projectId: 3,
  contractorId: 11,
  invoicingMode: "mode_b",
  amountHt: "1000.00",
  amountTtc: "1200.00",
};

const EMAIL_PARSED = {
  preParsedFromEmail: true,
  documentType: "situation",
  contractorName: "Acme",
  date: "2026-08-01",
  lineItems: [
    { description: "Gros œuvre", percentComplete: 50 },
    { description: "Charpente", percentComplete: 25 },
  ],
};

const INTAKE_DOC = {
  id: 55,
  projectId: 3,
  fileName: "situation-1.pdf",
  storageKey: "intake/3/situation-1.pdf",
  mimeType: "application/pdf",
  notes: null,
  extractedData: EMAIL_PARSED,
  analysisState: "pending",
  routingState: "pending",
};

beforeEach(() => {
  vi.clearAllMocks();
  storageSpy.claimIntakeJobForAttempt.mockResolvedValue({
    id: 801,
    intakeDocumentId: INTAKE_DOC.id,
    attempts: 0,
  });
  storageSpy.getProjectIntakeDocument.mockResolvedValue(INTAKE_DOC);
  storageSpy.getDevisByProjectAndContractor.mockResolvedValue([DEVIS_MODE_B]);
  storageSpy.getSituationsByDevis.mockResolvedValue([]);
  storageSpy.getDevisLineItems.mockResolvedValue([
    { id: 1, lineNumber: 1, description: "Gros œuvre", totalHt: "600.00" },
    { id: 2, lineNumber: 2, description: "Charpente", totalHt: "400.00" },
  ]);
});

describe("intake routing — situation documents (Task #450)", () => {
  it("retains the printed number from dense two-page Gemini extraction and attaches to that existing situation", async () => {
    const { parseDocument: realParse } = await vi.importActual<typeof import("../gmail/document-parser")>("../gmail/document-parser");
    const pageText = Array.from({length:48}, (_,i) =>
      `${i+1}. Fourniture et pose element ${i+1}   1 u   10,00   10,00`).join("\n");
    const gemini = vi.fn(async () => ({
      documentType: "situation" as const, situationNumber: 3, contractorName: "Acme",
      amountHt: 960, amountTtc: 1152,
      lineItems: Array.from({length:48},()=>({description:"Fourniture et pose",total:10,percentComplete:50})),
    }));
    const parsed = await realParse(Buffer.from("isolated PDF"), "dense-situation.pdf", {
      pdfToImagesWithCoverage: async()=>({images:[Buffer.from("page1"),Buffer.from("page2")],pdfPageCount:2}),
      getPageTexts: async()=>[pageText,pageText],
      getActiveModel: async()=>({provider:"gemini",modelId:"gemini-test"}),
      parseWithGemini: gemini,
    });
    expect(gemini).toHaveBeenCalledTimes(2);
    expect(parsed.situationNumber).toBe(3);
    expect(parsed.lineItems).toHaveLength(96);
    storageSpy.getProjectIntakeDocument.mockResolvedValue({
      ...INTAKE_DOC, extractedData:{...parsed,preParsedFromEmail:true},
    });
    storageSpy.getSituationsByDevis.mockResolvedValue([
      {id:31,devisId:7,situationNumber:2,status:"confirmed",sourceStorageKey:null},
      {id:32,devisId:7,situationNumber:3,status:"confirmed",sourceStorageKey:null},
    ] as never[]);
    await attemptIntakeJob(801);
    expect(storageSpy.attachSituationSourceAndRouteIntake).toHaveBeenCalledWith(expect.objectContaining({
      situationId: 32,
      intakeDocumentId: INTAKE_DOC.id,
      sourceStorageKey: INTAKE_DOC.storageKey,
    }));
    expect(storageSpy.createSituation).not.toHaveBeenCalled();
    expect(storageSpy.createSituationLine).not.toHaveBeenCalled();
  });

  it("refuses inconsistent or invalid situation numbers across chunks", async () => {
    const {mergeChunkedParses} = await vi.importActual<typeof import("../gmail/document-parser")>("../gmail/document-parser");
    const chunk = (situationNumber: number, pageOffset: number) => ({
      parsed:{documentType:"situation" as const,situationNumber},pageOffset,pageCount:1,
    });
    expect(()=>mergeChunkedParses([chunk(2,0),chunk(3,1)])).toThrow();
    expect(()=>mergeChunkedParses([chunk(0,0),chunk(0,1)])).toThrow();
    expect(()=>mergeChunkedParses([chunk(1.5,0),chunk(1.5,1)])).toThrow();
    expect(mergeChunkedParses([
      {parsed:{documentType:"unknown"},pageOffset:0,pageCount:1},chunk(3,1),
    ]).situationNumber).toBe(3);
  });
  it("unique mode_b devis → DRAFT situation with claimed % lines + promotion", async () => {
    await attemptIntakeJob(801);

    expect(storageSpy.markIntakeJobSucceeded).toHaveBeenCalledTimes(1);
    expect(storageSpy.createSituation).toHaveBeenCalledTimes(1);

    const created = storageSpy.createSituation.mock.calls[0][0] as Record<string, unknown>;
    expect(created.devisId).toBe(7);
    expect(created.status).toBe("draft");
    expect(created.situationNumber).toBe(1);
    expect(storageSpy.attachSituationSourcePdf).toHaveBeenCalledWith(88, expect.objectContaining({
      sourceStorageKey: INTAKE_DOC.storageKey,
      sourceFileName: INTAKE_DOC.fileName,
    }));
    // 600×50% + 400×25% = 300 + 100 = 400 cumulative, previous 0.
    expect(created.cumulativeHt).toBe("400.00");
    expect(created.previousHt).toBe("0.00");
    expect(created.netHt).toBe("400.00");

    const lineRows = storageSpy.createSituationLine.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(lineRows[0]).toMatchObject({
      devisLineItemId: 1,
      claimedPercent: "50.00",
      percentComplete: "50.00",
      checkStatus: "unchecked",
    });

    const promotion = storageSpy.updateProjectIntakeDocument.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((p) => p.promotedKind);
    expect(promotion).toMatchObject({
      routingState: "routed",
      promotedKind: "situation",
      promotedId: 88,
    });
  });

  it("non-mode_b devis match → parked, no situation created", async () => {
    storageSpy.getDevisByProjectAndContractor.mockResolvedValue([
      { ...DEVIS_MODE_B, invoicingMode: "mode_a" },
    ]);
    await attemptIntakeJob(801);

    expect(storageSpy.createSituation).not.toHaveBeenCalled();
    // Relationship parks are now a direct compare-and-swap DB transition,
    // rather than an unguarded storage update. The queue still performs its
    // initial analyzing transition through storage, but no storage call may
    // overwrite it with a delayed parked state.
    expect(storageSpy.updateProjectIntakeDocument).toHaveBeenCalledWith(
      INTAKE_DOC.id,
      { analysisState: "analyzing" },
    );
  });

  it("ambiguous devis match (two candidates) → parked", async () => {
    storageSpy.getDevisByProjectAndContractor.mockResolvedValue([
      DEVIS_MODE_B,
      { ...DEVIS_MODE_B, id: 8 },
    ]);
    await attemptIntakeJob(801);

    expect(storageSpy.createSituation).not.toHaveBeenCalled();
    expect(storageSpy.updateProjectIntakeDocument).toHaveBeenCalledWith(
      INTAKE_DOC.id,
      { analysisState: "analyzing" },
    );
  });
});
