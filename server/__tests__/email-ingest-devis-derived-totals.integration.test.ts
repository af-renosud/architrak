import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #343 — Integration coverage for the derived-totals draft warning
// through the EMAIL-INGEST processing path, QUOTATION branch.
//
// Task #342 covered the invoice branch (email-ingest-derived-totals.
// integration.test.ts). The intake queue routes quotations through the
// same pre-parsed hand-off into processDevisUpload
// (server/services/intake/ingest-queue.service.ts, "quotation" branch).
// A regression there could still persist a €0.00 devis draft silently.
//
// This test drives the REAL intake pipeline (attemptIntakeJob →
// runPipeline → processDevisUpload → validateExtraction → persistence)
// with an intake doc whose extractedData is an email-side parse of a
// quotation where amountHt/amountTtc are both null and line items are
// present, and asserts the persisted devis row carries:
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
    // processDevisUpload internals
    getProjects: vi.fn(async () => [{ id: 3, name: "Maison Durand" }]),
    createProjectDocument: vi.fn(async () => ({ id: 1 })),
    createDevis: vi.fn(async (row: Record<string, unknown>) => ({
      id: 707,
      projectId: row.projectId,
      lotId: row.lotId ?? null,
      devisCode: row.devisCode,
    })),
    createDevisLineItem: vi.fn(async () => ({ id: 1 })),
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
vi.mock("../services/devis-translation", () => ({
  triggerDevisTranslation: vi.fn(() => undefined),
}));
vi.mock("../services/lot-reference-validator", () => ({
  checkLotReferencesAgainstCatalog: vi.fn(async () => []),
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
    matchToProject: vi.fn(async () => ({
      projectId: 3,
      contractorId: 11,
      confidence: 90,
      matchedFields: ["contractorName"],
      warnings: [],
    })),
  };
});

import { attemptIntakeJob } from "../services/intake/ingest-queue.service";
import { parseDocument } from "../gmail/document-parser";

const parseDocumentMock = parseDocument as unknown as ReturnType<typeof vi.fn>;

// Email-side extraction as mirrored by mirrorEmailDocumentToIntake:
// the raw parse plus the preParsedFromEmail marker. Mirrors the
// production incident: line items extracted, both totals null.
const EMAIL_PARSED = {
  preParsedFromEmail: true,
  documentType: "quotation",
  contractorName: "Acme",
  reference: "DEV-2026-042",
  devisNumber: "DEV-2026-042",
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
  id: 43,
  projectId: 3,
  fileName: "devis-email.pdf",
  storageKey: "intake/3/devis-email.pdf",
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
    id: 601,
    intakeDocumentId: INTAKE_DOC.id,
    attempts: 0,
  });
  storageSpy.getProjectIntakeDocument.mockResolvedValue(INTAKE_DOC);
});

describe("email-ingest path — derived-totals warning reaches the persisted devis (Task #343)", () => {
  it("gmail-mirrored quotation parse with null HT/TTC + line items → devis persisted with amountHt warning, confidence <= 40, derived amounts; no re-parse", async () => {
    await attemptIntakeJob(601);

    // The pipeline routed to a devis (not parked / dead-lettered).
    expect(storageSpy.markIntakeJobSucceeded).toHaveBeenCalledTimes(1);
    expect(storageSpy.markIntakeJobDeadLettered).not.toHaveBeenCalled();
    expect(storageSpy.createDevis).toHaveBeenCalledTimes(1);

    // The email-side extraction was REUSED — Gemini never re-invoked.
    expect(parseDocumentMock).not.toHaveBeenCalled();

    const row = storageSpy.createDevis.mock.calls[0][0] as {
      projectId: number;
      contractorId: number;
      status: string;
      validationWarnings: WarningShape[];
      aiConfidence: number;
      amountHt: string;
      amountTtc: string;
    };

    expect(row.projectId).toBe(3);
    expect(row.contractorId).toBe(11);
    expect(row.status).toBe("draft");

    // 1. The derived-totals warning survived email parse → intake mirror
    //    → intake queue → devis persistence.
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

    // The intake doc was promoted to the typed devis.
    const promotion = storageSpy.updateProjectIntakeDocument.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((u) => u.routingState === "routed");
    expect(promotion).toBeDefined();
    expect(promotion!.promotedKind).toBe("devis");
    expect(promotion!.promotedId).toBe(707);

    // Line items reached the devis-line persistence too.
    expect(storageSpy.createDevisLineItem).toHaveBeenCalledTimes(3);
  });

  it("TTC-underivable variant (no TVA rate): warning still persisted, TTC defaults to HT — never €0.00", async () => {
    storageSpy.getProjectIntakeDocument.mockResolvedValue({
      ...INTAKE_DOC,
      extractedData: {
        ...EMAIL_PARSED,
        reference: "DEV-2026-043",
        devisNumber: "DEV-2026-043",
        tvaRate: null,
        lineItems: [
          { description: "Plomberie", total: 1200.5 },
          { description: "Électricité", total: 799.5 },
        ],
      },
    });

    await attemptIntakeJob(601);

    expect(parseDocumentMock).not.toHaveBeenCalled();
    expect(storageSpy.createDevis).toHaveBeenCalledTimes(1);
    const row = storageSpy.createDevis.mock.calls[0][0] as {
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
