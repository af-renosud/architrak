import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

// Task #342 — Integration coverage for the derived-totals draft warning
// through the EMAIL-INGEST processing path.
//
// Manual upload paths are covered by
//   server/__tests__/devis-upload-derived-totals.integration.test.ts   (task #340)
//   server/__tests__/invoice-upload-derived-totals.integration.test.ts (task #341)
// but documents also arrive via the Gmail pipeline: the email-side
// extraction is mirrored into project_intake_documents.extractedData
// with the `preParsedFromEmail: true` marker, and the intake queue
// (server/services/intake/ingest-queue.service.ts) hands that PRE-PARSED
// result straight into processInvoiceUpload — parseDocument is never
// re-run. If that hand-off ever bypassed or re-shaped the validation
// result, a document with missing totals would be persisted silently as
// €0.00 with no warning (the production incident behind task #338).
//
// This test drives the REAL intake pipeline (attemptIntakeJob →
// runPipeline → processInvoiceUpload → validateExtraction → persistence)
// with an intake doc whose extractedData is an email-side parse where
// amountHt/amountTtc are both null and line items are present, and
// asserts the persisted invoice row carries:
//   1. the `field: "amountHt"` derived-totals warning,
//   2. aiConfidence <= 40,
//   3. amountHt / amountTtc equal to the derived amounts,
// and that parseDocument was NEVER called (the email parse is reused).

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
    // 5b system-wide dedup inputs
    getDevisByProject: vi.fn(async () => []),
    getMarcheDocumentsByProject: vi.fn(async () => []),
    getInvoicesByProject: vi.fn(async () => []),
    getContractors: vi.fn(async () => [{ id: 11, name: "Acme" }]),
    // Invoice routing
    getProjects: vi.fn(async () => [{ id: 3, name: "Maison Durand" }]),
    getDevisByProjectAndContractor: vi.fn(),
    // processInvoiceUpload persistence
    getDevis: vi.fn(),
    getInvoiceBySourceIntakeDocumentId: vi.fn(async () => undefined),
    createProjectDocument: vi.fn(async () => ({ id: 1 })),
    createIntakeInvoiceWithProjectDocument: vi.fn(),
    createInvoice: vi.fn(async (row: Record<string, unknown>) => ({
      id: 909,
      ...row,
    })),
    revokeDevisCheckTokenIfFullyInvoiced: vi.fn(async () => undefined),
    updateDevis: vi.fn(async () => undefined),
  },
}));
let savedInvoice: any;

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(async () => Buffer.from("%PDF-1.4 fake email attachment")),
  uploadDocument: vi.fn(async (_p: number, name: string) => `mock-key/${name}`),
}));
vi.mock("../middleware/upload", () => ({ assertPdfMagic: vi.fn() }));
vi.mock("../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(async () => undefined),
}));
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn(async () => undefined),
}));
vi.mock("../services/reconciliation/reconciliation-queue.service", () => ({
  enqueueReconciliation: vi.fn(async () => undefined),
}));
// Mock ONLY the AI boundary — validateExtraction and everything downstream
// stay real. parseDocument throws so any re-parse of an email-parsed doc
// fails the test loudly; matchToProject is mocked to a unique contractor.
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
import { parseDocument } from "../gmail/document-parser";

const parseDocumentMock = parseDocument as unknown as ReturnType<typeof vi.fn>;

const DEVIS = {
  id: 7,
  devisCode: "DVP0000661",
  projectId: 3,
  contractorId: 11,
  lotId: null,
  acompteRequired: false,
  acompteState: "not_required",
};

// Email-side extraction as mirrored by mirrorEmailDocumentToIntake:
// the raw parse plus the preParsedFromEmail marker. Mirrors the
// production incident: line items extracted, both totals null.
const EMAIL_PARSED = {
  preParsedFromEmail: true,
  documentType: "invoice",
  contractorName: "Acme",
  invoiceNumber: "FA-2026-099",
  amountHt: null,
  amountTtc: null,
  tvaAmount: null,
  tvaRate: 20,
  lineItems: [
    { description: "Gros œuvre", total: 100000 },
    { description: "Charpente", total: 77000 },
    { description: "Menuiseries", total: 50000 },
  ],
  relatedDocumentReferences: [{
    kind: "quotation",
    reference: "DVP0000661",
    evidenceText: "Devis DVP0000661",
  }],
};

