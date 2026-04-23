import { describe, it, expect, vi, beforeEach } from "vitest";

// Storage stub built before importing the module under test (Vitest hoists
// vi.mock calls). We deliberately exercise the real queueDevisCheckBundle
// here — the broader integration test in devis-checks.integration.test.ts
// mocks the whole email-sender module, so it cannot assert body format.
const { state, storageSpy } = vi.hoisted(() => {
  const state = {
    devis: { id: 1, projectId: 1, contractorId: 1, devisNumber: "DVP0000580", devisCode: "DVP0000580" },
    project: { id: 1, name: "Villa Sophia" },
    contractor: { id: 1, name: "Acme Plomberie", email: "acme@example.com" },
  };
  const storageSpy = {
    getDevis: vi.fn(async () => state.devis),
    getProject: vi.fn(async () => state.project),
    getContractor: vi.fn(async () => state.contractor),
    getProjectCommunicationByDedupeKey: vi.fn(async () => undefined),
    createProjectCommunication: vi.fn(async (data: any) => ({ id: 999, ...data })),
  };
  return { state, storageSpy };
});

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../gmail/client", () => ({ getUncachableGmailClient: vi.fn(), isGmailConfigured: () => false }));
vi.mock("../storage/object-storage", () => ({ getDocumentBuffer: vi.fn() }));
vi.mock("./certificat-generator", () => ({ generateCertificatPdf: vi.fn(), buildCertificatEmailBody: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); });

describe("formatCheckHead — French head line for bundled devis-check email (Task #110)", () => {
  it("renders Ligne {n} — {description} ({amount} € HT) for line-scoped checks", async () => {
    const { formatCheckHead } = await import("../communications/email-sender");
    const result = formatCheckHead({
      lineDescription: "Fourniture et pose chaudière à condensation",
      lineNumber: 4,
      totalHt: "18500.00",
    });
    // Node's Intl fr-FR uses U+202F (NARROW NO-BREAK SPACE) as the thousands
    // separator, not a regular space. Match either flavour so this stays
    // robust across ICU revisions.
    expect(result).toMatch(/^Ligne 4 — Fourniture et pose chaudière à condensation \(18[\u202F\u00A0\s]500,00 € HT\)$/);
  });

  it("falls back to 'Question générale' when there is no line context", async () => {
    const { formatCheckHead } = await import("../communications/email-sender");
    expect(formatCheckHead({ lineDescription: null, lineNumber: null, totalHt: null }))
      .toBe("Question générale");
  });

  it("omits the HT amount tail when totalHt is missing or non-numeric", async () => {
    const { formatCheckHead } = await import("../communications/email-sender");
    expect(formatCheckHead({ lineDescription: "Carrelage", lineNumber: 2, totalHt: null }))
      .toBe("Ligne 2 — Carrelage");
    expect(formatCheckHead({ lineDescription: "Carrelage", lineNumber: 2, totalHt: "n/a" }))
      .toBe("Ligne 2 — Carrelage");
  });
});

describe("queueDevisCheckBundle — full email body composition (Task #110)", () => {
  it("renders a mixed bundle (line-scoped + general) with the correct French formatting and persists the body", async () => {
    const { queueDevisCheckBundle } = await import("../communications/email-sender");
    const result = await queueDevisCheckBundle({
      devisId: 1,
      portalUrl: "https://example.test/p/check/abc123",
      dedupeKey: "devis-check-bundle:1:m0:1,2,3",
      checkSummaries: [
        {
          query: "Pourquoi 18 500 € HT pour cette ligne ?",
          lineDescription: "Fourniture et pose chaudière",
          lineNumber: 4,
          totalHt: "18500.00",
        },
        {
          query: "Quel est le délai de livraison ?",
          lineDescription: null,
          lineNumber: null,
          totalHt: null,
        },
        {
          query: "La marque est-elle équivalente ?",
          lineDescription: "Robinetterie cuisine",
          lineNumber: 7,
          totalHt: "320.50",
        },
      ],
    });

    expect(result.refreshedSubject).toBe("Questions sur le devis DVP0000580 — Villa Sophia");
    const body = result.refreshedBody;
    // Each item carries the cross-reference prefix (line number + amount) so
    // the contractor can locate the question on their devis PDF.
    expect(body).toMatch(/Ligne 4 — Fourniture et pose chaudière \(18[\u202F\u00A0\s]500,00 € HT\)/);
    expect(body).toContain("   → Pourquoi 18 500 € HT pour cette ligne ?");
    // General questions remain unprefixed.
    expect(body).toContain("Question générale");
    expect(body).toContain("   → Quel est le délai de livraison ?");
    // Second line-scoped item with a smaller amount.
    expect(body).toContain("Ligne 7 — Robinetterie cuisine (320,50 € HT)");
    // Sequential indices are gone — the contractor sees devis line numbers,
    // not bundle order.
    expect(body).not.toMatch(/^1\. /m);
    expect(body).not.toMatch(/^2\. /m);
    // Devis ref + project still present in the intro.
    expect(body).toContain("votre devis DVP0000580");
    expect(body).toContain("« Villa Sophia »");
    // Portal URL block intact.
    expect(body).toContain("https://example.test/p/check/abc123");

    // The composed body is what gets persisted on the queued comm row.
    const created = (storageSpy.createProjectCommunication.mock.calls[0]?.[0] ?? {}) as { body?: string };
    expect(created.body).toBe(body);
  });
});
