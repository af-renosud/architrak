import { describe, it, expect, vi } from "vitest";

// Task #267 — regression guard for the English client-facing copy that
// Task #266 introduced. The client portal shell, the certificat client
// email, and the Pennylane fee invoice email are all read by Renosud's
// clients (not contractors), so they must stay in English. This test
// renders each surface and asserts:
//
//   1) key English strings are present ("Approval recorded",
//      "Rejection recorded", the expired-link message, "Dear Client,").
//   2) no French markers ("enregistré", "Veuillez", …) sneak back in.
//
// The contractor portal (server/routes/public-checks.ts) is explicitly
// NOT covered — it stays French by design (see replit.md user prefs).

vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../services/client-checks", () => ({
  hashToken: (s: string) => s,
  resolveClientCheckToken: vi.fn(),
  computeTokenExpiry: () => new Date(),
}));
vi.mock("../storage/object-storage", () => ({
  getDocumentStream: vi.fn(),
  getDocumentBuffer: vi.fn(),
  uploadDocument: vi.fn(),
  uploadDocumentAtKey: vi.fn(),
  buildPennylaneInvoiceObjectName: vi.fn(),
}));
vi.mock("../services/docraptor", () => ({ convertHtmlToPdf: vi.fn() }));
vi.mock("../services/drive/upload-queue.service", () => ({ enqueueDriveUpload: vi.fn() }));
vi.mock("../services/pennylane/client", () => ({
  isPennylaneConfigured: () => false,
  isPennylaneDryRun: () => false,
  isPennylanePushEnabled: () => false,
  isProjectWhitelisted: () => false,
  iteratePages: vi.fn(),
  PennylaneApiError: class extends Error {},
  pennylaneRequest: vi.fn(),
}));
vi.mock("../gmail/client", () => ({
  getUncachableGmailClient: vi.fn(),
  isGmailConfigured: () => false,
}));

import type { Certificat, Project, Contractor, FeeEntry } from "@shared/schema";

/**
 * French words/fragments that appeared in the pre-Task-#266 copy, plus
 * common French connective words that are very unlikely to appear in
 * intentional English copy. French *domain* terms (Devis, Certificat,
 * Honoraires, TTC, …) are allowed per the user preferences, so they are
 * deliberately NOT in this list.
 */
const FRENCH_MARKERS = [
  "enregistré",
  "enregistrée",
  "Veuillez",
  "veuillez",
  "Merci de",
  "Cordialement",
  "Bonjour",
  "Cher client",
  "Chère cliente",
  "ci-joint",
  "expiré",
  "n'hésitez pas",
] as const;

function expectNoFrenchMarkers(text: string, surface: string) {
  for (const marker of FRENCH_MARKERS) {
    expect(text, `${surface} must not contain French marker "${marker}"`).not.toContain(marker);
  }
}

describe("client portal shell (public-client-checks) stays English", () => {
  it("live shell carries the English verdict + expired-link copy and no French markers", async () => {
    const { renderClientPortalShell } = await import("../routes/public-client-checks");
    const html = renderClientPortalShell({ mode: "live", token: "tok-english-check" });

    // Key verdict confirmations shown after the client acts.
    expect(html).toContain("Approval recorded");
    expect(html).toContain("Rejection recorded");
    // Expired-link message rendered when the token has lapsed.
    expect(html).toContain("This link has expired. Please contact your Renosud representative.");
    // The shell declares itself as English.
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Client portal — Renosud");

    expectNoFrenchMarkers(html, "client portal shell (live)");
  });

  it("architect preview shell uses the same English copy", async () => {
    const { renderClientPortalShell } = await import("../routes/public-client-checks");
    const html = renderClientPortalShell({ mode: "preview", devisId: 42 });

    expect(html).toContain("Approval recorded");
    expect(html).toContain("Rejection recorded");
    expect(html).toContain("Architect preview — actions will not be sent.");

    expectNoFrenchMarkers(html, "client portal shell (preview)");
  });
});

describe("certificat client email body stays English", () => {
  it("addresses the client in English with no French markers", async () => {
    const { buildCertificatEmailBody } = await import("../communications/certificat-generator");
    const body = buildCertificatEmailBody({
      certificat: {
        certificateRef: "CERT-2026-001",
        netToPayTtc: "12345.67",
      } as unknown as Certificat,
      project: { name: "Villa Test", code: "VT-01" } as unknown as Project,
      contractor: { name: "Test Contractor SARL" } as unknown as Contractor,
    });

    expect(body).toContain("Dear Client,");
    expect(body).toContain("Please find attached Certificat de Paiement no. CERT-2026-001");
    expect(body).toContain('project "Villa Test" (VT-01)');
    expect(body).toContain("Test Contractor SARL");
    expect(body).toContain("Kind regards,");

    expectNoFrenchMarkers(body, "certificat client email body");
  });
});

describe("Pennylane fee invoice email body stays English", () => {
  it("greets a named contact in English with no French markers", async () => {
    const { buildClientEmailBody } = await import("../services/pennylane/push-queue.service");
    const body = buildClientEmailBody(
      { name: "Villa Test", code: "VT-01", clientContactName: "Jane Doe" } as unknown as Project,
      { feeAmount: "1500.5" } as unknown as FeeEntry,
    );

    expect(body).toContain("Dear Jane Doe,");
    expect(body).toContain("architect's fee invoice (Honoraires)");
    expect(body).toContain('project "Villa Test" (VT-01)');
    expect(body).toContain("Amount: 1500.50 € HT");
    expect(body).toContain("Kind regards,");

    expectNoFrenchMarkers(body, "Pennylane fee invoice email (named contact)");
  });

  it("falls back to the English generic greeting when no contact name exists", async () => {
    const { buildClientEmailBody } = await import("../services/pennylane/push-queue.service");
    const body = buildClientEmailBody(
      { name: "Villa Test", code: "VT-01", clientContactName: null } as unknown as Project,
      { feeAmount: "200" } as unknown as FeeEntry,
    );

    expect(body).toContain("Dear Client,");
    expectNoFrenchMarkers(body, "Pennylane fee invoice email (generic greeting)");
  });
});