const INTAKE_DOC = {
  id: 42,
  projectId: 3,
  fileName: "facture-email.pdf",
  storageKey: "intake/3/facture-email.pdf",
  mimeType: "application/pdf",
  notes: null,
  extractedData: EMAIL_PARSED,
  analysisState: "pending",
  routingState: "pending",
};

interface WarningShape {
  field: string;
  severity: string;
  message: string;
  expected: unknown;
  actual: unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  storageSpy.claimIntakeJobForAttempt.mockResolvedValue({
    id: 501,
    intakeDocumentId: INTAKE_DOC.id,
    attempts: 0,
  });
  storageSpy.getProjectIntakeDocument.mockResolvedValue(INTAKE_DOC);
  storageSpy.getDevisByProject.mockResolvedValue([DEVIS]);
  storageSpy.getDevisByProjectAndContractor.mockResolvedValue([DEVIS]);
  storageSpy.getDevis.mockResolvedValue(DEVIS);
  savedInvoice = undefined;
  storageSpy.getInvoicesByProject.mockImplementation(async () => savedInvoice ? [savedInvoice] : []);
  storageSpy.getInvoiceBySourceIntakeDocumentId.mockImplementation(async (sourceIntakeDocumentId: number) =>
    savedInvoice?.sourceIntakeDocumentId === sourceIntakeDocumentId ? savedInvoice : undefined,
  );
  storageSpy.createIntakeInvoiceWithProjectDocument.mockImplementation(async (row, _document, guard) => {
    const created = !savedInvoice;
    const invoice = savedInvoice ?? await storageSpy.createInvoice(row);
    savedInvoice = invoice;
    if (guard) await storageSpy.updateProjectIntakeDocument(row.sourceIntakeDocumentId, {
      analysisState: "analyzed", routingState: "routed", promotedKind: "invoice", promotedId: invoice.id,
    });
    return { invoice, created };
  });
});

