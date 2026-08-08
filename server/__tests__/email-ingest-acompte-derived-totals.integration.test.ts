import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #344 — Integration coverage for the derived-totals draft warning
// through the EMAIL-INGEST processing path, ACOMPTE branch.
//
// Task #342 covered the invoice branch (email-ingest-derived-totals.
// integration.test.ts) and task #343 the quotation branch. The intake
// queue routes documentType "acompte" through the SAME branch as
// "invoice" (server/services/intake/ingest-queue.service.ts,
// case "invoice"/"acompte" → processInvoiceUpload). If that routing ever
// diverged, a €0.00 acompte draft could be persisted silently with no
// warning.
//
// This test drives the REAL intake pipeline (attemptIntakeJob →
// runPipeline → processInvoiceUpload → validateExtraction → persistence)
// with an intake doc whose extractedData is an email-side parse of an
// ACOMPTE where amountHt/amountTtc are both null and line items are
// present, and asserts the persisted row carries:
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
    getInvoicesByProject: vi.fn(async () => []),
    getContractors: vi.fn(async () => [{ id: 11, name: "Acme" }]),
    // Invoice routing
    getProjects: vi.fn(async () => [{ id: 3, name: "Maison Durand" }]),
    getDevisByProjectAndContractor: vi.fn(),
    // processInvoiceUpload persistence
    getDevis: vi.fn(),
    createProjectDocument: vi.fn(async () => ({ id: 1 })),
    createInvoice: vi.fn(async (row: Record<string, unknown>) => ({
      id: 911,
      invoiceNumber: row.invoiceNumber,
      projectId: row.projectId,
    })),
    revokeDevisCheckTokenIfFullyInvoiced: vi.fn(async () => undefined),
    updateDevis: vi.fn(async () => undefined),
  },
}));

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
  devisCode: "DVP0000662",
  projectId: 3,
  contractorId: 11,
  lotId: null,
  acompteRequired: true,
  acompteState: "pending",
};

// Email-side extraction as mirrored by mirrorEmailDocumentToIntake:
// the raw parse plus the preParsedFromEmail marker. Mirrors the
// production incident: line items extracted, both totals null — this
// time as an ACOMPTE (deposit call) document.
const EMAIL_PARSED = {
  preParsedFromEmail: true,
  documentType: "acompte",
  contractorName: "Acme",
  invoiceNumber: "AC-2026-014",
  amountHt: null,
  amountTtc: null,
  tvaAmount: null,
  tvaRate: 20,
  lineItems: [
    { description: "Gros œuvre", total: 100000 },
    { description: "Charpente", total: 77000 },
    { description: "Menuiseries", total: 50000 },
  ],
};

const INTAKE_DOC = {
  id: 44,
  projectId: 3,
  fileName: "acompte-email.pdf",
  storageKey: "intake/3/acompte-email.pdf",
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
    id: 701,
    intakeDocumentId: INTAKE_DOC.id,
    attempts: 0,
  });
  storageSpy.getProjectIntakeDocument.mockResolvedValue(INTAKE_DOC);
  storageSpy.getDevisByProjectAndContractor.mockResolvedValue([DEVIS]);
  storageSpy.getDevis.mockResolvedValue(DEVIS);
});

describe("email-ingest path — derived-totals warning reaches the persisted acompte (Task #344)", () => {
  it("gmail-mirrored acompte parse with null HT/TTC + line items → persisted with amountHt warning, confidence <= 40, derived amounts; no re-parse", async () => {
    await attemptIntakeJob(701);

    // The acompte routed through the invoice branch (not parked /
    // dead-lettered).
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
    //    → intake queue → persistence.
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
    //    TTC = HT × 1.20 from the extracted TVA rate) — NOT €0.00.
    expect(row.amountHt).toBe("227000");
    expect(row.amountTtc).toBe("272400");

    // Both sides were derived, so no missing-pair error blocks the draft.
    expect(row.validationWarnings.some((w) => w.severity === "error")).toBe(false);

    // The intake doc was promoted to the typed record.
    const promotion = storageSpy.updateProjectIntakeDocument.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((u) => u.routingState === "routed");
    expect(promotion).toBeDefined();
    expect(promotion!.promotedKind).toBe("invoice");
    expect(promotion!.promotedId).toBe(911);
  });

  it("TTC-underivable variant (no TVA rate): warning still persisted, TTC defaults to HT — never €0.00", async () => {
    storageSpy.getProjectIntakeDocument.mockResolvedValue({
      ...INTAKE_DOC,
      extractedData: {
        ...EMAIL_PARSED,
        invoiceNumber: "AC-2026-015",
        tvaRate: null,
        lineItems: [
          { description: "Plomberie", total: 1200.5 },
          { description: "Électricité", total: 799.5 },
        ],
      },
    });

    await attemptIntakeJob(701);

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
    // TVA-neutral defaulting: no derivable TTC ⇒ mirror HT.
    expect(row.amountTtc).toBe("2000");
  });
});