describe("email-ingest path — derived-totals warning reaches the persisted invoice (Task #342)", () => {
  it("gmail-mirrored parse with null HT/TTC + line items → invoice persisted with amountHt warning, confidence <= 40, derived amounts; no re-parse", async () => {
    await attemptIntakeJob(501);

    // The pipeline routed to an invoice (not parked / dead-lettered).
    expect(storageSpy.markIntakeJobSucceeded).toHaveBeenCalledTimes(1);
    expect(storageSpy.markIntakeJobDeadLettered).not.toHaveBeenCalled();
    expect(storageSpy.createInvoice).toHaveBeenCalledTimes(1);

    // The email-side extraction was REUSED — Gemini never re-invoked.
    expect(parseDocumentMock).not.toHaveBeenCalled();

    const row = storageSpy.createInvoice.mock.calls[0][0] as {
      devisId: number;
      status: string;
      validationWarnings: WarningShape[];
      aiConfidence: number;
      amountHt: string;
      amountTtc: string;
      tvaAmount: string;
    };

    expect(row.devisId).toBe(DEVIS.id);
    expect(row.status).toBe("draft");

    // 1. The derived-totals warning survived email parse → intake mirror
    //    → intake queue → invoice persistence.
    const derivedWarning = row.validationWarnings.find((w) => w.field === "amountHt");
    expect(derivedWarning).toBeDefined();
    expect(derivedWarning!.severity).toBe("warning");
    expect(derivedWarning!.message).toContain("Document totals were missing from the extraction");
    expect(derivedWarning!.message).toContain("derived from the sum of 3 line items");
    expect(derivedWarning!.expected).toBe(227000);
    expect(derivedWarning!.actual).toBe(0);

    // 2. Confidence is capped so the draft visibly demands review.
    expect(row.aiConfidence).toBeLessThanOrEqual(40);

    // 3. Persisted amounts equal the derived values (HT = line sum,
    //    TTC = HT × 1.20 from the extracted TVA rate, TVA = TTC − HT) —
    //    NOT €0.00.
    expect(row.amountHt).toBe("227000");
    expect(row.amountTtc).toBe("272400");
    expect(row.tvaAmount).toBe("45400");

    // Both sides were derived, so no missing-pair error blocks the draft.
    expect(row.validationWarnings.some((w) => w.severity === "error")).toBe(false);

    // The intake doc was promoted to the typed invoice.
    const promotion = storageSpy.updateProjectIntakeDocument.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((u) => u.routingState === "routed");
    expect(promotion).toBeDefined();
    expect(promotion!.promotedKind).toBe("invoice");
    expect(promotion!.promotedId).toBe(909);
  });

  it("TTC-underivable variant (no TVA rate): warning still persisted, TTC defaults to HT — never €0.00", async () => {
    storageSpy.getProjectIntakeDocument.mockResolvedValue({
      ...INTAKE_DOC,
      extractedData: {
        ...EMAIL_PARSED,
        invoiceNumber: "FA-2026-100",
        tvaRate: null,
        lineItems: [
          { description: "Plomberie", total: 1200.5 },
          { description: "Électricité", total: 799.5 },
        ],
      },
    });

    await attemptIntakeJob(501);

    expect(parseDocumentMock).not.toHaveBeenCalled();
    expect(storageSpy.createInvoice).toHaveBeenCalledTimes(1);
    const row = storageSpy.createInvoice.mock.calls[0][0] as {
      validationWarnings: WarningShape[];
      aiConfidence: number;
      amountHt: string;
      amountTtc: string;
    };

    const derivedWarning = row.validationWarnings.find(
      (w) => w.field === "amountHt" && w.severity === "warning",
    );
    expect(derivedWarning).toBeDefined();
    expect(derivedWarning!.message).toContain("TTC could not be derived");
    expect(row.aiConfidence).toBeLessThanOrEqual(40);
    expect(row.amountHt).toBe("2000");
    // TVA-neutral defaulting: no derivable TTC ⇒ mirror HT (derived TVA = 0).
    expect(row.amountTtc).toBe("2000");
  });

  it("resumes a source-owned derived-total invoice instead of parking it for the persisted-total dedup review", async () => {
    await attemptIntakeJob(501);
    // Simulate a retry after the guarded invoice insert succeeded but before
    // its source route/finalization completed. The retained extraction still
    // has null totals; the persisted owner contains the derived totals.
    storageSpy.getProjectIntakeDocument.mockResolvedValue({
      ...INTAKE_DOC,
      contentFingerprint: createHash("sha256")
        .update(Buffer.from("%PDF-1.4 fake email attachment"))
        .digest("hex"),
    });
    await attemptIntakeJob(501);

    expect(storageSpy.markIntakeJobSucceeded).toHaveBeenCalledTimes(2);
    expect(storageSpy.createInvoice).toHaveBeenCalledTimes(1);
    // Initial persistence, first finalization route, then the retried
    // finalization route all reuse the one source-owned invoice.
    expect(storageSpy.createIntakeInvoiceWithProjectDocument).toHaveBeenCalledTimes(3);
    const routingWrites = storageSpy.updateProjectIntakeDocument.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((update) => update.routingState === "routed" && update.promotedKind === "invoice");
    expect(routingWrites).toHaveLength(5);
  });

  it("lets a pending source-owned invoice resume after another source is deduped, without replacing its metadata", async () => {
    const sourceA = {
      ...INTAKE_DOC,
      id: 42,
      notes: "source A metadata",
      analysisState: "pending",
      routingState: "pending",
    };
    const sourceB = {
      ...INTAKE_DOC,
      id: 43,
      fileName: "facture-email-copy.pdf",
      storageKey: "intake/3/facture-email-copy.pdf",
      extractedData: {
        ...EMAIL_PARSED,
        // The second extraction has the totals the first persisted from lines,
        // so it is a typed exact duplicate while source A is still pending.
        amountHt: 227000,
        amountTtc: 272400,
      },
      notes: "source B metadata",
      analysisState: "pending",
      routingState: "pending",
    };
    const docs = new Map<number, any>([[sourceA.id, sourceA], [sourceB.id, sourceB]]);
    let phase: "a-first" | "b" | "a-retry" = "a-first";
    let revokeAttempts = 0;
    storageSpy.getProjectIntakeDocument.mockImplementation(async (id: number) => docs.get(id));
    storageSpy.updateProjectIntakeDocument.mockImplementation(async (id: number, update: Record<string, unknown>) => {
      Object.assign(docs.get(id)!, update);
    });
    storageSpy.claimIntakeJobForAttempt.mockImplementation(async (jobId: number) => ({
      id: jobId,
      intakeDocumentId: phase === "b" ? sourceB.id : sourceA.id,
      attempts: 0,
    }));
    storageSpy.findProcessedIntakeDuplicateByFingerprint.mockImplementation(async (_projectId: number, _fingerprint: string, sourceId: number) =>
      phase === "a-retry" && sourceId === sourceA.id ? { id: sourceB.id } : null,
    );
    storageSpy.revokeDevisCheckTokenIfFullyInvoiced.mockImplementation(async () => {
      revokeAttempts++;
      if (revokeAttempts === 1) throw new Error("simulated post-persistence failure");
    });
    storageSpy.createIntakeInvoiceWithProjectDocument.mockImplementation(async (row, _document, guard, routeOptions) => {
      const created = !savedInvoice;
      const invoice = savedInvoice ?? await storageSpy.createInvoice(row);
      savedInvoice = invoice;
      if (guard && routeOptions?.routeSource) {
        await storageSpy.updateProjectIntakeDocument(row.sourceIntakeDocumentId, {
          analysisState: "analyzed",
          routingState: "routed",
          promotedKind: "invoice",
          promotedId: invoice.id,
        });
      }
      return { invoice, created };
    });

    // A persists its invoice, then its finalization fails before the source
    // route. B arrives while A is still not analysed and is safely deduped.
    await attemptIntakeJob(501);
    expect(storageSpy.createInvoice).toHaveBeenCalledTimes(1);
    phase = "b";
    await attemptIntakeJob(502);
    expect(docs.get(sourceB.id)).toMatchObject({ routingState: "duplicate" });

    // On retry, B is now an analysed exact-fingerprint duplicate. A must use
    // its source ownership to bypass that early dedup and finish normally.
    phase = "a-retry";
    await attemptIntakeJob(503);
    expect(storageSpy.createInvoice).toHaveBeenCalledTimes(1);
    expect(docs.get(sourceA.id)).toMatchObject({
      routingState: "routed",
      promotedKind: "invoice",
      promotedId: 909,
      notes: "source A metadata",
    });
    expect((docs.get(sourceA.id).extractedData as Record<string, unknown>).duplicateOfIntakeDocumentId)
      .toBeUndefined();
  });

  it("reuses a standard-upload source owner's stored extraction without re-parsing on retry", async () => {
    const fingerprint = createHash("sha256")
      .update(Buffer.from("%PDF-1.4 fake email attachment"))
      .digest("hex");
    const standardSource = {
      ...INTAKE_DOC,
      contentFingerprint: fingerprint,
      // Standard uploads have no Gmail pre-parse marker. It must not matter
      // after the invoice's guarded persistence has retained its extraction.
      extractedData: { documentType: "unknown" },
      notes: "standard-upload source metadata",
      analysisState: "analyzing",
      routingState: "unrouted",
    };
    savedInvoice = {
      id: 909,
      sourceIntakeDocumentId: standardSource.id,
      devisId: DEVIS.id,
      projectId: DEVIS.projectId,
      contractorId: DEVIS.contractorId,
      invoiceNumber: EMAIL_PARSED.invoiceNumber,
      amountHt: "227000",
      amountTtc: "272400",
      tvaAmount: "45400",
      status: "draft",
      dateIssued: null,
      datePaid: null,
      pdfPath: "mock-key/facture-email.pdf",
      notes: null,
      validationWarnings: [],
      aiExtractedData: { ...EMAIL_PARSED, preParsedFromEmail: undefined },
      aiConfidence: 40,
      extractedIban: null,
      extractedBic: null,
    };
    storageSpy.getProjectIntakeDocument.mockImplementation(async () => standardSource);
    storageSpy.getInvoicesByProject.mockResolvedValue([savedInvoice]);

    await attemptIntakeJob(501);

    expect(parseDocumentMock).not.toHaveBeenCalled();
    expect(storageSpy.createInvoice).not.toHaveBeenCalled();
    expect(storageSpy.createIntakeInvoiceWithProjectDocument).toHaveBeenCalledTimes(1);
    expect(storageSpy.markIntakeJobSucceeded).toHaveBeenCalledTimes(1);
  });
});
